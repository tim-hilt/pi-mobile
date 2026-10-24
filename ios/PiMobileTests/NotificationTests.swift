import Foundation
import Testing
import UserNotifications

@testable import PiMobile

/// An ntfy WebSocket `message` frame whose body is `notice`, as ntfy.sh sends it.
private func ntfyMessage(_ notice: String) -> String {
  let body = try! JSONEncoder().encode(notice)
  return #"{"id":"a1","time":1,"event":"message","topic":"t","message":\#(String(data: body, encoding: .utf8)!)}"#
}

private let finished = #"{"sessionId":"s7","sessionName":"refactor auth","stopReason":"success","durationMs":125000}"#

@MainActor
@Suite struct NotificationTests {
  // MARK: Notice parsing

  @Test func anNtfyMessageCarriesTheSettledRun() {
    let notice = RunSettledNotice(ntfyFrame: ntfyMessage(finished))

    #expect(
      notice
        == RunSettledNotice(
          sessionId: "s7", sessionName: "refactor auth", stopReason: .success, durationMs: 125_000))
  }

  @Test func ntfyHousekeepingAndForeignMessagesAreIgnored() {
    #expect(RunSettledNotice(ntfyFrame: #"{"event":"open","topic":"t"}"#) == nil)
    #expect(RunSettledNotice(ntfyFrame: #"{"event":"keepalive","topic":"t"}"#) == nil)
    #expect(RunSettledNotice(ntfyFrame: ntfyMessage("hello from curl")) == nil)
    #expect(RunSettledNotice(ntfyFrame: "not json") == nil)
  }

  // MARK: Notification content

  @Test func theNotificationNamesTheSessionHowItEndedAndForHowLong() {
    let content = RunSettledNotice(ntfyFrame: ntfyMessage(finished))!.notificationContent

    #expect(content.title == "refactor auth")
    #expect(content.body == "Finished · \(format(durationMs: 125_000))")
    #expect(content.userInfo["sessionId"] as? String == "s7")
  }

  @Test(arguments: [
    (Transcript.StopReason.error, "Failed"), (.aborted, "Aborted"), (.length, "Cut off: output limit reached"),
  ])
  func theBodyTellsHowAnUnsuccessfulRunEnded(reason: Transcript.StopReason, label: String) {
    let notice = RunSettledNotice(sessionId: "s", sessionName: nil, stopReason: reason, durationMs: 1000)

    #expect(notice.notificationContent.body == "\(label) · \(format(durationMs: 1000))")
  }

  @Test func anUnnamedSessionGetsAGenericTitle() {
    let notice = RunSettledNotice(sessionId: "s", sessionName: nil, stopReason: .success, durationMs: 0)

    #expect(notice.notificationContent.title == "Session")
  }

  // MARK: Topic

  @Test func theTopicIsStreamedOverTheNtfyWebSocket() {
    let topic = NtfyTopic(baseUrl: URL(string: "https://ntfy.sh")!, topic: "xk3")
    let selfHosted = NtfyTopic(baseUrl: URL(string: "http://ntfy.local:8080/")!, topic: "xk3")

    #expect(topic.streamURL.absoluteString == "wss://ntfy.sh/xk3/ws")
    #expect(selfHosted.streamURL.absoluteString == "ws://ntfy.local:8080/xk3/ws")
  }

  @Test func theHelloResultTellsTheClientWhereNotificationsArePublished() async throws {
    let bridge = try await FakeBridge(token: "t") { _, peer in
      peer.send(
        #"{"type":"result","id":1,"result":{"protocolVersion":2,"ntfy":{"baseUrl":"https://ntfy.example","topic":"xk3"}}}"#
          + "\n")
    }
    defer { bridge.stop() }
    let client = BridgeClient()

    client.connect(to: BridgeConfig(url: bridge.url, token: "t"))
    for _ in 0..<500 where client.ntfy == nil { try await Task.sleep(for: .milliseconds(10)) }

    #expect(client.ntfy == NtfyTopic(baseUrl: URL(string: "https://ntfy.example")!, topic: "xk3"))
  }

  // MARK: Stream

  @Test func settledRunsArriveFromTheTopicStream() async throws {
    let bridge = try await FakeBridge(
      token: nil, script: { _, _ in },
      onConnect: { peer in
        peer.send(#"{"event":"open","topic":"xk3"}"#)
        peer.send(ntfyMessage(finished))
      })
    defer { bridge.stop() }
    let topic = NtfyTopic(baseUrl: bridge.url, topic: "xk3")

    let received = Box<[RunSettledNotice]>()
    received.value = []
    let listening = Task {
      await NtfyStream.listen(to: topic) { received.value = (received.value ?? []) + [$0] }
    }
    for _ in 0..<500 where received.value?.isEmpty != false { try await Task.sleep(for: .milliseconds(10)) }
    listening.cancel()

    #expect(received.value?.map(\.sessionId) == ["s7"])
  }

  @Test func theStreamReconnectsAfterADrop() async throws {
    let connections = Box<Int>()
    connections.value = 0
    let bridge = try await FakeBridge(
      token: nil, script: { _, _ in },
      onConnect: { peer in
        connections.value = (connections.value ?? 0) + 1
        if connections.value == 1 { peer.drop() } else { peer.send(ntfyMessage(finished)) }
      })
    defer { bridge.stop() }

    let received = Box<Int>()
    received.value = 0
    let listening = Task {
      await NtfyStream.listen(to: NtfyTopic(baseUrl: bridge.url, topic: "t"), retryDelay: .milliseconds(20)) { _ in
        received.value = (received.value ?? 0) + 1
      }
    }
    for _ in 0..<500 where received.value == 0 { try await Task.sleep(for: .milliseconds(10)) }
    listening.cancel()

    #expect(received.value == 1)
  }

  // MARK: Deep link

  @Test func showingTheCurrentSessionSendsNothing() async throws {
    let (client, bridge, received) = try await connected(sessionId: "s7")
    defer { bridge.stop() }

    try await client.show(sessionId: "s7")

    #expect(received.value == [])
  }

  @Test func showingAnotherSessionJoinsIt() async throws {
    let (client, bridge, received) = try await connected(sessionId: "s1")
    defer { bridge.stop() }

    try await client.show(sessionId: "s7")

    #expect(received.value?.first?.contains(#""name":"joinSession""#) == true)
    #expect(received.value?.first?.contains(#""id":"s7""#) == true)
  }

  @Test func showingASessionWaitsForTheConnection() async throws {
    let (client, bridge, received) = try await connected(sessionId: "s1", connect: false)
    defer { bridge.stop() }

    let showing = Task { try await client.show(sessionId: "s7") }
    try await Task.sleep(for: .milliseconds(50))
    client.connect(to: BridgeConfig(url: bridge.url, token: "t"))
    try await showing.value

    #expect(received.value?.first?.contains(#""name":"joinSession""#) == true)
  }

  @Test func showingASessionGivesUpWhenTheBridgeRefusesUs() async throws {
    let bridge = try await FakeBridge(token: "t") { _, _ in }
    defer { bridge.stop() }
    let client = BridgeClient()
    client.connect(to: BridgeConfig(url: bridge.url, token: "wrong"))

    await #expect(throws: BridgeClient.CommandError.notConnected) {
      try await client.show(sessionId: "s7")
    }
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
          #"{"type":"result","id":1,"result":{"protocolVersion":2}}"# + "\n"
            + #"{"type":"event","seq":1,"name":"transcript","data":{"sessionId":"\#(sessionId)","running":false,"messages":[]}}"#
            + "\n")
      } else {
        received.value = (received.value ?? []) + [frame]
        peer.send(#"{"type":"result","id":2,"result":{}}"# + "\n")
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
