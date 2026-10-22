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

/// Owns one connection to the bridge at a time and publishes its `state`.
///
/// `state` is pushed by the client as the socket progresses (observe it with SwiftUI or
/// `withObservationTracking`); callers never poll. `connect` replaces any existing connection.
@MainActor @Observable
final class BridgeClient {
  private(set) var state = ConnectionState.offline

  @ObservationIgnored private var connection: Task<Void, Never>?

  func connect(to config: BridgeConfig) {
    connection?.cancel()
    state = .connecting
    connection = Task { await run(config) }
  }

  func disconnect() {
    connection?.cancel()
    connection = nil
    state = .offline
  }

  /// Lifetime of one socket. A cancelled run (superseded or disconnected) never touches `state`.
  private func run(_ config: BridgeConfig) async {
    var request = URLRequest(url: config.url)
    request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
    let socket = URLSession.shared.webSocketTask(with: request)
    socket.resume()
    defer { socket.cancel(with: .goingAway, reason: nil) }

    let helloId = 1
    do {
      try await socket.send(.string(BridgeProtocol.helloFrame(id: helloId, lastSeq: 0)))
      while true {
        guard case .string(let frame) = try await socket.receive() else { continue }
        for record in try BridgeProtocol.records(in: frame) {
          if let next = Self.transition(on: record, helloId: helloId) {
            guard !Task.isCancelled else { return }
            state = next
            if case .failed = next { return }
          }
        }
      }
    } catch {
      guard !Task.isCancelled else { return }
      // A rejected upgrade surfaces as a transport error; the HTTP status tells us why.
      if (socket.response as? HTTPURLResponse)?.statusCode == 401 {
        state = .failed(ProtocolError(code: "unauthorized", message: "the bridge rejected the token"))
      } else {
        state = .offline
      }
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
