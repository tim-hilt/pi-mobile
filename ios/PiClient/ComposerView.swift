import SwiftUI

/// Message entry below the transcript: send a prompt when idle; during a run, steer or queue a
/// follow-up, abort, and see (or cancel) what is still queued.
struct ComposerView: View {
  let client: BridgeClient

  @State private var draft = ""
  @State private var failure: String?

  private var transcript: Transcript { client.transcript }
  private var canSend: Bool {
    client.state == .connected && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if !transcript.queue.isEmpty { QueueView(queue: transcript.queue, cancel: cancelQueue) }
      if let failure { Text(failure).font(.footnote).foregroundStyle(.red) }
      HStack(alignment: .bottom, spacing: 8) {
        TextField("Message", text: $draft, axis: .vertical)
          .lineLimit(1...6)
          .textFieldStyle(.roundedBorder)
        if transcript.isRunning {
          Button("Abort", systemImage: "stop.circle.fill", role: .destructive) { run { try await client.abort() } }
            .labelStyle(.iconOnly)
            .font(.title)
        }
        sendButton
      }
    }
    .padding(.horizontal)
    .padding(.vertical, 8)
    .background(.bar)
  }

  /// Idle: a plain send. During a run the tap steers, and a long press offers the follow-up.
  @ViewBuilder private var sendButton: some View {
    if transcript.isRunning {
      Menu {
        Button("Follow up after the run", systemImage: "clock") { send(.followUp) }
      } label: {
        Image(systemName: "arrow.up.circle.fill").font(.title)
      } primaryAction: {
        send(.steer)
      }
      .disabled(!canSend)
    } else {
      Button("Send", systemImage: "arrow.up.circle.fill") { send(.steer) }
        .labelStyle(.iconOnly)
        .font(.title)
        .disabled(!canSend)
    }
  }

  private func send(_ mode: PromptMode) {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    draft = ""
    run(restoring: text) { try await client.send(text, mode: mode) }
  }

  /// Cancels everything queued; the texts go back to the draft so nothing typed is lost.
  private func cancelQueue() {
    run {
      let dropped = try await client.clearQueue()
      draft = (dropped.steering + dropped.followUp + [draft]).filter { !$0.isEmpty }.joined(separator: "\n\n")
    }
  }

  /// Runs a command, showing its failure; `restoring` goes back to the draft if it fails.
  private func run(restoring text: String? = nil, _ command: @escaping () async throws -> Void) {
    failure = nil
    Task {
      do {
        try await command()
      } catch {
        failure = error.localizedDescription
        if let text { draft = text }
      }
    }
  }
}

/// Messages sent during a run that the agent has not taken in yet.
private struct QueueView: View {
  let queue: Transcript.Queue
  let cancel: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Text("Queued").font(.footnote.bold())
        Spacer()
        Button("Cancel all", action: cancel).font(.footnote)
      }
      ForEach(Array(queue.steering.enumerated()), id: \.offset) { _, text in
        row(text, symbol: "arrow.turn.down.right", label: "Steer")
      }
      ForEach(Array(queue.followUp.enumerated()), id: \.offset) { _, text in
        row(text, symbol: "clock", label: "Follow up")
      }
    }
    .foregroundStyle(.secondary)
  }

  private func row(_ text: String, symbol: String, label: String) -> some View {
    Label {
      Text(text).lineLimit(2).font(.footnote)
    } icon: {
      Image(systemName: symbol)
    }
    .accessibilityLabel("\(label): \(text)")
  }
}
