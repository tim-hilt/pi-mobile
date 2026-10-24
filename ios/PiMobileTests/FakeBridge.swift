import CryptoKit
import Foundation
import Network

/// In-process WebSocket server standing in for the bridge. It authenticates the
/// upgrade like the real bridge (HTTP 401 on a wrong token) and hands every
/// received text frame to a script that replies with real protocol frames.
/// With no token it accepts any client, like a public ntfy server, and `onConnect`
/// lets it speak first.
///
/// Speaks RFC 6455 by hand over TCP: Network.framework's WebSocket server cannot
/// answer an upgrade with a plain 401.
final class FakeBridge: @unchecked Sendable {
  /// One accepted client connection, handed to the script.
  struct Peer: @unchecked Sendable {
    fileprivate let connection: NWConnection

    func send(_ frame: String) { write(opcode: 0x1, payload: Data(frame.utf8)) }

    /// Sends a WebSocket close frame with `code` (default 1000).
    func close(code: UInt16 = 1000) {
      write(opcode: 0x8, payload: Data([UInt8(code >> 8), UInt8(code & 0xFF)]))
    }

    /// Kills the TCP connection without a close handshake.
    func drop() { connection.cancel() }

    fileprivate func write(opcode: UInt8, payload: Data) {
      precondition(payload.count < 65536, "fake bridge only sends frames up to 64 KiB")
      let length =
        payload.count < 126
        ? Data([UInt8(payload.count)])
        : Data([126, UInt8(payload.count >> 8), UInt8(payload.count & 0xFF)])
      connection.send(
        content: Data([0x80 | opcode]) + length + payload, completion: .idempotent)
    }
  }

  typealias Script = @Sendable (_ frame: String, _ peer: Peer) -> Void

  private let listener: NWListener
  private let queue = DispatchQueue(label: "FakeBridge")
  private(set) var url: URL

  /// Starts on a free localhost port; returns once it is listening.
  /// `onConnect` runs for every client that completes the upgrade.
  init(
    token: String?, script: @escaping Script,
    onConnect: (@Sendable (Peer) -> Void)? = nil
  ) async throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
    url = URL(string: "ws://127.0.0.1")!

    listener.newConnectionHandler = { [queue] connection in
      connection.start(queue: queue)
      Self.upgrade(connection, token: token, script: script, onConnect: onConnect)
    }
    let port: NWEndpoint.Port = try await withCheckedThrowingContinuation { continuation in
      listener.stateUpdateHandler = { [listener] state in
        switch state {
        case .ready: continuation.resume(returning: listener.port!)
        case .failed(let error): continuation.resume(throwing: error)
        default: break
        }
      }
      listener.start(queue: queue)
    }
    url = URL(string: "ws://127.0.0.1:\(port.rawValue)")!
  }

  func stop() { listener.cancel() }

  // MARK: HTTP upgrade

  private static func upgrade(
    _ connection: NWConnection, token: String?, script: @escaping Script,
    onConnect: (@Sendable (Peer) -> Void)?
  ) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, _, _ in
      guard let data, let request = String(data: data, encoding: .utf8) else { return connection.cancel() }
      let headers = Dictionary(
        request.components(separatedBy: "\r\n").dropFirst().compactMap { line -> (String, String)? in
          guard let colon = line.firstIndex(of: ":") else { return nil }
          return (
            line[..<colon].lowercased(),
            line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
          )
        }, uniquingKeysWith: { $1 })

      guard token.map({ headers["authorization"] == "Bearer \($0)" }) ?? true, let key = headers["sec-websocket-key"] else {
        connection.send(
          content: Data("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".utf8),
          completion: .contentProcessed { _ in connection.cancel() })
        return
      }
      let accept = Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8)))
        .base64EncodedString()
      connection.send(
        content: Data(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n"
            .utf8),
        completion: .contentProcessed { _ in
          onConnect?(Peer(connection: connection))
          receiveFrames(on: connection, script: script)
        })
    }
  }

  // MARK: Frames (client → server, always masked, payload < 126 bytes)

  private static func receiveFrames(on connection: NWConnection, script: @escaping Script) {
    connection.receive(minimumIncompleteLength: 2, maximumLength: 8192) { data, _, _, error in
      guard let data, error == nil, data.count >= 6 else { return }
      let bytes = [UInt8](data)
      let length = Int(bytes[1] & 0x7F)
      let mask = bytes[2..<6]
      let payload = Data(bytes[6..<min(bytes.count, 6 + length)].enumerated().map { $1 ^ mask[2 + $0 % 4] })
      switch bytes[0] & 0x0F {
      case 0x1:
        if let text = String(data: payload, encoding: .utf8) { script(text, Peer(connection: connection)) }
      case 0x8:
        return connection.cancel()
      default: break
      }
      receiveFrames(on: connection, script: script)
    }
  }
}
