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
  /// Not connected: never connected, disconnected, unreachable, or dropped. Retries (if any) run
  /// silently in the background, without passing through `connecting`.
  case offline
  /// The first attempt after `connect`.
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

/// Owns the connection to the bridge and publishes what it syncs: `state`, the live `sessions`,
/// and the `transcript` of the session on show.
///
/// All of it is pushed as the socket progresses (observe it with SwiftUI or
/// `withObservationTracking`); callers never poll. `connect` replaces any existing connection.
/// Once connected, a dropped or unreachable socket is retried with exponential backoff; only a
/// refusal by the bridge (`failed`) or `disconnect` ends the attempts. The session on show
/// (`show`) is joined whenever connected, resuming from the transcript's replay cursor.
///
/// Commands are async: they return once the bridge has answered and throw its `ProtocolError`,
/// or `CommandError` if the connection is not usable. Their effects show up in `transcript`
/// through the events the bridge streams, never through the return value.
@Observable
final class BridgeClient {
  private(set) var state = ConnectionState.offline
  /// The live pi sessions, most recently active first; nil until the bridge has listed them.
  private(set) var sessions: [LiveSession]?
  /// Everything synced from the session on show; kept across reconnects to the same bridge.
  private(set) var transcript = Transcript()
  /// Why the session on show could not be joined; nil while it is joined or being joined.
  private(set) var showFailure: String?

  /// Why a command could not be answered.
  enum CommandError: LocalizedError, Equatable {
    /// Not `connected`, or the socket ended before the bridge answered.
    case notConnected

    var errorDescription: String? { "Not connected to the bridge." }
  }

  @ObservationIgnored private var connection: Task<Void, Never>?
  /// The socket of the live connection; nil between connections.
  @ObservationIgnored private var socket: URLSessionWebSocketTask?
  /// Commands sent on `socket` still waiting for their `result` record, by command id.
  @ObservationIgnored private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
  @ObservationIgnored private var nextCommandId = 1
  @ObservationIgnored private var config: BridgeConfig?
  /// The session the user has open, joined whenever connected.
  @ObservationIgnored private var shownId: String?
  /// The session this connection joined or is joining; nil on a fresh connection.
  @ObservationIgnored private var joinedId: String?
  @ObservationIgnored private let reconnectDelay: Duration

  private static let maxReconnectDelay = Duration.seconds(30)

  /// `reconnectDelay` is the wait before the first retry; it doubles per failed attempt.
  init(reconnectDelay: Duration = .seconds(1)) {
    self.reconnectDelay = reconnectDelay
  }

