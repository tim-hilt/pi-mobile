import SwiftUI

/// The synced conversation, newest at the bottom.
struct TranscriptView: View {
  let client: BridgeClient

  var body: some View {
    if client.transcript.messages.isEmpty {
      ContentUnavailableView(
        client.state == .connected ? "No messages yet" : "Not connected",
        systemImage: "text.bubble")
    } else {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          ForEach(client.transcript.messages) { MessageView(message: $0) }
        }
        .padding()
      }
      .defaultScrollAnchor(.bottom)
    }
  }
}

private struct MessageView: View {
  let message: Transcript.Message

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      if !message.thinking.isEmpty {
        Text(message.thinking).font(.footnote).italic().foregroundStyle(.secondary)
      }
      if !message.text.isEmpty { Text(message.text) }
      if message.isStreaming { ProgressView() }
    }
    .padding(message.role == .user ? 10 : 0)
    .background(message.role == .user ? Color.accentColor.opacity(0.15) : .clear, in: .rect(cornerRadius: 12))
    .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
  }
}
