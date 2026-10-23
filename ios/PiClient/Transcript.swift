import Foundation

/// The conversation as the user reads it, built from bridge `event` records.
///
/// `entries` is the timeline: messages, the tool calls each turn made, and how each run ended.
/// Streamed `delta`s grow a provisional assistant message; its `messageEnd` replaces it with the
/// authoritative text, and a `transcript` snapshot replaces everything (snapshots carry no past
/// runs or tool durations, so those only appear for what was seen live or replayed). Switching
/// session arrives as such a snapshot, which also moves the cursor to the new session's `seq`.
/// `epoch` and `lastSeq` form the replay cursor to present on the next (re)connect.
struct Transcript: Equatable, Sendable {
  struct Message: Equatable, Identifiable, Sendable {
    enum Role: Sendable { case user, assistant }

    let id: Int
    let role: Role
    fileprivate(set) var text: String
    /// The reasoning trace of this turn.
    fileprivate(set) var thinking: String
    /// Still being generated: `text` is the deltas so far, not yet authoritative.
    fileprivate(set) var isStreaming: Bool
  }

  /// One tool execution, as a card.
  struct ToolCall: Equatable, Identifiable, Sendable {
    enum Status: Sendable { case running, succeeded, failed }

    let id: Int
    /// The bridge's `toolCallId`, tying start, update and end together.
    let callId: String
    let name: String
    fileprivate(set) var args: JSONValue?
    /// Output so far while running, the full output once finished.
    fileprivate(set) var output = ""
    fileprivate(set) var status = Status.running
    /// Nil until finished, and for a tool that never ran.
    fileprivate(set) var durationMs: Int?
  }

  enum StopReason: String, Sendable {
    case success, error, aborted
    /// The model hit its output limit mid-answer.
    case length
  }

  /// How a finished run ended.
  struct Run: Equatable, Identifiable, Sendable {
    let id: Int
    let stopReason: StopReason
    let durationMs: Int
    let errorMessage: String?
  }

  /// Messages sent during a run that the agent has not taken in yet, oldest first.
  struct Queue: Equatable, Sendable {
    /// Waiting for the current assistant turn to finish.
    var steering: [String] = []
    /// Waiting for the run to finish.
    var followUp: [String] = []

    var isEmpty: Bool { steering.isEmpty && followUp.isEmpty }
  }

  enum Entry: Equatable, Identifiable, Sendable {
    case message(Message)
    case toolCall(ToolCall)
    case run(Run)

    var id: Int {
      switch self {
      case .message(let message): message.id
      case .toolCall(let call): call.id
      case .run(let run): run.id
      }
    }
  }

  private(set) var entries: [Entry] = []
  /// When the active run began, or nil when idle. For a run joined midway it is reconstructed
  /// from the snapshot; a run replayed after a reconnect is dated from its replay.
  private(set) var runStartedAt: Date?
  /// What is waiting to be delivered to the agent.
  private(set) var queue = Queue()
  /// The session shown, as of the latest snapshot; nil before the first.
  private(set) var sessionId: String?
  /// `seq` of the newest event applied; 0 before any.
  private(set) var lastSeq = 0
  /// The bridge run `lastSeq` counts in, from the latest `hello` result; nil before the first.
  private(set) var epoch: String?

  private var nextId = 0

  /// Whether the agent is working on a run right now.
  var isRunning: Bool { runStartedAt != nil }
  var messages: [Message] { entries.compactMap { if case .message(let m) = $0 { m } else { nil } } }
  var toolCalls: [ToolCall] { entries.compactMap { if case .toolCall(let c) = $0 { c } else { nil } } }
  var runs: [Run] { entries.compactMap { if case .run(let r) = $0 { r } else { nil } } }

  /// Applies one record received at `now`: events, and the `epoch` of a `hello` result; anything
  /// else is ignored. Events at or below `lastSeq` (already seen, e.g. replayed twice) are skipped,
  /// except snapshots, which are authoritative and may legitimately carry a lower `seq` after a
  /// bridge restart.
  mutating func apply(_ record: Record, now: Date = .now) {
    if record.type == "result", let epoch = record.result?.epoch { self.epoch = epoch }
    guard record.type == "event", let seq = record.seq, let name = record.name,
      name == "transcript" || seq > lastSeq
    else { return }
    lastSeq = seq
    let data = record.data
    switch name {
    case "transcript":
      sessionId = data?.sessionId
      replaceAll(with: data?.messages ?? [], runningFor: data?.running == true ? data?.elapsedMs ?? 0 : nil, now: now)
      queue = Queue(data)
    case "runStarted": runStartedAt = now
    case "userMessage": entries.append(.message(makeMessage(.user, text: data?.text ?? "", thinking: "")))
    case "queue": queue = Queue(data)
    case "delta": appendDelta(kind: data?.kind, text: data?.text ?? "")
    case "messageEnd": finishMessage(text: data?.text ?? "", thinking: data?.thinking ?? "")
    case "toolCall": if let data { applyToolCall(data) }
    case "runSettled": settleRun(data)
    default: break
    }
  }

