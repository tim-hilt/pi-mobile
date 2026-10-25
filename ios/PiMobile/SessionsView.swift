import SwiftUI

/// Home screen: the pi sessions running on the Mac, most recently active first, each with an icon
/// showing what it is up to; tapping one opens its transcript. Offline, it offers to scan the bridge's QR code.
struct SessionsView: View {
  let client: BridgeClient
  /// Called with the config from a scanned pairing QR code.
  let onPair: (BridgeConfig) -> Void

  @State private var showingScanner = false

  var body: some View {
    content
      .toolbar {
        // A logo, not a button: no glass behind it.
        ToolbarItem(placement: .topBarLeading) { logo }.sharedBackgroundVisibility(.hidden)
      }
      .sheet(isPresented: $showingScanner) { PairingScanner(onScan: onPair) }
  }

  @ViewBuilder private var content: some View {
    if client.state == .connected, let sessions = client.sessions, !sessions.isEmpty {
      List(sessions) { session in
        NavigationLink(value: session.id) { SessionRow(session: session) }
      }
    } else {
      placeholder.padding(.bottom, raise)
    }
  }

  /// What shows instead of the list: why there is none, or that it is coming.
  @ViewBuilder private var placeholder: some View {
    if case .failed(let error) = client.state {
      ContentUnavailableView {
        Label("Connection failed", systemImage: "exclamationmark.triangle")
      } description: {
        Text(error.message)
      } actions: {
        scanButton
      }
    } else if client.state == .connected, client.sessions != nil {
      // Standalone like the offline state; the bridge pushes new sessions as they start.
      ContentUnavailableView {
        Label("No pi sessions", systemImage: "terminal")
      } description: {
        Text("Start pi on your Mac to see it here.")
      }
    } else if client.state == .offline {
      // Reconnects run silently in the background; the list returns once one succeeds.
      ContentUnavailableView {
        Label("Not connected", systemImage: "network.slash")
      } description: {
        Text("Run the bridge on your Mac and scan the QR code it prints.")
      } actions: {
        scanButton
      }
    } else {
      ProgressView("Connecting…")
    }
  }

  /// Lifts the placeholders a little above dead center.
  private let raise: CGFloat = 80

  private var logo: some View {
    Image("PiLogo").resizable().scaledToFit().frame(height: 28).accessibilityLabel("Pi")
  }

  private var scanButton: some View {
    Button("Scan QR Code to Log In", systemImage: "qrcode.viewfinder") { showingScanner = true }
      .buttonStyle(.borderedProminent)
  }
}

/// Laid out like a Mail row: status, project and last activity on top, how the session began below.
private struct SessionRow: View {
  let session: LiveSession

  var body: some View {
    HStack(spacing: 12) {
      ActivityIcon(activity: session.activity)
      VStack(alignment: .leading, spacing: 2) {
        HStack(alignment: .firstTextBaseline) {
          Text(URL(filePath: session.cwd).lastPathComponent).font(.headline).lineLimit(1)
          Spacer()
          // The list only changes with the sessions; the relative time ages on its own.
          TimelineView(.everyMinute) { _ in
            Text(session.activeAt, format: .relative(presentation: .named, unitsStyle: .abbreviated))
          }
          .font(.subheadline)
          .foregroundStyle(.secondary)
        }
        Text(session.title).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
      }
    }
  }
}

/// The transcript's tool-call vocabulary: a spinner while working, a green check once finished,
/// a red cross after a failed run.
private struct ActivityIcon: View {
  let activity: LiveSession.Activity

  /// One width for all three, so the rows' text lines up.
  @ScaledMetric private var width = 22.0

  var body: some View {
    Group {
      switch activity {
      case .working: ProgressView()
      case .finished: Image(systemName: "checkmark.circle").foregroundStyle(.green)
      case .failed: Image(systemName: "xmark.circle").foregroundStyle(.red)
      }
    }
    .font(.title3)
    .frame(width: width)
    .accessibilityElement()
    .accessibilityLabel(label)
  }

  private var label: String {
    switch activity {
    case .working: "Working"
    case .finished: "Finished"
    case .failed: "Failed"
    }
  }
}
