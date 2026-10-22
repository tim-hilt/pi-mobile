import Foundation
import Observation

/// Where and how to reach the bridge. Configured once, then persisted by `ConnectionStore`.
struct BridgeConfig: Codable, Equatable, Sendable {
  /// `ws://` or `wss://` address of the bridge.
  let url: URL
  /// Bearer token the bridge requires.
  let token: String
}

enum ConnectionState: Equatable, Sendable {
  /// Not connected: never connected, disconnected, unreachable, or dropped.
  case offline
  case connecting
  /// Authenticated and protocol version agreed.
  case connected
  /// The bridge refused us; the error says why (`unauthorized`, `versionMismatch`, ...).
  /// Retrying with the same config will not help.
  case failed(ProtocolError)
}

/// How a prompt sent during a run reaches the agent. Ignored by the bridge when no run is active.
enum PromptMode: String, Sendable {
  /// After the current assistant turn and its tool calls.
  case steer
  /// After the run has finished its pending work.
  case followUp
}

/// Owns the connection to the bridge and publishes its `state` and the synced `transcript`.
///
/// Both are pushed by the client as the socket progresses (observe them with SwiftUI or
/// `withObservationTracking`); callers never poll. `connect` replaces any existing connection.
/// Once connected, a dropped or unreachable socket is retried with exponential backoff, resuming
/// from the transcript's replay cursor; only a refusal by the bridge (`failed`) or `disconnect`
/// ends the attempts.
///
/// Commands (`send`, `abort`, `clearQueue`, `skills`, `searchFiles`) are async: they return once the bridge has answered
/// and throw its `ProtocolError`, or `CommandError` if the connection is not usable. Their effects
/// show up in `transcript` through the events the bridge streams, never through the return value.
@MainActor @Observable
final class BridgeClient {
  private(set) var state = ConnectionState.offline
  /// Everything synced from the bridge so far; kept across reconnects to the same bridge.
  private(set) var transcript = Transcript()

  /// Why a command could not be answered.
  enum CommandError: Error, Equatable {
    /// Not `connected`, or the socket ended before the bridge answered.
    case notConnected
  }

  @ObservationIgnored private var connection: Task<Void, Never>?
  /// The socket of the live connection; nil between connections.
  @ObservationIgnored private var socket: URLSessionWebSocketTask?
  /// Commands sent on `socket` still waiting for their `result`, by command id.
  @ObservationIgnored private var pending: [Int: CheckedContinuation<Record.CommandResult, Error>] = [:]
  @ObservationIgnored private var nextCommandId = 2
  @ObservationIgnored private var config: BridgeConfig?
  @ObservationIgnored private let reconnectDelay: Duration

  private static let maxReconnectDelay = Duration.seconds(30)

  /// `reconnectDelay` is the wait before the first retry; it doubles per failed attempt.
  init(reconnectDelay: Duration = .seconds(1)) {
    self.reconnectDelay = reconnectDelay
  }

  func connect(to config: BridgeConfig) {
    connection?.cancel()
    failPending()
    // A transcript and its cursor belong to one bridge; never replay another's.
    if config != self.config { transcript = Transcript() }
    self.config = config
    state = .connecting
    connection = Task { await superviseConnection(to: config) }
  }

  func disconnect() {
    connection?.cancel()
    connection = nil
    failPending()
    state = .offline
  }

  /// Sends `text` to the agent: it starts a run when idle, else is delivered as `mode` says.
  func send(_ text: String, mode: PromptMode = .steer) async throws {
    _ = try await command("prompt", ["text": .string(text), "mode": .string(mode.rawValue)])
  }

  /// Stops the active run; its transcript then shows it as aborted.
  func abort() async throws {
    _ = try await command("abort")
  }

  /// Drops every queued message and returns what was dropped, e.g. to put back in the composer.
  func clearQueue() async throws -> Transcript.Queue {
    let result = try await command("clearQueue")
    return Transcript.Queue(steering: result.steering ?? [], followUp: result.followUp ?? [])
  }

  /// The session's skills, invoked by sending `/skill:<name>`.
  func skills() async throws -> [Skill] {
    try await command("listSkills").skills ?? []
  }

  /// Workspace files matching `query` (prefix or fuzzy), best first, as paths relative to the
  /// session's working directory.
  func searchFiles(_ query: String) async throws -> [String] {
    try await command("searchFiles", ["query": .string(query)]).files ?? []
  }

