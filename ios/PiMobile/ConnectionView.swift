import SwiftUI

/// Bridge address + token form with live connection status.
struct ConnectionView: View {
  let client: BridgeClient
  let store: ConnectionStore
  /// Called with the config from a scanned pairing QR code.
  let onPair: (BridgeConfig) -> Void

  @State private var address = ""
  @State private var token = ""
  @State private var saveError: String?
  @State private var showingScanner = false
  @FocusState private var field: Field?

  private enum Field { case address, token }

  private var config: BridgeConfig? {
    guard let url = URL(string: address.trimmingCharacters(in: .whitespaces)),
      ["ws", "wss"].contains(url.scheme), url.host != nil, !token.isEmpty
    else { return nil }
    return BridgeConfig(url: url, token: token)
  }

  var body: some View {
    Form {
      Section {
        Button("Scan QR Code to Log In", systemImage: "qrcode.viewfinder") { showingScanner = true }
      }
      Section("Bridge") {
        TextField("wss://host", text: $address)
          .textContentType(.URL)
          .keyboardType(.URL)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .focused($field, equals: .address)
          .submitLabel(.next)
          .onSubmit { field = .token }
        SecureField("Token", text: $token)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .focused($field, equals: .token)
          .submitLabel(.go)
          .onSubmit { connect() }
        Button("Connect") { connect() }.disabled(config == nil)
        if client.state != .offline {
          Button("Disconnect", role: .destructive) { disconnect() }
        }
      }
      Section("Status") {
        Label(client.state.title, systemImage: client.state.symbol)
          .foregroundStyle(client.state.color)
        if case .failed(let error) = client.state {
          Text("\(error.code): \(error.message)").font(.footnote)
        }
        if let saveError { Text(saveError).font(.footnote) }
      }
    }
    .scrollDismissesKeyboard(.immediately)
    .sheet(isPresented: $showingScanner) {
      PairingScanner { config in
        address = config.url.absoluteString
        token = config.token
        onPair(config)
      }
    }
    .task {
      guard let saved = store.load() else { return }
      address = saved.url.absoluteString
      token = saved.token
    }
  }

  /// Also forgets the saved config, else the app would reconnect on the next foreground.
  private func disconnect() {
    store.clear()
    client.disconnect()
  }

  private func connect() {
    field = nil
    guard let config else { return }
    do {
      try store.save(config)
      saveError = nil
    } catch {
      saveError = "Could not save settings: \(error)"
    }
    client.connect(to: config)
  }
}

extension ConnectionState {
  fileprivate var title: String {
    switch self {
    case .offline: "Offline"
    case .connecting: "Connecting…"
    case .connected: "Connected"
    case .failed: "Connection failed"
    }
  }

  fileprivate var symbol: String {
    switch self {
    case .offline: "wifi.slash"
    case .connecting: "arrow.triangle.2.circlepath"
    case .connected: "checkmark.circle.fill"
    case .failed: "exclamationmark.triangle.fill"
    }
  }

  fileprivate var color: Color {
    switch self {
    case .offline: .secondary
    case .connecting: .orange
    case .connected: .green
    case .failed: .red
    }
  }
}
