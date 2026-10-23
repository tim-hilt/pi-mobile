import Testing

@testable import PiClient

@Test func appSpeaksProtocolVersion2() {
  #expect(BridgeProtocol.version == 2)
}
