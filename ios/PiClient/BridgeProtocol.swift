import Foundation

/// Bridge Protocol wire format. See docs/protocol.md.
enum BridgeProtocol {
  /// Version negotiated on connect.
  static let version = 1

  /// Newline-terminated `hello` command: the mandatory first record of a connection.
  static func helloFrame(id: Int, lastSeq: Int) -> String {
    #"{"type":"command","id":\#(id),"name":"hello","params":{"protocolVersion":\#(version),"lastSeq":\#(lastSeq)}}"#
      + "\n"
  }

  /// Splits one text frame into its records. Throws if any record is not valid JSON.
  static func records(in frame: String) throws -> [Record] {
    try frame.split(separator: "\n").map { try JSONDecoder().decode(Record.self, from: Data($0.utf8)) }
  }
}

/// `error` payload of `result` records and top-level `error` records.
struct ProtocolError: Codable, Equatable, Sendable {
  let code: String
  let message: String
}

/// A bridge → app record. Only the fields the app currently reads are decoded.
struct Record: Decodable, Sendable {
  /// `result`, `event` or `error`.
  let type: String
  /// Echoed command id (`result` only).
  let id: Int?
  let error: ProtocolError?
  /// `hello` result payload.
  let result: HelloResult?

  struct HelloResult: Decodable, Sendable {
    let protocolVersion: Int?
  }
}