  private func command(_ name: String, _ params: [String: JSONValue] = [:]) async throws -> Record.CommandResult {
    guard state == .connected, let socket else { throw CommandError.notConnected }
    let id = nextCommandId
    nextCommandId += 1
    let frame = BridgeProtocol.commandFrame(id: id, name: name, params: params)
    return try await withCheckedThrowingContinuation { continuation in
      pending[id] = continuation
      // The completion form enqueues synchronously, so commands reach the bridge in call order.
      socket.send(.string(frame)) { error in
        guard let error else { return }
        Task { @MainActor in self.pending.removeValue(forKey: id)?.resume(throwing: error) }
      }
    }
  }

  private func failPending() {
    for continuation in pending.values { continuation.resume(throwing: CommandError.notConnected) }
    pending.removeAll()
  }

  /// Completes the command a `result` record answers.
  private func resolve(_ record: Record) {
    guard record.type == "result", let id = record.id, let continuation = pending.removeValue(forKey: id) else { return }
    if let error = record.error {
      continuation.resume(throwing: error)
    } else {
      continuation.resume(returning: record.result ?? Record.CommandResult())
    }
  }

  /// Keeps a socket open until the bridge refuses us or the task is cancelled.
  /// A cancelled run (superseded or disconnected) never touches `state`.
  private func superviseConnection(to config: BridgeConfig) async {
    var delay = reconnectDelay
    while !Task.isCancelled {
      state = .connecting
      let outcome = await runSocket(config)
      guard !Task.isCancelled, case .dropped(let wasConnected) = outcome else { return }
      state = .offline
      try? await Task.sleep(for: delay)
      delay = wasConnected ? reconnectDelay : min(delay * 2, Self.maxReconnectDelay)
    }
  }

  private enum SocketOutcome {
    /// The bridge refused us (`state` is already `failed`); retrying cannot help.
    case refused
    /// The socket ended or never opened; `wasConnected` is whether the handshake had succeeded.
    case dropped(wasConnected: Bool)
  }

  /// Lifetime of one socket: handshake, then apply every record until it ends.
  private func runSocket(_ config: BridgeConfig) async -> SocketOutcome {
    var request = URLRequest(url: config.url)
    request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
    let socket = URLSession.shared.webSocketTask(with: request)
    socket.resume()
    self.socket = socket
    nextCommandId = 2
    defer {
      socket.cancel(with: .goingAway, reason: nil)
      // A superseding connection may already own `socket` and `pending`.
      if self.socket === socket {
        self.socket = nil
        failPending()
      }
    }

    let helloId = 1
    var wasConnected = false
    do {
      try await socket.send(
        .string(BridgeProtocol.helloFrame(id: helloId, lastSeq: transcript.lastSeq)))
      while true {
        guard case .string(let frame) = try await socket.receive() else { continue }
        for record in try BridgeProtocol.records(in: frame) {
          guard !Task.isCancelled else { return .dropped(wasConnected: wasConnected) }
          transcript.apply(record)
          resolve(record)
          if let next = Self.transition(on: record, helloId: helloId) {
            state = next
            if case .failed = next { return .refused }
            wasConnected = true
          }
        }
      }
    } catch {
      guard !Task.isCancelled else { return .dropped(wasConnected: wasConnected) }
      // A rejected upgrade surfaces as a transport error; the HTTP status tells us why.
      if (socket.response as? HTTPURLResponse)?.statusCode == 401 {
        state = .failed(ProtocolError(code: "unauthorized", message: "the bridge rejected the token"))
        return .refused
      }
      return .dropped(wasConnected: wasConnected)
    }
  }

  /// The state a record moves the connection to, or nil if it does not affect it.
  private static func transition(on record: Record, helloId: Int) -> ConnectionState? {
    switch record.type {
    case "error":
      return record.error.map { .failed($0) }
    case "result" where record.id == helloId:
      if let error = record.error { return .failed(error) }
      guard record.result?.protocolVersion == BridgeProtocol.version else {
        return .failed(
          ProtocolError(
            code: "versionMismatch",
            message: "bridge acknowledged protocol version \(record.result?.protocolVersion.map(String.init) ?? "none"), app speaks \(BridgeProtocol.version)"
          ))
      }
      return .connected
    default:
      return nil
    }
  }
}