  /// `runningFor` is how long the active run has been going, nil if idle.
  private mutating func replaceAll(
    with wire: [Record.EventData.WireMessage], runningFor elapsedMs: Int?, now: Date
  ) {
    entries = []
    for message in wire {
      switch message.role {
      case "user", "assistant":
        var next = makeMessage(
          message.role == "user" ? .user : .assistant, text: message.text ?? "",
          thinking: message.thinking ?? "")
        next.isStreaming = message.streaming ?? false
        entries.append(.message(next))
      case "toolCall":
        guard let callId = message.toolCallId else { continue }
        let index = appendToolCall(callId: callId, name: message.toolName ?? "")
        guard case .toolCall(var call) = entries[index] else { continue }
        call.args = message.args
        call.output = message.output ?? ""
        if let isError = message.isError { call.status = isError ? .failed : .succeeded }
        entries[index] = .toolCall(call)
      default:
        continue  // an entry kind this app does not know
      }
    }
    runStartedAt = elapsedMs.map { now.addingTimeInterval(-Double($0) / 1000) }
  }

  private mutating func appendDelta(kind: String?, text: String) {
    let index = streamingIndex ?? appendStreamingMessage()
    editMessage(at: index) { message in
      if kind == "thinking" { message.thinking += text } else { message.text += text }
    }
  }

  private mutating func finishMessage(text: String, thinking: String) {
    if let index = streamingIndex {
      editMessage(at: index) {
        $0.text = text
        $0.thinking = thinking
        $0.isStreaming = false
      }
    } else if !text.isEmpty || !thinking.isEmpty {  // a turn that only called tools shows nothing
      entries.append(.message(makeMessage(.assistant, text: text, thinking: thinking)))
    }
  }

  /// Applies a tool phase to its card, creating the card if its `start` was never seen
  /// (e.g. the snapshot this client joined from was taken mid-call).
  private mutating func applyToolCall(_ data: Record.EventData) {
    guard let callId = data.toolCallId else { return }
    let index = toolCallIndex(callId) ?? appendToolCall(callId: callId, name: data.toolName ?? "")
    guard case .toolCall(var call) = entries[index] else { return }
    if let args = data.args { call.args = args }
    if let output = data.output { call.output = output }
    if data.phase == "end" {
      call.status = data.isError == true ? .failed : .succeeded
      call.durationMs = data.durationMs
    }
    entries[index] = .toolCall(call)
  }

  private mutating func settleRun(_ data: Record.EventData?) {
    runStartedAt = nil
    if let index = streamingIndex { editMessage(at: index) { $0.isStreaming = false } }
    // A reason this app does not know is surfaced as an error rather than as a success.
    let reason = data?.stopReason.flatMap(StopReason.init) ?? .error
    defer { nextId += 1 }
    entries.append(
      .run(
        Run(
          id: nextId, stopReason: reason, durationMs: data?.durationMs ?? 0,
          errorMessage: data?.errorMessage)))
  }

  /// A streaming message is always the newest entry: tool calls and runs only follow `messageEnd`.
  private var streamingIndex: Int? {
    guard case .message(let message)? = entries.last, message.isStreaming else { return nil }
    return entries.count - 1
  }

  private func toolCallIndex(_ callId: String) -> Int? {
    entries.lastIndex { if case .toolCall(let call) = $0 { call.callId == callId } else { false } }
  }

  private mutating func appendStreamingMessage() -> Int {
    entries.append(.message(makeMessage(.assistant, text: "", thinking: "", isStreaming: true)))
    return entries.count - 1
  }

  private mutating func appendToolCall(callId: String, name: String) -> Int {
    entries.append(.toolCall(ToolCall(id: nextId, callId: callId, name: name)))
    nextId += 1
    return entries.count - 1
  }

  private mutating func editMessage(at index: Int, _ edit: (inout Message) -> Void) {
    guard case .message(var message) = entries[index] else { return }
    edit(&message)
    entries[index] = .message(message)
  }

  private mutating func makeMessage(
    _ role: Message.Role, text: String, thinking: String, isStreaming: Bool = false
  ) -> Message {
    defer { nextId += 1 }
    return Message(id: nextId, role: role, text: text, thinking: thinking, isStreaming: isStreaming)
  }
}

extension Transcript.Queue {
  /// The queue a `queue` event or `transcript` snapshot describes; absent lists are empty.
  fileprivate init(_ data: Record.EventData?) {
    self.init(steering: data?.steering ?? [], followUp: data?.followUp ?? [])
  }
}
