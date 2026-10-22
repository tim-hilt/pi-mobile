import SwiftUI

@main
struct PiClientApp: App {
  @State private var client = BridgeClient()
  private let store = ConnectionStore()

  var body: some Scene {
    WindowGroup {
      TabView {
        TranscriptView(client: client)
          .tabItem { Label("Transcript", systemImage: "text.bubble") }
        ConnectionView(client: client, store: store)
          .tabItem { Label("Connection", systemImage: "network") }
      }
      .task {
        if let saved = store.load(), client.state == .offline { client.connect(to: saved) }
      }
    }
  }
}
