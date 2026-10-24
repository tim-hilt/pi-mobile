import SwiftUI

@main
struct PiMobileApp: App {
  @State private var client = BridgeClient()
  /// The session opened over the home list, if any; a notification's link replaces it.
  @State private var path: [String] = []
  /// From a pairing link opened outside the app; awaits confirmation so a foreign code can't silently re-point us.
  @State private var pendingPairing: BridgeConfig?
  @Environment(\.scenePhase) private var scenePhase
  private let store = ConnectionStore()

  /// Saves a scanned config and logs in with it.
  private func pair(_ config: BridgeConfig) {
    try? store.save(config)
    client.connect(to: config)
  }

  var body: some Scene {
    WindowGroup {
      NavigationStack(path: $path) {
        SessionsView(client: client, store: store, onPair: pair)
          .navigationDestination(for: String.self) { TranscriptView(client: client, sessionId: $0) }
      }
      .onOpenURL { url in
        switch DeepLink(url: url) {
        case .pair(let config): pendingPairing = config
        case .session(let id): path = [id]
        case nil: break
        }
      }
      .alert(
        "Connect to \(pendingPairing?.url.host() ?? "bridge")?",
        isPresented: Binding(get: { pendingPairing != nil }, set: { if !$0 { pendingPairing = nil } }),
        presenting: pendingPairing
      ) { config in
        Button("Connect") { pair(config) }
        Button("Cancel", role: .cancel) {}
      } message: { config in
        Text("Pi Mobile will log in to \(config.url.absoluteString). Only connect to bridges you run.")
      }
      // Connect on demand: only while the app is in use; iOS would kill a background socket anyway.
      // Reconnecting to the same bridge resumes from the transcript's cursor.
      .task(id: scenePhase == .background) {
        if scenePhase == .background { return client.disconnect() }
        if let saved = store.load() { client.connect(to: saved) }
      }
    }
  }
}
