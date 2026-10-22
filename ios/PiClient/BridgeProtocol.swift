import Foundation

/// Bridge Protocol wire format. See docs/protocol.md.
enum BridgeProtocol {
  /// Version negotiated on connect.
  static let version = 1

  /// Newline-terminated `hello` command: the mandatory first record of a connection.
  static func helloFrame(id: Int, lastSeq: Int) -> String {
    commandFrame(id: id, name: "hello", params: ["protocolVersion": .number(Double(version)), "lastSeq": .number(Double(lastSeq))])
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

  struct CommandResult: Decodable, Sendable {
    /// `hello`.
    let protocolVersion: Int?
    /// `clearQueue`: the texts dropped.
    let steering: [String]?
    let followUp: [String]?

    init(protocolVersion: Int? = nil, steering: [String]? = nil, followUp: [String]? = nil) {
      self.protocolVersion = protocolVersion
      self.steering = steering
      self.followUp = followUp
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
    /// `transcript` snapshot.
    let messages: [WireMessage]?
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

    struct WireMessage: Decodable, Sendable {
      let role: String
      let text: String
      let thinking: String?
      let streaming: Bool?
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
