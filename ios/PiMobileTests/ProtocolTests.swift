import Testing

@testable import PiMobile

@Test func appSpeaksProtocolVersion2() {
  #expect(BridgeProtocol.version == 2)
}
