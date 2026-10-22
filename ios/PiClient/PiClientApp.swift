import SwiftUI

@main
struct PiClientApp: App {
  @State private var client = BridgeClient()

  var body: some Scene {
    WindowGroup { ConnectionView(client: client, store: ConnectionStore()) }
  }
}
