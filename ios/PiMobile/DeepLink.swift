import Foundation

/// A `pimobile://` URL: opened from outside the app, or scanned as the pairing QR code.
enum DeepLink: Equatable {
  /// The bridge's pairing QR code (`pimobile://connect?url=…&token=…`), as `bridge/src/pairing.ts`
  /// writes it.
  case pair(BridgeConfig)
  /// A tapped ntfy notification (`pimobile://session?id=…`): show that session.
  case session(String)

  /// Nil for anything the app does not handle.
  init?(url: URL) {
    guard url.scheme == "pimobile", let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
    else { return nil }
    let value = { (name: String) in items.first { $0.name == name }?.value.flatMap { $0.isEmpty ? nil : $0 } }
    switch url.host {
    case "connect":
      guard let address = value("url"), let bridge = URL(string: address), ["ws", "wss"].contains(bridge.scheme),
        bridge.host != nil, let token = value("token")
      else { return nil }
      self = .pair(BridgeConfig(url: bridge, token: token))
    case "session":
      guard let id = value("id") else { return nil }
      self = .session(id)
    default:
      return nil
    }
  }
}
