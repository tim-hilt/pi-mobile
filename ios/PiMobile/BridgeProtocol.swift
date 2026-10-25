import Foundation

/// Bridge Protocol wire format. See docs/protocol.md.
enum BridgeProtocol {
  /// Version negotiated on connect.
  static let version = 3

  /// Newline-terminated `hello` command: the mandatory first record of a connection.
  static func helloFrame(id: Int) -> String {
    commandFrame(id: id, name: "hello", params: ["protocolVersion": .number(Double(version))])
  }

  /// Newline-terminated `command` record.
  static func commandFrame(id: Int, name: String, params: [String: JSONValue] = [:]) -> String {
    struct Command: Encodable {
      let type = "command"
      let id: Int
      let name: String
      let params: [String: JSONValue]
    }
    let json = try? JSONEncoder().encode(Command(id: id, name: name, params: params))
    return (json.flatMap { String(data: $0, encoding: .utf8) } ?? "") + "\n"
  }

  /// Splits one text frame into its records, skipping records and events this app does not know.
  /// Throws if any record is not valid JSON or lacks what its type requires.
  static func records(in frame: String) throws -> [Record] {
    try frame.split(separator: "\n").compactMap { line in
      let json = Data(line.utf8)
      return try decoder.decode(WireRecord.self, from: json).record(json: json)
    }
  }

  /// The `result` of a `result` record (`json`, as `Record.result` carries it), or the result's
  /// `field` if given.
  static func result<Value: Decodable>(_: Value.Type, field: Field? = nil, from json: Data) throws -> Value {
    let decoder = JSONDecoder()
    decoder.userInfo[ResultPayload<Value>.field] = field
    return try decoder.decode(ResultPayload<Value>.self, from: json).value
  }

  private static let decoder = JSONDecoder()

  /// Every field name the app reads off the wire, records and data alike: one key type keeps the
  /// decoding code small.
  enum Field: String, CodingKey {
    case type, id, error, result, seq, name, data
    case sessions, epoch, protocolVersion, skills, models, files
    case sessionId, cwd, messages, running, elapsedMs, steering, followUp
    case model, contextTokens, contextWindow, cost
    case role, text, thinking, streaming, kind
    case phase, toolCallId, toolName, args, output, isError, durationMs
    case stopReason, errorMessage
  }
}

/// A bridge → app record.
enum Record: Sendable {
  /// Answers command `id`: the record's JSON, to decode the result from with `BridgeProtocol.result`,
  /// or the bridge's refusal.
  case result(id: Int, Result<Data, ProtocolError>)
  /// An event of the joined session, numbered within it.
  case event(seq: Int, SessionEvent)
  /// The live sessions, most recently active first, pushed whenever they change.
  case sessions([LiveSession])
  /// A connection-level failure; the bridge closes the socket after it.
  case error(ProtocolError)
}

/// An event of the joined session, by name, with the `data` the app reads.
enum SessionEvent: Sendable {
  /// Everything about the session at once; replaces what the app held.
  case transcript(Snapshot)
  case runStarted
  /// A user message entered the conversation.
  case userMessage(String)
  case queue(Transcript.Queue)
  case status(Transcript.Status)
  /// An increment to the message being generated.
  case delta(isThinking: Bool, text: String)
  /// The authoritative completed assistant message; replaces its deltas.
  case messageEnd(text: String, thinking: String)
  case toolCall(ToolCallPhase)
  /// `stopReason`: `success`, `error`, `aborted` or `length`.
  case runSettled(stopReason: String, durationMs: Int?, errorMessage: String?)
  case sessionEnded

  /// One phase (`start`, `update` or `end`) of a tool execution.
  struct ToolCallPhase: Sendable {
    let isEnd: Bool
    let toolCallId: String
    let toolName: String
    /// `start` only.
    let args: JSONValue?
    /// Output so far (`update`) or in full (`end`); absent on `start`.
    let output: String?
    /// `end` only.
    let isError: Bool?
    /// `end` only, and absent if the tool never ran.
    let durationMs: Int?
  }

  /// `transcript` event data.
  struct Snapshot: Sendable {
    /// The session shown.
    let sessionId: String?
    /// Its working directory.
    let cwd: String?
    /// The whole conversation, oldest first.
    let messages: [Entry]
    let running: Bool
    /// How long the active run has been going.
    let elapsedMs: Int?
    let queue: Transcript.Queue
    let status: Transcript.Status

    /// A snapshot entry: a message, or a tool call after the turn that made it.
    enum Entry: Sendable {
      case user(text: String)
      /// `streaming`: still being generated; only ever the last entry.
      case assistant(text: String, thinking: String, streaming: Bool)
      /// As in the `toolCall` event; `isError` is absent until the tool finished.
      case toolCall(id: String, name: String, args: JSONValue?, output: String?, isError: Bool?)
      /// An entry kind this app does not know.
      case other
    }
  }
}

/// One line of a frame, decoded in a single pass into what `Record` needs.
private struct WireRecord: Decodable {
  private typealias Values = KeyedDecodingContainer<BridgeProtocol.Field>

