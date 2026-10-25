import Foundation
import Testing

@testable import PiMobile

@Suite struct PairingTests {
  @Test func parsesPairingURL() {
    let url = URL(string: "pimobile://connect?url=wss%3A%2F%2Fpi.example.com&token=a%20b%26c")!
    #expect(DeepLink(url: url) == .pair(BridgeConfig(url: URL(string: "wss://pi.example.com")!, token: "a b&c")))
  }

  /// Lets the Camera app open scanned pairing codes in Pi Mobile.
  @Test func registersPairingScheme() {
    let types = Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]] ?? []
    let schemes = types.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
    #expect(schemes.contains("pimobile"))
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
    #expect(DeepLink(url: URL(string: code)!) == nil)
  }
}
