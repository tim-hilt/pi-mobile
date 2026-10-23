import Foundation

/// Bridge Protocol wire format. See docs/protocol.md.
enum BridgeProtocol {
  /// Version negotiated on connect.
  static let version = 2

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

  /// Splits one text frame into its records. Throws if any record is not valid JSON.
  static func records(in frame: String) throws -> [Record] {
    try frame.split(separator: "\n").map { try JSONDecoder().decode(Record.self, from: Data($0.utf8)) }
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

/// A pi session running on the Mac, as listed for joining.
struct LiveSession: Decodable, Equatable, Identifiable, Sendable {
  let id: String
  /// The user-given name, if any.
  let name: String?
  /// The session's working directory.
  let cwd: String
  /// The session's first user message; empty while there is none.
  let preview: String
  /// Whether a run is active.
  let running: Bool
  /// When the session last did anything.
  let activeAt: Date

  /// What to call the session in a list: its name, else how it began.
  var title: String { name ?? (preview.isEmpty ? "New session" : preview) }

  init(id: String, name: String?, cwd: String, preview: String, running: Bool, activeAt: Date) {
    self.id = id
    self.name = name
    self.cwd = cwd
    self.preview = preview
    self.running = running
    self.activeAt = activeAt
  }

  private enum CodingKeys: String, CodingKey { case id, name, cwd, preview, running, activeAt }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decode(String.self, forKey: .id)
    name = try values.decodeIfPresent(String.self, forKey: .name)
    cwd = try values.decode(String.self, forKey: .cwd)
    preview = try values.decode(String.self, forKey: .preview)
    running = try values.decode(Bool.self, forKey: .running)
    // The bridge sends ISO 8601 with milliseconds, which the plain strategy does not parse.
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let text = try values.decode(String.self, forKey: .activeAt)
    guard let date = formatter.date(from: text) else {
      throw DecodingError.dataCorruptedError(
        forKey: .activeAt, in: values, debugDescription: "not an ISO 8601 date: \(text)")
    }
    activeAt = date
  }
}

/// `getSessions` result: the live sessions, most recently active first.
struct SessionList: Equatable, Sendable {
  let sessions: [LiveSession]
  /// The session this connection is joined to, if any.
  let joinedId: String?
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

/// A bridge → app record. Only the fields the app currently reads are decoded.
struct Record: Decodable, Sendable {
  /// `result`, `event` or `error`.
  let type: String
  /// Echoed command id (`result` only).
  let id: Int?
  let error: ProtocolError?
  /// `result` payload; each command sets its own subset.
  let result: CommandResult?
  /// Event sequence number (`event` only).
  let seq: Int?
  /// Event name, e.g. `delta` (`event` only).
  let name: String?
  let data: EventData?

  struct CommandResult: Sendable {
    /// `hello`.
    let protocolVersion: Int?
    /// `joinSession`: the share of the session that event `seq`s count in.
    let epoch: String?
    /// `hello`: where settled runs are announced; absent when the bridge does not announce them.
    let ntfy: NtfyTopic?
    /// `listSkills`.
    let skills: [Skill]?
    /// `searchFiles`: paths relative to the session's working directory, best first.
    let files: [String]?
    /// `getSessions`.
    let sessions: [LiveSession]?
    let joinedId: String?
    /// `getStats`: present when the payload has every stats field.
    let stats: SessionStats?

    init(
      protocolVersion: Int? = nil, epoch: String? = nil, ntfy: NtfyTopic? = nil, skills: [Skill]? = nil,
      files: [String]? = nil, sessions: [LiveSession]? = nil, joinedId: String? = nil, stats: SessionStats? = nil
    ) {
      self.protocolVersion = protocolVersion
      self.epoch = epoch
      self.ntfy = ntfy
      self.skills = skills
      self.files = files
      self.sessions = sessions
      self.joinedId = joinedId
      self.stats = stats
    }
  }

  /// Union of the `data` fields of the events the app renders; each event sets its own subset.
  struct EventData: Decodable, Sendable {
    /// `delta`: `text` or `thinking`.
    let kind: String?
    /// `delta` increment, `messageEnd` authoritative text, or `userMessage` text.
    let text: String?
    let thinking: String?
    /// `queue` event and `transcript` snapshot: the messages waiting to be delivered.
    let steering: [String]?
    let followUp: [String]?
    /// `status` event and `transcript` snapshot: the active model, how full its context is, and
    /// the session's price (USD).
    let model: String?
    let contextTokens: Int?
    let contextWindow: Int?
    let cost: Double?
    /// `transcript` snapshot.
    let messages: [WireMessage]?
    /// `transcript` snapshot and `sessionEnded`: the session concerned.
    let sessionId: String?
    /// `transcript` snapshot: the session's working directory.
    let cwd: String?
    let running: Bool?
    /// `transcript` snapshot: how long the active run has been going.
    let elapsedMs: Int?
    /// `toolCall`: `start`, `update` or `end`; `output` is absent on `start`.
    let phase: String?
    let toolCallId: String?
    let toolName: String?
    let args: JSONValue?
    let output: String?
    let isError: Bool?
    /// `toolCall` `end` (absent if the tool never ran) and `runSettled`.
    let durationMs: Int?
    /// `runSettled`: `success`, `error`, `aborted` or `length`.
    let stopReason: String?
    let errorMessage: String?

    /// A `transcript` snapshot entry: a message, or a tool call (`role` `toolCall`).
    struct WireMessage: Decodable, Sendable {
      /// `user`, `assistant` or `toolCall`.
      let role: String
      let text: String?
      let thinking: String?
      let streaming: Bool?
      /// `toolCall` entries, as in the `toolCall` event; `isError` is absent until it finished.
      let toolCallId: String?
      let toolName: String?
      let args: JSONValue?
      let output: String?
      let isError: Bool?
    }
  }
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

extension Record.CommandResult: Decodable {
  private enum CodingKeys: String, CodingKey {
    case protocolVersion, epoch, ntfy, skills, files, sessions, joinedId
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    self.init(
      protocolVersion: try values.decodeIfPresent(Int.self, forKey: .protocolVersion),
      epoch: try values.decodeIfPresent(String.self, forKey: .epoch),
      ntfy: try values.decodeIfPresent(NtfyTopic.self, forKey: .ntfy),
      skills: try values.decodeIfPresent([Skill].self, forKey: .skills),
      files: try values.decodeIfPresent([String].self, forKey: .files),
      sessions: try values.decodeIfPresent([LiveSession].self, forKey: .sessions),
      joinedId: try values.decodeIfPresent(String.self, forKey: .joinedId),
      // `getStats` flattens its fields into the result.
      stats: try? SessionStats(from: decoder))
  }
}
