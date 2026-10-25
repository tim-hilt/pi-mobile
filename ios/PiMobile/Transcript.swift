import Foundation

/// The conversation as the user reads it, built from the joined session's events.
///
/// `entries` is the timeline: messages, the tool calls each turn made, and how each run ended.
/// Streamed `delta`s grow the provisional `streaming` message, which follows the entries; its
/// `messageEnd` moves it into them with the authoritative text. A `transcript` snapshot replaces
/// everything (snapshots carry no past runs or tool durations, so those only appear for what was
/// seen live or replayed). Joining a session, or pi switching it, arrives as such a snapshot,
/// which also moves the cursor to the new session's `seq`. `epoch` and `lastSeq` form the replay
/// cursor to present on rejoining.
struct Transcript: Equatable, Sendable {
  struct Message: Equatable, Identifiable, Sendable {
    enum Role: Sendable { case user, assistant }

    let id: Int
    let role: Role
    fileprivate(set) var text: String
    /// The reasoning trace of this turn.
    fileprivate(set) var thinking: String
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

  /// What a status bar shows about the session, as pi's footer does.
  struct Status: Equatable, Sendable {
    /// Id of the active model; nil when none is selected, as are the model fields below.
    var model: String?
    var provider: String?
    /// Human-readable name of the active model.
    var modelName: String?
    /// How hard the active model thinks, e.g. `medium`; `off` for models that can't.
    var thinkingLevel: String?
    /// The levels the active model supports, weakest first.
    var thinkingLevels: [String] = []
    /// Tokens the context holds; nil while unknown (e.g. right after compaction) or without a model.
    var contextTokens: Int?
    /// Size of the active model's context window; nil without a model.
    var contextWindow: Int?
    /// Price of the whole session so far, in USD.
    var cost = 0.0

    /// Context fill against the window, e.g. `18.8k/1.0M` (`?` while unknown); nil without a model.
    var contextUsage: String? {
      guard let contextWindow else { return nil }
      return "\(contextTokens.map(Self.tokens) ?? "?")/\(Self.tokens(contextWindow))"
    }

    /// Token count with one decimal, as the user's pi footer writes it: `999`, `18.8k`, `1.0M`.
    private static func tokens(_ count: Int) -> String {
      switch count {
      case ..<1_000: "\(count)"
      case ..<1_000_000: String(format: "%.1fk", Double(count) / 1_000)
      default: String(format: "%.1fM", Double(count) / 1_000_000)
      }
    }
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
  /// The assistant message being generated, after `entries`: its deltas so far, not yet
  /// authoritative. Kept apart so each delta appends in place.
  private(set) var streaming: Message?
  /// When the active run began, or nil when idle. For a run joined midway it is reconstructed
  /// from the snapshot; a run replayed after a reconnect is dated from its replay.
  private(set) var runStartedAt: Date?
  /// What is waiting to be delivered to the agent.
  private(set) var queue = Queue()
  /// Model, context and price of the session shown.
  private(set) var status = Status()
  /// The session shown, as of the latest snapshot; nil before the first.
  private(set) var sessionId: String?
  /// The working directory of the session shown.
  private(set) var cwd: String?
  /// Pi stopped sharing the session shown: it is no longer live and can't be driven.
  private(set) var hasEnded = false
  /// `seq` of the newest event applied; 0 before any.
  private(set) var lastSeq = 0
  /// The share `lastSeq` counts in: the epoch of the latest `joinSession` result; nil before the first.
  var epoch: String?

  private var nextId = 0

  /// Whether the agent is working on a run right now.
  var isRunning: Bool { runStartedAt != nil }

  /// Applies event `seq` of the joined session, received at `now`. Events at or below `lastSeq`
  /// (already seen, e.g. replayed twice) are skipped, except snapshots, which are authoritative
  /// and may legitimately carry a lower `seq` after a bridge restart.
  mutating func apply(_ event: SessionEvent, seq: Int, now: Date = .now) {
    if case .transcript = event {} else if seq <= lastSeq { return }
    lastSeq = seq
    switch event {
    case .transcript(let snapshot): replaceAll(with: snapshot, now: now)
    case .runStarted: runStartedAt = now
    case .userMessage(let text): entries.append(.message(makeMessage(.user, text: text, thinking: "")))
    case .queue(let queue): self.queue = queue
    case .status(let status): self.status = status
    case .delta(let isThinking, let text):
      if streaming == nil { streaming = makeMessage(.assistant, text: "", thinking: "") }
      if isThinking { streaming?.thinking += text } else { streaming?.text += text }
    case .messageEnd(let text, let thinking): finishMessage(text: text, thinking: thinking)
    case .toolCall(let phase): applyToolCall(phase)
    case .runSettled(let stopReason, let durationMs, let errorMessage):
      settleRun(stopReason: stopReason, durationMs: durationMs, errorMessage: errorMessage)
    case .sessionEnded: markEnded()
    }
  }

