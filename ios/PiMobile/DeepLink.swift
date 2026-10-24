import Foundation

/// A `pimobile://` URL the app was opened with.
enum DeepLink: Equatable {
  /// The bridge's pairing QR code (`pimobile://connect?url=…&token=…`).
  case pair(BridgeConfig)
  /// A tapped ntfy notification (`pimobile://session?id=…`): show that session.
  case session(String)

  /// Nil for anything the app does not handle.
  init?(url: URL) {
    if let config = BridgeConfig(pairingURL: url) {
      self = .pair(config)
    } else if url.scheme == "pimobile", url.host == "session",
      let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
        .first(where: { $0.name == "id" })?.value, !id.isEmpty
    {
      self = .session(id)
    } else {
      return nil
    }
  }
}
