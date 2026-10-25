import Foundation
import Testing

@testable import PiMobile

private let ack = #"{"type":"result","id":1,"result":{"protocolVersion":3}}"# + "\n"

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

  @Test func resultsAreMatchedToTheirCommandsEvenWhenTheyArriveOutOfOrder() async throws {
    let (client, bridge, _) = try await connected { frame, peer in
      // Answer the second command first.
      if frame.contains(#""id":3"#) {
        peer.send(result(3, #"{"skills":[{"name":"tdd","description":"d"}]}"#))
        peer.send(result(2))
      }
    }
    defer { bridge.stop() }

    async let first: Void = client.send("one")
    try await Task.sleep(for: .milliseconds(50))
    async let second = client.skills()

    #expect(try await second.map(\.name) == ["tdd"])
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

  @Test func theStatusFollowsStatusEventsAndSnapshots() async throws {
    let (client, bridge, _) = try await connected(
      onConnect: event(
        1, "transcript",
        #"{"running":false,"messages":[],"model":"opus","contextTokens":18800,"contextWindow":1000000,"cost":0.5}"#))
    defer { bridge.stop() }
    for _ in 0..<500 where client.transcript.lastSeq < 1 { try await Task.sleep(for: .milliseconds(10)) }
    #expect(
      client.transcript.status
        == Transcript.Status(model: "opus", contextTokens: 18_800, contextWindow: 1_000_000, cost: 0.5))

    let (fresh, freshBridge, _) = try await connected(
      onConnect: event(2, "status", #"{"model":"opus","contextWindow":1000000,"cost":0.75}"#))
    defer { freshBridge.stop() }
    for _ in 0..<500 where fresh.transcript.lastSeq < 2 { try await Task.sleep(for: .milliseconds(10)) }
    #expect(fresh.transcript.status == Transcript.Status(model: "opus", contextWindow: 1_000_000, cost: 0.75))
  }

  @Test func contextUsageIsCompact() {
    #expect(Transcript.Status(contextTokens: 18_800, contextWindow: 1_000_000).contextUsage == "18.8k/1.0M")
    #expect(Transcript.Status(contextTokens: 999, contextWindow: 200_000).contextUsage == "999/200.0k")
    #expect(Transcript.Status(contextTokens: 12_000_000, contextWindow: 10_000_000).contextUsage == "12.0M/10.0M")
    #expect(Transcript.Status(contextWindow: 200_000).contextUsage == "?/200.0k")
    #expect(Transcript.Status().contextUsage == nil)
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

// MARK: Discovery

extension BridgeCommandTests {
  @Test func listingSkillsReturnsTheSessionsSkills() async throws {
    let (client, bridge, received) = try await connected { _, peer in
      peer.send(
        result(2, #"{"skills":[{"name":"tdd","description":"Test-driven development."},{"name":"pr","description":"Write a PR."}]}"#))
    }
    defer { bridge.stop() }

    let skills = try await client.skills()

    #expect(skills == [Skill(name: "tdd", description: "Test-driven development."), Skill(name: "pr", description: "Write a PR.")])
    #expect(received.value?.first?.contains(#""name":"listSkills""#) == true)
  }

  @Test func listingModelsReturnsWhatTheSessionCanSwitchTo() async throws {
    let (client, bridge, received) = try await connected { _, peer in
      peer.send(result(2, #"{"models":[{"provider":"anthropic","id":"opus","name":"Claude Opus"}]}"#))
    }
    defer { bridge.stop() }

    let models = try await client.models()

    #expect(models == [ModelInfo(provider: "anthropic", id: "opus", name: "Claude Opus")])
    #expect(received.value?.first?.contains(#""name":"listModels""#) == true)
  }

  @Test func settingTheModelNamesItsProviderAndId() async throws {
    let (client, bridge, received) = try await connected { _, peer in peer.send(result(2)) }
    defer { bridge.stop() }

    try await client.setModel(ModelInfo(provider: "anthropic", id: "opus", name: "Claude Opus"))

    let frame = try #require(received.value?.first)
    #expect(frame.contains(#""name":"setModel""#))
    #expect(frame.contains(#""provider":"anthropic""#))
    #expect(frame.contains(#""id":"opus""#))
  }

  @Test func searchingFilesSendsTheQueryAndReturnsTheMatches() async throws {
    let (client, bridge, received) = try await connected { _, peer in
      peer.send(result(2, #"{"files":["src/server.ts","README.md"]}"#))
    }
    defer { bridge.stop() }

    let files = try await client.searchFiles("ser")

    #expect(files == ["src/server.ts", "README.md"])
    let frame = try #require(received.value?.first)
    #expect(frame.contains(#""name":"searchFiles""#))
    #expect(frame.contains(#""query":"ser""#))
  }
}

// MARK: Sessions

extension BridgeCommandTests {
  @Test func theSessionListFollowsTheBridgesPushes() async throws {
    let sessions =
      #"{"type":"event","name":"sessions","data":{"sessions":[{"id":"s2","name":"Refactor","cwd":"/work/a","preview":"first","running":true,"activeAt":"2025-01-02T03:04:05.000Z"},{"id":"s1","cwd":"/work/b","preview":"","running":false,"lastStopReason":"error","activeAt":"2025-01-01T00:00:00.000Z"},{"id":"s0","cwd":"/work/c","preview":"","running":false,"lastStopReason":"aborted","activeAt":"2025-01-01T00:00:00.000Z"}]}}"#
    let (client, bridge, _) = try await connected(
      onConnect: #"{"type":"event","name":"sessions","data":{"sessions":[]}}"# + "\n"
    ) { _, _ in }
    defer { bridge.stop() }
    for _ in 0..<500 where client.sessions == nil { try await Task.sleep(for: .milliseconds(10)) }
    #expect(client.sessions == [])

    let (pushed, pushedBridge, _) = try await connected(onConnect: sessions + "\n")
    defer { pushedBridge.stop() }
    for _ in 0..<500 where pushed.sessions == nil { try await Task.sleep(for: .milliseconds(10)) }

    let list = try #require(pushed.sessions)
    #expect(list.map(\.id) == ["s2", "s1", "s0"])
    #expect(list.map(\.title) == ["Refactor", "New session", "New session"])
    #expect(list.map(\.cwd) == ["/work/a", "/work/b", "/work/c"])
    #expect(list.map(\.activity) == [.working, .failed, .finished])
    #expect(list[0].activeAt == Date(timeIntervalSince1970: 1_735_787_045))
  }

  @Test func sessionTitleIsOnlyItsFirstLine() throws {
    func title(name: String?, preview: String) throws -> String {
      var json: [String: Any] = [
        "id": "s", "cwd": "/", "preview": preview, "running": false, "activeAt": "2025-01-01T00:00:00.000Z",
      ]
      json["name"] = name
      let data = try JSONSerialization.data(withJSONObject: json)
      return try JSONDecoder().decode(LiveSession.self, from: data).title
    }
    #expect(try title(name: nil, preview: "first\nsecond") == "first")
    #expect(try title(name: "name\r\nmore", preview: "x") == "name")
    #expect(try title(name: nil, preview: "\nsecond") == "second")
  }

  @Test func rejoiningASessionTheBridgeNoLongerHasMarksItEnded() async throws {
    let (client, bridge, _) = try await connected(
      onConnect: event(1, "transcript", #"{"sessionId":"s1","running":false,"messages":[]}"#)
    ) { _, peer in
      peer.send(#"{"type":"result","id":2,"error":{"code":"unknownSession","message":"gone"}}"# + "\n")
    }
    defer { bridge.stop() }
    for _ in 0..<500 where client.transcript.sessionId == nil { try await Task.sleep(for: .milliseconds(10)) }

    client.show(sessionId: "s1")

    for _ in 0..<500 where client.showFailure == nil { try await Task.sleep(for: .milliseconds(10)) }
    #expect(client.showFailure == "gone")
    #expect(client.transcript.hasEnded)
  }

  @Test func statsReturnTheSessionsCountsAndRunTiming() async throws {
    let (client, bridge, received) = try await connected { _, peer in
      peer.send(
        result(
          2,
          #"{"userMessages":2,"assistantMessages":3,"toolCalls":5,"tokens":1200,"cost":0.25,"runs":2,"runDurationMs":65000}"#
        ))
    }
    defer { bridge.stop() }

    let stats = try await client.stats()

    #expect(
      stats
        == SessionStats(
          userMessages: 2, assistantMessages: 3, toolCalls: 5, tokens: 1200, cost: 0.25, runs: 2,
          runDurationMs: 65000))
    #expect(received.value?.first?.contains(#""name":"getStats""#) == true)
  }
}
