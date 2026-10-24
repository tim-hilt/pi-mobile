import Foundation
import Testing

@testable import PiMobile

private let ack = #"{"type":"result","id":1,"result":{"protocolVersion":2}}"# + "\n"

/// Waits until `client.state` satisfies `predicate`, failing the test after 5 s.
@MainActor
private func waitFor(
  _ client: BridgeClient, _ predicate: (ConnectionState) -> Bool,
  sourceLocation: SourceLocation = #_sourceLocation
) async {
  for _ in 0..<500 where !predicate(client.state) {
    try? await Task.sleep(for: .milliseconds(10))
  }
  #expect(predicate(client.state), "state was \(client.state)", sourceLocation: sourceLocation)
}

@MainActor
@Suite struct BridgeClientTests {
  @Test func connectsWithTokenAndNegotiatesVersion() async throws {
    let received = Box<String>()
    let bridge = try await FakeBridge(token: "s3cret") { frame, peer in
      received.value = frame
      peer.send(ack)
    }
    defer { bridge.stop() }

    let client = BridgeClient()
    client.connect(to: BridgeConfig(url: bridge.url, token: "s3cret"))
    #expect(client.state == .connecting)
    await waitFor(client) { $0 == .connected }

    let hello = try #require(received.value)
    #expect(hello.hasSuffix("\n"))
    #expect(hello.contains(#""name":"hello""#))
    #expect(hello.contains(#""protocolVersion":2"#))
    client.disconnect()
    #expect(client.state == .offline)
  }

  @Test func wrongTokenFailsAsUnauthorized() async throws {
    let bridge = try await FakeBridge(token: "s3cret") { _, _ in }
    defer { bridge.stop() }

    let client = BridgeClient()
    client.connect(to: BridgeConfig(url: bridge.url, token: "wrong"))
    await waitFor(client) { $0 != .connecting }
    guard case .failed(let error) = client.state else {
      Issue.record("expected failed, got \(client.state)")
      return
    }
    #expect(error.code == "unauthorized")
  }

  @Test func versionMismatchSurfacesProtocolError() async throws {
    let bridge = try await FakeBridge(token: "t") { _, peer in
      peer.send(
        #"{"type":"result","id":1,"error":{"code":"versionMismatch","message":"bridge speaks protocol version 2"}}"#
          + "\n")
      peer.close(code: 1008)
    }
    defer { bridge.stop() }

    let client = BridgeClient()
    client.connect(to: BridgeConfig(url: bridge.url, token: "t"))
    await waitFor(client) { $0 != .connecting }
    #expect(
      client.state
        == .failed(
          ProtocolError(code: "versionMismatch", message: "bridge speaks protocol version 2")))
  }

  @Test func connectionLevelErrorSurfacesAndSticks() async throws {
    let bridge = try await FakeBridge(token: "t") { _, peer in
      peer.send(
        #"{"type":"error","error":{"code":"malformedRecord","message":"nope"}}"# + "\n")
      peer.close(code: 1008)
    }
    defer { bridge.stop() }

    let client = BridgeClient()
    client.connect(to: BridgeConfig(url: bridge.url, token: "t"))
    await waitFor(client) { $0 != .connecting }
    try await Task.sleep(for: .milliseconds(100))  // the close that follows must not mask the error
    #expect(client.state == .failed(ProtocolError(code: "malformedRecord", message: "nope")))
  }

  @Test func droppedConnectionGoesOffline() async throws {
    let bridge = try await FakeBridge(token: "t") { _, peer in
      peer.send(ack)
      Task { try? await Task.sleep(for: .milliseconds(50)); peer.drop() }
    }
    defer { bridge.stop() }

    let client = BridgeClient()
    client.connect(to: BridgeConfig(url: bridge.url, token: "t"))
    await waitFor(client) { $0 == .connected }
    await waitFor(client) { $0 == .offline }
  }

  @Test func unreachableBridgeGoesOffline() async throws {
    let bridge = try await FakeBridge(token: "t") { _, _ in }
    let url = bridge.url
    bridge.stop()
    try await Task.sleep(for: .milliseconds(100))

    let client = BridgeClient()
    client.connect(to: BridgeConfig(url: url, token: "t"))
    await waitFor(client) { $0 == .offline }
  }

  @Test func retriesStaySilentlyOffline() async throws {
    let bridge = try await FakeBridge(token: "t") { _, _ in }
    let url = bridge.url
    bridge.stop()
    try await Task.sleep(for: .milliseconds(100))

    let client = BridgeClient(reconnectDelay: .milliseconds(10))
    client.connect(to: BridgeConfig(url: url, token: "t"))
    await waitFor(client) { $0 == .offline }
    for _ in 0..<30 {
      #expect(client.state == .offline)
      try await Task.sleep(for: .milliseconds(10))
    }
    client.disconnect()
  }

  @Test func notConnectedHasReadableMessage() {
    #expect(BridgeClient.CommandError.notConnected.localizedDescription == "Not connected to the bridge.")
  }

  @Test func reconnectingReplacesThePreviousConnection() async throws {
    let bridge = try await FakeBridge(token: "t") { _, peer in peer.send(ack) }
    defer { bridge.stop() }

    let client = BridgeClient()
    client.connect(to: BridgeConfig(url: bridge.url, token: "bad"))
    client.connect(to: BridgeConfig(url: bridge.url, token: "t"))
    await waitFor(client) { $0 != .connecting }
    #expect(client.state == .connected)
  }
}

/// Lock-protected mutable cell for sharing a value with the fake bridge's queue.
final class Box<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Value?
  var value: Value? {
    get { lock.withLock { stored } }
    set { lock.withLock { stored = newValue } }
  }
}
