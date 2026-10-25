import Testing

@testable import PiMobile

@Test func appSpeaksProtocolVersion3() {
  #expect(BridgeProtocol.version == 3)
}