  private let type: String
  private let id: Int?
  private let error: ProtocolError?
  private let seq: Int?
  private let event: SessionEvent?
  private let sessions: [LiveSession]?

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: BridgeProtocol.Field.self)
    type = try values.decode(String.self, forKey: .type)
    id = try values.decodeIfPresent(Int.self, forKey: .id)
    error = try values.decodeIfPresent(ProtocolError.self, forKey: .error)
    seq = try values.decodeIfPresent(Int.self, forKey: .seq)
    guard type == "event" else {
      (event, sessions) = (nil, nil)
      return
    }
    let name = try values.decode(String.self, forKey: .name)
    let data = try values.nestedContainer(keyedBy: BridgeProtocol.Field.self, forKey: .data)
    sessions = name == "sessions" ? try data.decode([LiveSession].self, forKey: .sessions) : nil
    event =
      switch name {
      case "transcript": .transcript(try Self.snapshot(data))
      case "runStarted": .runStarted
      case "userMessage": .userMessage(try data.decode(String.self, forKey: .text))
      case "queue": .queue(try Self.queue(data))
      case "status": .status(try Self.status(data))
      case "delta":
        .delta(
          isThinking: try data.decode(String.self, forKey: .kind) == "thinking",
          text: try data.decode(String.self, forKey: .text))
      case "messageEnd":
        .messageEnd(
          text: try data.decode(String.self, forKey: .text),
          thinking: try data.decode(String.self, forKey: .thinking))
      case "toolCall": .toolCall(try Self.toolCall(data))
      case "runSettled":
        .runSettled(
          stopReason: try data.decode(String.self, forKey: .stopReason),
          durationMs: try data.decodeIfPresent(Int.self, forKey: .durationMs),
          errorMessage: try data.decodeIfPresent(String.self, forKey: .errorMessage))
      case "sessionEnded": .sessionEnded
      default: nil
      }
  }

  func record(json: Data) -> Record? {
    switch type {
    case "result": id.map { .result(id: $0, error.map { .failure($0) } ?? .success(json)) }
    case "error": error.map { .error($0) }
    case "event":
      if let sessions { .sessions(sessions) } else if let seq, let event { .event(seq: seq, event) } else { nil }
    default: nil
    }
  }

  private static func toolCall(_ data: Values) throws -> SessionEvent.ToolCallPhase {
    SessionEvent.ToolCallPhase(
      isEnd: try data.decode(String.self, forKey: .phase) == "end",
      toolCallId: try data.decode(String.self, forKey: .toolCallId),
      toolName: try data.decodeIfPresent(String.self, forKey: .toolName) ?? "",
      args: try data.decodeIfPresent(JSONValue.self, forKey: .args),
      output: try data.decodeIfPresent(String.self, forKey: .output),
      isError: try data.decodeIfPresent(Bool.self, forKey: .isError),
      durationMs: try data.decodeIfPresent(Int.self, forKey: .durationMs))
  }

  /// Absent lists are empty.
  private static func queue(_ data: Values) throws -> Transcript.Queue {
    Transcript.Queue(
      steering: try data.decodeIfPresent([String].self, forKey: .steering) ?? [],
      followUp: try data.decodeIfPresent([String].self, forKey: .followUp) ?? [])
  }

  private static func status(_ data: Values) throws -> Transcript.Status {
    Transcript.Status(
      model: try data.decodeIfPresent(String.self, forKey: .model),
      contextTokens: try data.decodeIfPresent(Int.self, forKey: .contextTokens),
      contextWindow: try data.decodeIfPresent(Int.self, forKey: .contextWindow),
      cost: try data.decodeIfPresent(Double.self, forKey: .cost) ?? 0)
  }

  private static func snapshot(_ data: Values) throws -> SessionEvent.Snapshot {
    var entries: [SessionEvent.Snapshot.Entry] = []
    var list = try data.nestedUnkeyedContainer(forKey: .messages)
    while !list.isAtEnd { entries.append(try entry(list.nestedContainer(keyedBy: BridgeProtocol.Field.self))) }
    return SessionEvent.Snapshot(
      sessionId: try data.decodeIfPresent(String.self, forKey: .sessionId),
      cwd: try data.decodeIfPresent(String.self, forKey: .cwd),
      messages: entries,
      running: try data.decode(Bool.self, forKey: .running),
      elapsedMs: try data.decodeIfPresent(Int.self, forKey: .elapsedMs),
      // The queue and status fields sit flat in the snapshot.
      queue: try queue(data),
      status: try status(data))
  }

  private static func entry(_ values: Values) throws -> SessionEvent.Snapshot.Entry {
    let text = try values.decodeIfPresent(String.self, forKey: .text) ?? ""
    switch try values.decode(String.self, forKey: .role) {
    case "user": return .user(text: text)
    case "assistant":
      return .assistant(
        text: text, thinking: try values.decodeIfPresent(String.self, forKey: .thinking) ?? "",
        streaming: try values.decodeIfPresent(Bool.self, forKey: .streaming) ?? false)
    case "toolCall":
      return .toolCall(
        id: try values.decode(String.self, forKey: .toolCallId),
        name: try values.decodeIfPresent(String.self, forKey: .toolName) ?? "",
        args: try values.decodeIfPresent(JSONValue.self, forKey: .args),
        output: try values.decodeIfPresent(String.self, forKey: .output),
        isError: try values.decodeIfPresent(Bool.self, forKey: .isError))
    default: return .other
    }
  }
}

