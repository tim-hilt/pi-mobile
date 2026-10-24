import SwiftUI

@main
struct PiMobileApp: App {
  private enum Tab { case transcript, connection }

  @State private var client = BridgeClient()
  @State private var tab = Tab.transcript
  /// From a pairing link opened outside the app; awaits confirmation so a foreign code can't silently re-point us.
  @State private var pendingPairing: BridgeConfig?
  /// The session a tapped notification links to; whoever opens it sets this back to nil.
  @State private var requestedSession: String?
  @Environment(\.scenePhase) private var scenePhase
  private let store = ConnectionStore()

  /// Saves a scanned config and logs in with it.
  private func pair(_ config: BridgeConfig) {
    try? store.save(config)
    client.connect(to: config)
  }

  var body: some Scene {
    WindowGroup {
      TabView(selection: $tab) {
        TranscriptView(client: client, onPair: pair)
          .tabItem { Label("Transcript", systemImage: "text.bubble") }
          .tag(Tab.transcript)
        ConnectionView(client: client, store: store, onPair: pair)
          .tabItem { Label("Connection", systemImage: "network") }
          .tag(Tab.connection)
      }
      .onOpenURL { url in
        switch DeepLink(url: url) {
        case .pair(let config): pendingPairing = config
        case .session(let id): requestedSession = id
        case nil: break
        }
      }
      .alert(
        "Connect to \(pendingPairing?.url.host() ?? "bridge")?",
        isPresented: Binding(get: { pendingPairing != nil }, set: { if !$0 { pendingPairing = nil } }),
        presenting: pendingPairing
      ) { config in
        Button("Connect") {
          pair(config)
          tab = .connection
        }
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
      // Nothing on show yet (first launch, or a different bridge): show the latest session.
      .task(id: client.state == .connected && client.transcript.sessionId == nil) {
        guard client.state == .connected, client.transcript.sessionId == nil, requestedSession == nil else { return }
        try? await client.joinMostRecent()
      }
      // Also runs at launch, for the link that launched the app.
      .task(id: requestedSession) {
        guard let id = requestedSession else { return }
        tab = .transcript
        try? await client.show(sessionId: id)
        // A newer link replaces the request (and cancels this task); only clear our own.
        if requestedSession == id { requestedSession = nil }
      }
    }
  }
}
