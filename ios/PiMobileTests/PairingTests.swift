import Foundation
import Testing

@testable import PiMobile

@Suite struct PairingTests {
  @Test func parsesPairingURL() {
    let url = URL(string: "pimobile://connect?url=wss%3A%2F%2Fpi.example.com&token=a%20b%26c")!
    #expect(BridgeConfig(pairingURL: url) == BridgeConfig(url: URL(string: "wss://pi.example.com")!, token: "a b&c"))
  }

  @Test(arguments: [
    "https://example.com",
    "pimobile://other?url=wss%3A%2F%2Fpi.example.com&token=t",
    "pimobile://connect?token=t",
    "pimobile://connect?url=wss%3A%2F%2Fpi.example.com",
    "pimobile://connect?url=https%3A%2F%2Fpi.example.com&token=t",
    "pimobile://connect?url=wss%3A%2F%2Fpi.example.com&token=",
  ])
  func rejectsForeignOrIncompleteCodes(_ code: String) {
    #expect(BridgeConfig(pairingURL: URL(string: code)!) == nil)
  }
}
