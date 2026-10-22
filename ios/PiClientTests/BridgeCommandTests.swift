import Foundation
import Testing

@testable import PiClient

private let ack = #"{"type":"result","id":1,"result":{"protocolVersion":1}}"# + "\n"

private func result(_ id: Int, _ payload: String = "{}") -> String {
  #"{"type":"result","id":\#(id),"result":\#(payload)}"# + "\n"
}

private func event(_ seq: Int, _ name: String, _ data: String) -> String {
  #"{"type":"event","seq":\#(seq),"name":"\#(name)","data":\#(data)}"# + "\n"
}

@MainActor
@Suite struct BridgeCommandTests {
  /// A client connected to a bridge that answers `hello` itself and hands every other frame to `reply`.
  private func connected(
    onConnect: String = "",
    reply: @escaping @Sendable (_ frame: String, _ peer: FakeBridge.Peer) -> Void = { _, _ in }
  ) async throws -> (BridgeClient, FakeBridge, received: Box<[String]>) {
    let received = Box<[String]>()
    received.value = []
    let bridge = try await FakeBridge(token: "t") { frame, peer in
      if frame.contains(#""name":"hello""#) {
        peer.send(ack + onConnect)
      } else {
        received.value = (received.value ?? []) + [frame]
        reply(frame, peer)
      }
    }
    let client = BridgeClient()
    client.connect(to: BridgeConfig(url: bridge.url, token: "t"))
    for _ in 0..<500 where client.state != .connected { try await Task.sleep(for: .milliseconds(10)) }
    #expect(client.state == .connected)
    return (client, bridge, received)
  }

  @Test func sendingAPromptNamesTheTextAndHowToDeliverItDuringARun() async throws {
    let (client, bridge, received) = try await connected { _, peer in peer.send(result(2)) }
    defer { bridge.stop() }

    try await client.send("hi", mode: .followUp)

    let frame = try #require(received.value?.first)
    #expect(frame.hasSuffix("\n"))
    #expect(frame.contains(#""name":"prompt""#))
    #expect(frame.contains(#""text":"hi""#))
    #expect(frame.contains(#""mode":"followUp""#))
  }

  @Test func theBridgeRefusingAPromptThrowsItsError() async throws {
    let (client, bridge, _) = try await connected { _, peer in
      peer.send(
        #"{"type":"result","id":2,"error":{"code":"sessionError","message":"no model"}}"# + "\n")
    }
    defer { bridge.stop() }

    await #expect(throws: ProtocolError(code: "sessionError", message: "no model")) {
      try await client.send("hi")
    }
  }

  @Test func abortAsksTheBridgeToStopTheRun() async throws {
    let (client, bridge, received) = try await connected { _, peer in peer.send(result(2)) }
    defer { bridge.stop() }

    try await client.abort()

    #expect(received.value?.first?.contains(#""name":"abort""#) == true)
  }

  @Test func clearingTheQueueReturnsTheDroppedTexts() async throws {
    let (client, bridge, received) = try await connected { _, peer in
      peer.send(result(2, #"{"steering":["left"],"followUp":["later"]}"#))
    }
    defer { bridge.stop() }

    let dropped = try await client.clearQueue()

    #expect(dropped == Transcript.Queue(steering: ["left"], followUp: ["later"]))
    #expect(received.value?.first?.contains(#""name":"clearQueue""#) == true)
  }

  @Test func resultsAreMatchedToTheirCommandsEvenWhenTheyArriveOutOfOrder() async throws {
    let (client, bridge, _) = try await connected { frame, peer in
      // Answer the second command first.
      if frame.contains(#""id":3"#) {
        peer.send(result(3, #"{"steering":["second"],"followUp":[]}"#))
        peer.send(result(2))
      }
    }
    defer { bridge.stop() }

    async let first: Void = client.send("one")
    try await Task.sleep(for: .milliseconds(50))
    async let second = client.clearQueue()

    #expect(try await second == Transcript.Queue(steering: ["second"], followUp: []))
    try await first
  }

  @Test func commandsFailWhileNotConnected() async throws {
    let client = BridgeClient()
    await #expect(throws: BridgeClient.CommandError.notConnected) {
      try await client.send("hi")
    }
  }

  @Test func aCommandInFlightFailsWhenTheConnectionDrops() async throws {
    let (client, bridge, _) = try await connected { _, peer in peer.drop() }
    defer { bridge.stop() }

    await #expect(throws: (any Error).self) { try await client.abort() }
  }

  // MARK: Transcript: user messages and the queue

  @Test func userMessagesAppearInTheTranscriptAsTheyEnterTheConversation() async throws {
    let (client, bridge, _) = try await connected(
      onConnect: event(1, "runStarted", "{}") + event(2, "userMessage", #"{"text":"hi"}"#)
        + event(3, "delta", #"{"kind":"text","text":"Hello"}"#)
        + event(4, "messageEnd", #"{"text":"Hello","thinking":""}"#)
        + event(5, "userMessage", #"{"text":"actually, stop"}"#))
    defer { bridge.stop() }

    for _ in 0..<500 where client.transcript.lastSeq < 5 { try await Task.sleep(for: .milliseconds(10)) }
    #expect(client.transcript.messages.map(\.role) == [.user, .assistant, .user])
    #expect(client.transcript.messages.map(\.text) == ["hi", "Hello", "actually, stop"])
  }

  @Test func theQueueFollowsQueueEventsAndSnapshots() async throws {
    let (client, bridge, _) = try await connected(
      onConnect: event(1, "queue", #"{"steering":["left"],"followUp":["later","much later"]}"#))
    defer { bridge.stop() }

    for _ in 0..<500 where client.transcript.lastSeq < 1 { try await Task.sleep(for: .milliseconds(10)) }
    #expect(client.transcript.queue == Transcript.Queue(steering: ["left"], followUp: ["later", "much later"]))

    let (fresh, freshBridge, _) = try await connected(
      onConnect: event(
        4, "transcript", #"{"running":true,"messages":[],"steering":[],"followUp":["later"]}"#))
    defer { freshBridge.stop() }
    for _ in 0..<500 where fresh.transcript.lastSeq < 4 { try await Task.sleep(for: .milliseconds(10)) }
    #expect(fresh.transcript.queue == Transcript.Queue(steering: [], followUp: ["later"]))
  }

  @Test func aDeliveredMessageLeavesTheQueue() async throws {
    let (client, bridge, _) = try await connected(
      onConnect: event(1, "queue", #"{"steering":["left"],"followUp":[]}"#)
        + event(2, "queue", #"{"steering":[],"followUp":[]}"#)
        + event(3, "userMessage", #"{"text":"left"}"#))
    defer { bridge.stop() }

    for _ in 0..<500 where client.transcript.lastSeq < 3 { try await Task.sleep(for: .milliseconds(10)) }
    #expect(client.transcript.queue.isEmpty)
    #expect(client.transcript.messages.map(\.text) == ["left"])
  }
}