  /// The session shown is gone (pi quit, or it ended while we were away).
  mutating func markEnded() {
    hasEnded = true
    runStartedAt = nil
    endStreaming()
  }

  private mutating func replaceAll(with snapshot: SessionEvent.Snapshot, now: Date) {
    sessionId = snapshot.sessionId
    cwd = snapshot.cwd
    hasEnded = false
    queue = snapshot.queue
    status = snapshot.status
    entries = []
    streaming = nil
    for entry in snapshot.messages {
      switch entry {
      case .user(let text):
        entries.append(.message(makeMessage(.user, text: text, thinking: "")))
      case .assistant(let text, let thinking, streaming: false):
        entries.append(.message(makeMessage(.assistant, text: text, thinking: thinking)))
      case .assistant(let text, let thinking, streaming: true):
        streaming = makeMessage(.assistant, text: text, thinking: thinking)
      case .toolCall(let callId, let name, let args, let output, let isError):
        var call = ToolCall(id: takeId(), callId: callId, name: name)
        call.args = args
        call.output = output ?? ""
        if let isError { call.status = isError ? .failed : .succeeded }
        entries.append(.toolCall(call))
      case .other:
        continue
      }
    }
    runStartedAt =
      snapshot.running ? now.addingTimeInterval(-Double(snapshot.elapsedMs ?? 0) / 1000) : nil
  }

  private mutating func finishMessage(text: String, thinking: String) {
    if var message = streaming {
      streaming = nil
      message.text = text
      message.thinking = thinking
      entries.append(.message(message))
    } else if !text.isEmpty || !thinking.isEmpty {  // a turn that only called tools shows nothing
      entries.append(.message(makeMessage(.assistant, text: text, thinking: thinking)))
    }
  }

  /// Applies a tool phase to its card, creating the card if its `start` was never seen
  /// (e.g. the snapshot this client joined from was taken mid-call).
  private mutating func applyToolCall(_ phase: SessionEvent.ToolCallPhase) {
    let index =
      entries.lastIndex { if case .toolCall(let call) = $0 { call.callId == phase.toolCallId } else { false } }
      ?? appendToolCall(callId: phase.toolCallId, name: phase.toolName)
    guard case .toolCall(var call) = entries[index] else { return }
    if let args = phase.args { call.args = args }
    if let output = phase.output { call.output = output }
    if phase.isEnd {
      call.status = phase.isError == true ? .failed : .succeeded
      call.durationMs = phase.durationMs
    }
    entries[index] = .toolCall(call)
  }

  private mutating func settleRun(stopReason: String, durationMs: Int?, errorMessage: String?) {
    runStartedAt = nil
    endStreaming()
    // A reason this app does not know is surfaced as an error rather than as a success.
    let reason = StopReason(rawValue: stopReason) ?? .error
    entries.append(
      .run(Run(id: takeId(), stopReason: reason, durationMs: durationMs ?? 0, errorMessage: errorMessage)))
  }

  /// Keeps what was streamed of a message that will never end.
  private mutating func endStreaming() {
    if let message = streaming { entries.append(.message(message)) }
    streaming = nil
  }

  private mutating func appendToolCall(callId: String, name: String) -> Int {
    entries.append(.toolCall(ToolCall(id: takeId(), callId: callId, name: name)))
    return entries.count - 1
  }

  private mutating func makeMessage(_ role: Message.Role, text: String, thinking: String) -> Message {
    Message(id: takeId(), role: role, text: text, thinking: thinking)
  }

  /// An entry id unique within this transcript.
  private mutating func takeId() -> Int {
    defer { nextId += 1 }
    return nextId
  }
}
