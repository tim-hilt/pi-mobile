import Foundation
import Testing

@testable import PiMobile

@Suite(.serialized) struct ConnectionStoreTests {
  @Test func persistsConfigAcrossInstances() throws {
    let service = "dev.timhilt.PiMobileTests.\(UUID().uuidString)"
    defer { ConnectionStore(service: service).clear() }

    #expect(ConnectionStore(service: service).load() == nil)

    let config = BridgeConfig(url: URL(string: "wss://pi.example.com")!, token: "s3cret")
    try ConnectionStore(service: service).save(config)
    #expect(ConnectionStore(service: service).load() == config)

    let updated = BridgeConfig(url: URL(string: "ws://192.168.1.5:8080")!, token: "other")
    try ConnectionStore(service: service).save(updated)
    #expect(ConnectionStore(service: service).load() == updated)
  }
}
