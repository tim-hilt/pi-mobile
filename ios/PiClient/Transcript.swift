import Foundation

/// The conversation as the user reads it, built purely from bridge `event` records.
///
/// Streamed `delta`s grow a provisional assistant message; its `messageEnd` replaces it with the
/// authoritative text, and a `transcript` snapshot replaces everything. `lastSeq` is the replay
/// cursor to present on the next (re)connect.
struct Transcript: Equatable, Sendable {
  struct Message: Equatable, Identifiable, Sendable {
    enum Role: Sendable { case user, assistant }

    let id: Int
    let role: Role
    fileprivate(set) var text: String
    fileprivate(set) var thinking: String
    /// Still being generated: `text` is the deltas so far, not yet authoritative.
    fileprivate(set) var isStreaming: Bool
  }

  private(set) var messages: [Message] = []
  /// Whether the agent is working on a run right now.
  private(set) var isRunning = false
  /// `seq` of the newest event applied; 0 before any.
  private(set) var lastSeq = 0

  private var nextId = 0

  /// Applies one record; anything that is not an event is ignored. Events at or below `lastSeq`
  /// (already seen, e.g. replayed twice) are skipped, except snapshots, which are authoritative
  /// and may legitimately carry a lower `seq` after a bridge restart.
  mutating func apply(_ record: Record) {
    guard record.type == "event", let seq = record.seq, let name = record.name else { return }
    let data = record.data
    if name == "transcript" {
      replaceAll(with: data?.messages ?? [], running: data?.running ?? false)
    } else if seq > lastSeq {
      switch name {
      case "runStarted": isRunning = true
      case "delta": appendDelta(kind: data?.kind, text: data?.text ?? "")
      case "messageEnd": finishMessage(text: data?.text ?? "", thinking: data?.thinking ?? "")
      case "runSettled":
        isRunning = false
        if let last = messages.indices.last { messages[last].isStreaming = false }
      default: break
      }
    }
    lastSeq = seq
  }

  private mutating func replaceAll(with wire: [Record.EventData.WireMessage], running: Bool) {
    messages = []
    for message in wire {
      var next = makeMessage(
        message.role == "user" ? .user : .assistant, text: message.text,
        thinking: message.thinking ?? "")
      next.isStreaming = message.streaming ?? false
      messages.append(next)
    }
    isRunning = running
  }

  private mutating func appendDelta(kind: String?, text: String) {
    if messages.last?.isStreaming != true {
      messages.append(makeMessage(.assistant, text: "", thinking: "", isStreaming: true))
    }
    let last = messages.count - 1
    if kind == "thinking" { messages[last].thinking += text } else { messages[last].text += text }
  }

  private mutating func finishMessage(text: String, thinking: String) {
    if let last = messages.indices.last, messages[last].isStreaming {
      messages[last].text = text
      messages[last].thinking = thinking
      messages[last].isStreaming = false
    } else {
      messages.append(makeMessage(.assistant, text: text, thinking: thinking))
    }
  }

  private mutating func makeMessage(
    _ role: Message.Role, text: String, thinking: String, isStreaming: Bool = false
  ) -> Message {
    defer { nextId += 1 }
    return Message(id: nextId, role: role, text: text, thinking: thinking, isStreaming: isStreaming)
  }
}
