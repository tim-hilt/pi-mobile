import Testing

@testable import PiClient

@Test func appSpeaksProtocolVersion1() {
  #expect(BridgeProtocol.version == 1)
}