  func connect(to config: BridgeConfig) {
    connection?.cancel()
    failPending()
    // What was synced belongs to one bridge; never replay another's cursor.
    if config != self.config {
      transcript = Transcript()
      sessions = nil
    }
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

  /// Puts the live session `id` on show: once connected, its snapshot replaces `transcript`, then
  /// it streams. Showing the session already on show again resumes from the replay cursor. If the
  /// bridge no longer knows the session, the transcript is marked ended; other failures to join
  /// land in `showFailure`.
  func show(sessionId id: String) {
    shownId = id
    joinShownSession()
  }

  /// Sends `text` to the agent: it starts a run when idle, else is delivered as `mode` says.
  func send(_ text: String, mode: PromptMode = .steer) async throws {
    try await command("prompt", ["text": .string(text), "mode": .string(mode.rawValue)])
  }

  /// Stops the active run; its transcript then shows it as aborted.
  func abort() async throws {
    try await command("abort")
  }

  /// The session's skills, invoked by sending `/skill:<name>`.
  func skills() async throws -> [Skill] {
    try BridgeProtocol.result([Skill].self, field: .skills, from: await command("listSkills"))
  }

  /// The models the session can switch to; the active one is `transcript.status.model`.
  func models() async throws -> [ModelInfo] {
    try BridgeProtocol.result([ModelInfo].self, field: .models, from: await command("listModels"))
  }

  /// Switches the session to `model`; `transcript.status` follows once pi has.
  func setModel(_ model: ModelInfo) async throws {
    try await command("setModel", ["provider": .string(model.provider), "id": .string(model.id)])
  }

  /// Sets how hard the model thinks, one of `transcript.status.thinkingLevels`; the status follows.
  func setThinkingLevel(_ level: String) async throws {
    try await command("setThinkingLevel", ["level": .string(level)])
  }

  /// Workspace files matching `query` (prefix or fuzzy), best first, as paths relative to the
  /// session's working directory.
  func searchFiles(_ query: String) async throws -> [String] {
    try BridgeProtocol.result(
      [String].self, field: .files, from: await command("searchFiles", ["query": .string(query)]))
  }

  /// Joins the session on show, unless this connection already has (and it has not ended since).
  private func joinShownSession() {
    guard state == .connected, let id = shownId, id != joinedId || transcript.hasEnded else { return }
    joinedId = id
    showFailure = nil
    Task {
      do {
        try await join(sessionId: id)
      } catch {
        if joinedId == id { joinedId = nil }
        showFailure = error.localizedDescription
      }
    }
  }

  private func join(sessionId id: String) async throws {
    var params: [String: JSONValue] = ["id": .string(id)]
    if id == transcript.sessionId, let epoch = transcript.epoch {
      params["lastSeq"] = .number(Double(transcript.lastSeq))
      params["epoch"] = .string(epoch)
    }
    do {
      // Its catch-up may be applied before this resumes; the epoch only matters on the next join.
      let joined = try await command("joinSession", params)
      transcript.epoch = try BridgeProtocol.result(String.self, field: .epoch, from: joined)
    } catch let error as ProtocolError where error.code == "unknownSession" && id == transcript.sessionId {
      transcript.markEnded()
      throw error
    }
  }

  /// Sends a command; returns its `result` record, for `BridgeProtocol.result` to decode.
  @discardableResult
  private func command(_ name: String, _ params: [String: JSONValue] = [:]) async throws -> Data {
    guard state == .connected, let socket else { throw CommandError.notConnected }
    let id = takeCommandId()
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

  private func takeCommandId() -> Int {
    defer { nextCommandId += 1 }
    return nextCommandId
  }

  private func failPending() {
    for continuation in pending.values { continuation.resume(throwing: CommandError.notConnected) }
    pending.removeAll()
  }

  /// Keeps a socket open until the bridge refuses us or the task is cancelled.
  /// A cancelled run (superseded or disconnected) never touches `state`.
  private func superviseConnection(to config: BridgeConfig) async {
    var delay = reconnectDelay
    while !Task.isCancelled {
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
    nextCommandId = 1
    joinedId = nil
    defer {
      socket.cancel(with: .goingAway, reason: nil)
      // A superseding connection may already own `socket` and `pending`.
      if self.socket === socket {
        self.socket = nil
        failPending()
      }
    }

    let helloId = takeCommandId()
    var wasConnected = false
    do {
      try await socket.send(.string(BridgeProtocol.helloFrame(id: helloId)))
      while true {
        guard case .string(let frame) = try await socket.receive() else { continue }
        for record in try BridgeProtocol.records(in: frame) {
          guard !Task.isCancelled else { return .dropped(wasConnected: wasConnected) }
          switch record {
          case .event(let seq, let event): transcript.apply(event, seq: seq)
          case .sessions(let sessions): self.sessions = sessions
          case .result(helloId, let outcome):
            state = Self.handshakeState(outcome)
            if case .failed = state { return .refused }
            wasConnected = true
            joinShownSession()  // back to where we left it, catching up from the cursor
          case .result(let id, let outcome):
            pending.removeValue(forKey: id)?.resume(with: outcome.mapError { $0 })
          case .error(let error):
            state = .failed(error)
            return .refused
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

  /// `connected` if the bridge acknowledged our `hello` with our version, else why not.
  private static func handshakeState(_ outcome: Result<Data, ProtocolError>) -> ConnectionState {
    switch outcome {
    case .failure(let error): return .failed(error)
    case .success(let json):
      let version = try? BridgeProtocol.result(Int.self, field: .protocolVersion, from: json)
      guard version == BridgeProtocol.version else {
        return .failed(
          ProtocolError(
            code: "versionMismatch",
            message: "bridge acknowledged protocol version \(version.map(String.init) ?? "none"), app speaks \(BridgeProtocol.version)"
          ))
      }
      return .connected
    }
  }
}
