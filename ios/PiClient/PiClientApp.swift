import SwiftUI

@main
struct PiClientApp: App {
  private enum Tab { case transcript, connection }

  @State private var client = BridgeClient()
  @State private var notifications = SettleNotifications()
  @State private var tab = Tab.transcript
  @Environment(\.scenePhase) private var scenePhase
  private let store = ConnectionStore()

  /// Settle notifications stream in only while the app is active (no APNs in v1).
  private var notificationTopic: NtfyTopic? { scenePhase == .active ? client.ntfy : nil }

  var body: some Scene {
    WindowGroup {
      TabView(selection: $tab) {
        TranscriptView(client: client)
          .tabItem { Label("Transcript", systemImage: "text.bubble") }
          .tag(Tab.transcript)
        ConnectionView(client: client, store: store)
          .tabItem { Label("Connection", systemImage: "network") }
          .tag(Tab.connection)
      }
      .task {
        if let saved = store.load(), client.state == .offline { client.connect(to: saved) }
      }
      .task(id: notificationTopic) {
        if let topic = notificationTopic { await notifications.listen(to: topic) }
      }
      // Runs at launch too, for the notification that launched the app.
      .task(id: notifications.requestedSession) {
        guard let id = notifications.requestedSession else { return }
        tab = .transcript
        try? await client.show(sessionId: id)
        // A newer tap replaces the request (and cancels this task); only clear our own.
        if notifications.requestedSession == id { notifications.requestedSession = nil }
      }
    }
  }
}