/// `{ result }`, or the result's field named in `userInfo[field]`.
private struct ResultPayload<Value: Decodable>: Decodable {
  static var field: CodingUserInfoKey { CodingUserInfoKey(rawValue: "field")! }

  let value: Value

  init(from decoder: Decoder) throws {
    let record = try decoder.container(keyedBy: BridgeProtocol.Field.self)
    if let field = decoder.userInfo[Self.field] as? BridgeProtocol.Field {
      value = try record.nestedContainer(keyedBy: BridgeProtocol.Field.self, forKey: .result)
        .decode(Value.self, forKey: field)
    } else {
      value = try record.decode(Value.self, forKey: .result)
    }
  }
}

/// `error` payload of `result` records and top-level `error` records.
struct ProtocolError: Codable, Equatable, Sendable, LocalizedError {
  let code: String
  let message: String

  var errorDescription: String? { message }
}

/// A skill the user can invoke with `/skill:<name>`.
struct Skill: Decodable, Equatable, Identifiable, Sendable {
  let name: String
  let description: String

  var id: String { name }
}

/// A model the session can switch to. `id` is unique only within its `provider`.
struct ModelInfo: Decodable, Equatable, Hashable, Sendable {
  let provider: String
  let id: String
  /// Human-readable name.
  let name: String
}

/// A pi session running on the Mac, as listed for joining.
struct LiveSession: Decodable, Equatable, Identifiable, Sendable {
  let id: String
  /// The user-given name, if any.
  let name: String?
  /// The session's working directory.
  let cwd: String
  /// The session's first user message; empty while there is none.
  let preview: String
  let activity: Activity
  /// When the session last did anything.
  let activeAt: Date

  /// What to call the session in a list: its name, else how it began.
  var title: String { name ?? (preview.isEmpty ? "New session" : preview) }

  /// What the session is up to.
  enum Activity: Equatable, Sendable {
    /// A run is active.
    case working
    /// Idle, and its latest run (if any) did not fail. Aborted and cut-off runs count as finished.
    case finished
    /// Idle, and its latest run failed.
    case failed
  }

  private enum CodingKeys: String, CodingKey { case id, name, cwd, preview, running, lastStopReason, activeAt }

  /// The bridge sends ISO 8601 with milliseconds, which the plain strategy does not parse.
  private static let dateFormat = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decode(String.self, forKey: .id)
    name = try values.decodeIfPresent(String.self, forKey: .name)
    cwd = try values.decode(String.self, forKey: .cwd)
    preview = try values.decode(String.self, forKey: .preview)
    activity =
      if try values.decode(Bool.self, forKey: .running) {
        .working
      } else if try values.decodeIfPresent(String.self, forKey: .lastStopReason) == "error" {
        .failed
      } else {
        .finished
      }
    let text = try values.decode(String.self, forKey: .activeAt)
    guard let date = try? Self.dateFormat.parse(text) else {
      throw DecodingError.dataCorruptedError(
        forKey: .activeAt, in: values, debugDescription: "not an ISO 8601 date: \(text)")
    }
    activeAt = date
  }
}

/// `getStats` result for the current session.
struct SessionStats: Decodable, Equatable, Sendable {
  let userMessages: Int
  let assistantMessages: Int
  let toolCalls: Int
  /// Total tokens consumed over the whole session.
  let tokens: Int
  let cost: Double
  /// Runs the bridge has seen settle since the session became current.
  let runs: Int
  /// Their total duration.
  let runDurationMs: Int
}

/// Arbitrary JSON, for payloads the app only displays (tool call arguments).
enum JSONValue: Codable, Equatable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  init(from decoder: Decoder) throws {
    let value = try decoder.singleValueContainer()
    if value.decodeNil() {
      self = .null
    } else if let bool = try? value.decode(Bool.self) {
      self = .bool(bool)
    } else if let number = try? value.decode(Double.self) {
      self = .number(number)
    } else if let string = try? value.decode(String.self) {
      self = .string(string)
    } else if let array = try? value.decode([JSONValue].self) {
      self = .array(array)
    } else {
      self = .object(try value.decode([String: JSONValue].self))
    }
  }

  func encode(to encoder: Encoder) throws {
    var value = encoder.singleValueContainer()
    switch self {
    case .null: try value.encodeNil()
    case .bool(let bool): try value.encode(bool)
    case .number(let number): try value.encode(number)
    case .string(let string): try value.encode(string)
    case .array(let array): try value.encode(array)
    case .object(let object): try value.encode(object)
    }
  }

  /// Pretty-printed JSON with stable key order, for showing to the user.
  var formatted: String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    // Fragments (a bare string or number) are valid since iOS 13.
    return (try? encoder.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
  }
}
