import Foundation
import Testing

@testable import PiMobile

@MainActor
@Suite struct DeepLinkTests {
  // MARK: Parsing

  @Test func readsAPairingCode() {
    let url = URL(string: "pimobile://connect?url=wss%3A%2F%2Fpi.example.com&token=t")!
    #expect(DeepLink(url: url) == .pair(BridgeConfig(url: URL(string: "wss://pi.example.com")!, token: "t")))
  }

  /// What a tapped ntfy notification opens.
  @Test func readsASessionLink() {
    #expect(DeepLink(url: URL(string: "pimobile://session?id=a%2Fb%20c%26d")!) == .session("a/b c&d"))
  }

  @Test(arguments: [
    "https://example.com/session?id=s7",
    "pimobile://session",
    "pimobile://session?id=",
    "pimobile://other?id=s7",
    "pimobile://connect?token=t",
  ])
  func ignoresForeignOrIncompleteLinks(_ link: String) {
    #expect(DeepLink(url: URL(string: link)!) == nil)
  }

  // MARK: Showing the linked session

  @Test func showingTheSessionOnShowAgainSendsNothing() async throws {
    let (client, bridge, received) = try await connected(sessionId: "s7")
    defer { bridge.stop() }

    client.show(sessionId: "s7")
    for _ in 0..<500 where received.value?.isEmpty != false { try await Task.sleep(for: .milliseconds(10)) }
    client.show(sessionId: "s7")
    try await Task.sleep(for: .milliseconds(50))

    #expect(received.value?.count == 1)
  }

  @Test func showingAnotherSessionJoinsIt() async throws {
    let (client, bridge, received) = try await connected(sessionId: "s1")
    defer { bridge.stop() }

    client.show(sessionId: "s7")

    for _ in 0..<500 where received.value?.isEmpty != false { try await Task.sleep(for: .milliseconds(10)) }
    #expect(received.value?.first?.contains(#""name":"joinSession""#) == true)
    #expect(received.value?.first?.contains(#""id":"s7""#) == true)
  }

  /// A link usually arrives as the app comes to the foreground, before it has reconnected.
  @Test func aSessionShownWhileOfflineIsJoinedOnceConnected() async throws {
    let (client, bridge, received) = try await connected(sessionId: "s1", connect: false)
    defer { bridge.stop() }

    client.show(sessionId: "s7")
    client.connect(to: BridgeConfig(url: bridge.url, token: "t"))

    for _ in 0..<500 where received.value?.isEmpty != false { try await Task.sleep(for: .milliseconds(10)) }
    #expect(received.value?.first?.contains(#""name":"joinSession""#) == true)
  }

  /// A client on a bridge whose current session is `sessionId`; answers every command with `{}`.
  /// Connects immediately unless `connect` is false (the test then does it).
  private func connected(sessionId: String, connect: Bool = true) async throws -> (
    BridgeClient, FakeBridge, received: Box<[String]>
  ) {
    let received = Box<[String]>()
    received.value = []
    let bridge = try await FakeBridge(token: "t") { frame, peer in
      if frame.contains(#""name":"hello""#) {
        peer.send(
          #"{"type":"result","id":1,"result":{"protocolVersion":3}}"# + "\n"
            + #"{"type":"event","seq":1,"name":"transcript","data":{"sessionId":"\#(sessionId)","running":false,"messages":[]}}"#
            + "\n")
      } else {
        received.value = (received.value ?? []) + [frame]
        peer.send(#"{"type":"result","id":2,"result":{"epoch":"e"}}"# + "\n")
      }
    }
    let client = BridgeClient()
    if connect {
      client.connect(to: BridgeConfig(url: bridge.url, token: "t"))
      for _ in 0..<500 where client.transcript.sessionId == nil { try await Task.sleep(for: .milliseconds(10)) }
    }
    return (client, bridge, received)
  }
}
