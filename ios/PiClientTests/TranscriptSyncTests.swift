import Foundation
import Testing

@testable import PiClient

private let ack = #"{"type":"result","id":1,"result":{"protocolVersion":1}}"# + "\n"

private func event(_ seq: Int, _ name: String, _ data: String) -> String {
  #"{"type":"event","seq":\#(seq),"name":"\#(name)","data":\#(data)}"# + "\n"
}

private func delta(_ seq: Int, _ kind: String, _ text: String) -> String {
  event(seq, "delta", #"{"kind":"\#(kind)","text":"\#(text)"}"#)
}

/// Waits until `condition` holds, failing the test after 5 s.
@MainActor
private func waitUntil(
  _ description: String, sourceLocation: SourceLocation = #_sourceLocation,
  _ condition: () -> Bool
) async {
  for _ in 0..<500 where !condition() { try? await Task.sleep(for: .milliseconds(10)) }
  #expect(condition(), "timed out waiting for \(description)", sourceLocation: sourceLocation)
}

/// What the user would read: one `role: text` line per message (streaming ones suffixed `…`).
private func lines(_ transcript: Transcript) -> [String] {
  transcript.messages.map {
    "\($0.role == .user ? "user" : "assistant"): \($0.text)\($0.isStreaming ? "…" : "")"
  }
}

@MainActor
@Suite struct TranscriptSyncTests {
  /// Connects a fresh client to a bridge that answers every `hello` with `reply(helloNumber, frame)`.
  private func connect(
    reconnectDelay: Duration = .milliseconds(20),
    reply: @escaping @Sendable (_ helloNumber: Int, _ hello: String, _ peer: FakeBridge.Peer) -> Void
  ) async throws -> (BridgeClient, FakeBridge, hellos: Box<[String]>) {
    let hellos = Box<[String]>()
    hellos.value = []
    let bridge = try await FakeBridge(token: "t") { frame, peer in
      hellos.value = (hellos.value ?? []) + [frame]
      reply(hellos.value?.count ?? 0, frame, peer)
    }
    let client = BridgeClient(reconnectDelay: reconnectDelay)
    client.connect(to: BridgeConfig(url: bridge.url, token: "t"))
    return (client, bridge, hellos)
  }

  @Test func freshConnectShowsTheSnapshot() async throws {
    let (client, bridge, hellos) = try await connect { _, _, peer in
      peer.send(ack)
      peer.send(
        event(
          7, "transcript",
          #"{"running":false,"messages":[{"role":"user","text":"hi"},{"role":"assistant","text":"Hello there, this is a reasonably long answer to push the frame past 125 bytes","thinking":"hm"}]}"#
        ))
    }
    defer { bridge.stop() }

    await waitUntil("snapshot") { client.transcript.messages.count == 2 }
    #expect(
      lines(client.transcript) == [
        "user: hi",
        "assistant: Hello there, this is a reasonably long answer to push the frame past 125 bytes",
      ])
    #expect(client.transcript.messages[1].thinking == "hm")
    #expect(client.transcript.lastSeq == 7)
    #expect(hellos.value?.first?.contains(#""lastSeq":0"#) == true)
  }

  @Test func deltasAssembleThenMessageEndReplacesThem() async throws {
    let (client, bridge, _) = try await connect { _, _, peer in
      peer.send(ack)
      peer.send(event(1, "runStarted", "{}"))
      peer.send(delta(2, "thinking", "hm"))
      peer.send(delta(3, "text", "Hel"))
      peer.send(delta(4, "text", "lo"))
    }
    defer { bridge.stop() }

    await waitUntil("deltas") { client.transcript.lastSeq == 4 }
    #expect(lines(client.transcript) == ["assistant: Hello…"])
    #expect(client.transcript.messages[0].thinking == "hm")
    #expect(client.transcript.isRunning)

    let (done, doneBridge, _) = try await connect { _, _, peer in
      peer.send(ack)
      peer.send(event(1, "runStarted", "{}"))
      peer.send(delta(2, "text", "Hel"))
      peer.send(event(3, "messageEnd", #"{"text":"Hello!","thinking":""}"#))
      peer.send(event(4, "runSettled", #"{"stopReason":"success","durationMs":5}"#))
    }
    defer { doneBridge.stop() }

    await waitUntil("settled") { done.transcript.lastSeq == 4 }
    #expect(lines(done.transcript) == ["assistant: Hello!"])
    #expect(!done.transcript.isRunning)
  }

  @Test func aSnapshotTakenMidStreamIsContinuedByLiveDeltas() async throws {
    let (client, bridge, _) = try await connect { _, _, peer in
      peer.send(ack)
      peer.send(
        event(
          2, "transcript",
          #"{"running":true,"messages":[{"role":"user","text":"hi"},{"role":"assistant","text":"Hel","thinking":"","streaming":true}]}"#
        ))
      peer.send(delta(3, "text", "lo"))
      peer.send(event(4, "messageEnd", #"{"text":"Hello","thinking":""}"#))
    }
    defer { bridge.stop() }

    await waitUntil("message end") { client.transcript.lastSeq == 4 }
    #expect(lines(client.transcript) == ["user: hi", "assistant: Hello"])
  }

  @Test func aDroppedSocketReconnectsAndResumesAtTheCursor() async throws {
    let (client, bridge, hellos) = try await connect { helloNumber, _, peer in
      peer.send(ack)
      if helloNumber == 1 {
        peer.send(event(3, "transcript", #"{"running":true,"messages":[]}"#))
        peer.send(delta(4, "text", "Hel"))
        Task { try? await Task.sleep(for: .milliseconds(50)); peer.drop() }
      } else {
        peer.send(delta(4, "text", "Hel"))  // already seen: must not be applied twice
        peer.send(delta(5, "text", "lo"))
      }
    }
    defer { bridge.stop() }

    await waitUntil("resumed events") { client.transcript.lastSeq == 5 }
    #expect(lines(client.transcript) == ["assistant: Hello…"])
    #expect(client.state == .connected)
    #expect(hellos.value?.count == 2)
    #expect(hellos.value?.last?.contains(#""lastSeq":4"#) == true)
  }

  @Test func aSnapshotWithALowerSeqReplacesEverythingAfterABridgeRestart() async throws {
    let (client, bridge, _) = try await connect { helloNumber, _, peer in
      peer.send(ack)
      if helloNumber == 1 {
        peer.send(event(9, "transcript", #"{"running":false,"messages":[{"role":"user","text":"old"}]}"#))
        Task { try? await Task.sleep(for: .milliseconds(50)); peer.drop() }
      } else {
        peer.send(event(0, "transcript", #"{"running":false,"messages":[{"role":"user","text":"new"}]}"#))
      }
    }
    defer { bridge.stop() }

    await waitUntil("restarted snapshot") { lines(client.transcript) == ["user: new"] }
    #expect(client.transcript.lastSeq == 0)
  }

  @Test func aLiveSnapshotFromASessionSwitchReplacesTheConversationAndMovesTheCursor() async throws {
    let (client, bridge, _) = try await connect { _, _, peer in
      peer.send(ack)
      peer.send(
        event(
          5, "transcript", #"{"sessionId":"a","running":false,"messages":[{"role":"user","text":"in a"}]}"#))
      peer.send(event(6, "runStarted", "{}") + event(7, "toolCall", #"{"phase":"start","toolCallId":"t","toolName":"bash"}"#))
      peer.send(
        event(
          8, "transcript", #"{"sessionId":"b","running":false,"messages":[{"role":"user","text":"in b"}]}"#))
    }
    defer { bridge.stop() }

    await waitUntil("switch snapshot") { client.transcript.lastSeq == 8 }
    #expect(client.transcript.sessionId == "b")
    #expect(lines(client.transcript) == ["user: in b"])
    #expect(client.transcript.toolCalls.isEmpty)
    #expect(!client.transcript.isRunning)
  }

  @Test func connectingToADifferentBridgeStartsFromScratch() async throws {
    let (client, bridge, _) = try await connect { _, _, peer in
      peer.send(ack)
      peer.send(event(5, "transcript", #"{"running":false,"messages":[{"role":"user","text":"a"}]}"#))
    }
    defer { bridge.stop() }
    await waitUntil("first snapshot") { client.transcript.lastSeq == 5 }

    client.connect(to: BridgeConfig(url: bridge.url, token: "t2"))
    #expect(client.transcript == Transcript())
  }

  // MARK: Reasoning traces, tool calls, runs

  @Test func toolCallsAppearAfterTheTurnThatCalledThemAndCarryTheirOutcome() async throws {
    let (client, bridge, _) = try await connect { _, _, peer in
      peer.send(ack)
      peer.send(event(1, "runStarted", "{}"))
      peer.send(event(2, "messageEnd", #"{"text":"","thinking":"plan"}"#))
      peer.send(
        event(
          3, "toolCall",
          #"{"phase":"start","toolCallId":"t1","toolName":"bash","args":{"command":"ls"}}"#))
      peer.send(
        event(4, "toolCall", #"{"phase":"update","toolCallId":"t1","toolName":"bash","output":"a"}"#))
      peer.send(
        event(
          5, "toolCall",
          #"{"phase":"end","toolCallId":"t1","toolName":"bash","output":"a\nb","isError":false,"durationMs":42}"#
        ))
      peer.send(event(6, "messageEnd", #"{"text":"Done","thinking":""}"#))
    }
    defer { bridge.stop() }

    await waitUntil("turn after tool") { client.transcript.lastSeq == 6 }
    #expect(entryKinds(client.transcript) == ["message", "tool", "message"])
    #expect(client.transcript.messages.map(\.thinking) == ["plan", ""])
    let call = try #require(client.transcript.toolCalls.first)
    #expect(call.name == "bash")
    #expect(call.args?.formatted.contains(#""command" : "ls""#) == true)
    #expect(call.output == "a\nb")
    #expect(call.status == .succeeded)
    #expect(call.durationMs == 42)
  }

  @Test func aToolCallInFlightShowsItsOutputSoFarAndAFailedOneIsMarked() async throws {
    let (client, bridge, _) = try await connect { _, _, peer in
      peer.send(ack)
      peer.send(
        event(1, "toolCall", #"{"phase":"start","toolCallId":"t1","toolName":"read","args":{}}"#))
      peer.send(
        event(2, "toolCall", #"{"phase":"update","toolCallId":"t1","toolName":"read","output":"par"}"#))
      peer.send(
        event(3, "toolCall", #"{"phase":"start","toolCallId":"t2","toolName":"bash","args":{}}"#))
      peer.send(
        event(
          4, "toolCall",
          #"{"phase":"end","toolCallId":"t2","toolName":"bash","output":"boom","isError":true}"#))
    }
    defer { bridge.stop() }

    await waitUntil("tool events") { client.transcript.lastSeq == 4 }
    let calls = client.transcript.toolCalls
    #expect(calls.map(\.status) == [.running, .failed])
    #expect(calls.map(\.output) == ["par", "boom"])
    #expect(calls[1].durationMs == nil)
  }

  @Test func theCurrentRunIsTimedFromItsStartAndSettlingEndsIt() async throws {
    let (client, bridge, _) = try await connect { _, _, peer in
      peer.send(ack)
      peer.send(event(1, "transcript", #"{"running":true,"elapsedMs":60000,"messages":[]}"#))
    }
    defer { bridge.stop() }

    await waitUntil("running snapshot") { client.transcript.isRunning }
    let elapsed = Date.now.timeIntervalSince(try #require(client.transcript.runStartedAt))
    #expect((60..<65).contains(elapsed))

    let (live, liveBridge, _) = try await connect { _, _, peer in
      peer.send(ack)
      peer.send(event(1, "runStarted", "{}"))
    }
    defer { liveBridge.stop() }
    await waitUntil("run started") { live.transcript.isRunning }
    #expect(Date.now.timeIntervalSince(try #require(live.transcript.runStartedAt)) < 5)
  }

  @Test(arguments: [
    ("success", Transcript.StopReason.success, ""),
    ("error", .error, ",\"errorMessage\":\"401\""),
    ("aborted", .aborted, ""),
    ("length", .length, ""),
  ])
  func aSettledRunRecordsItsDurationAndHowItEnded(
    wire: String, expected: Transcript.StopReason, extra: String
  ) async throws {
    let (client, bridge, _) = try await connect { _, _, peer in
      peer.send(ack)
      peer.send(event(1, "runStarted", "{}"))
      peer.send(event(2, "runSettled", #"{"stopReason":"\#(wire)","durationMs":65000\#(extra)}"#))
    }
    defer { bridge.stop() }

    await waitUntil("settled") { client.transcript.lastSeq == 2 }
    #expect(!client.transcript.isRunning)
    #expect(client.transcript.runStartedAt == nil)
    let run = try #require(client.transcript.runs.first)
    #expect(run.stopReason == expected)
    #expect(run.durationMs == 65000)
    #expect(run.errorMessage == (extra.isEmpty ? nil : "401"))
  }
}

private func entryKinds(_ transcript: Transcript) -> [String] {
  transcript.entries.map {
    switch $0 {
    case .message: "message"
    case .toolCall: "tool"
    case .run: "run"
    }
  }
}
