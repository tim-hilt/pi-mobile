import Foundation
import Security

/// Persists the `BridgeConfig` in the Keychain (it contains the secret token).
struct ConnectionStore {
  /// Keychain service namespace; tests pass a unique one for isolation.
  let service: String

  init(service: String = "dev.timhilt.PiClient.bridge") {
    self.service = service
  }

  func load() -> BridgeConfig? {
    var query = baseQuery
    query[kSecReturnData] = true
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data
    else { return nil }
    return try? JSONDecoder().decode(BridgeConfig.self, from: data)
  }

  /// Replaces any stored config.
  func save(_ config: BridgeConfig) throws {
    clear()
    var query = baseQuery
    query[kSecValueData] = try JSONEncoder().encode(config)
    query[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlock
    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else { throw KeychainError(status: status) }
  }

  func clear() {
    SecItemDelete(baseQuery as CFDictionary)
  }

  private var baseQuery: [CFString: Any] {
    [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: "config"]
  }

  struct KeychainError: Error { let status: OSStatus }
}
