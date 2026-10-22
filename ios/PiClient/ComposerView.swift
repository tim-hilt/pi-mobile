import SwiftUI

/// Message entry below the transcript: send a prompt when idle; during a run, steer or queue a
/// follow-up, abort, and see (or cancel) what is still queued. Typing `/` offers the session's
/// skills and `@` its files; Tab (hardware keyboard) takes the first suggestion, Esc dismisses.
struct ComposerView: View {
  let client: BridgeClient

  @State private var draft = ""
  @State private var failure: String?
  @State private var skills: [Skill] = []
  /// Matches for the `@` word being typed; refreshed as it changes.
  @State private var files: [String] = []
  /// A trigger the user waved away; suggestions stay hidden until the draft's trigger changes.
  @State private var dismissed: Suggestions.Trigger?

  private var transcript: Transcript { client.transcript }
  private var canSend: Bool {
    client.state == .connected && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private var trigger: Suggestions.Trigger? {
    Suggestions.trigger(in: draft).flatMap { $0 == dismissed ? nil : $0 }
  }

  private var picks: [Suggestions.Pick] {
    switch trigger {
    case .skill(let query): Suggestions.skills(matching: query, in: skills).map { .skill($0) }
    case .file: files.map { .file($0) }
    case nil: []
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if !picks.isEmpty { SuggestionBar(picks: picks, accept: accept, dismiss: dismiss) }
      if !transcript.queue.isEmpty { QueueView(queue: transcript.queue, cancel: cancelQueue) }
      if let failure { Text(failure).font(.footnote).foregroundStyle(.red) }
      HStack(alignment: .bottom, spacing: 8) {
        TextField("Message", text: $draft, axis: .vertical)
          .lineLimit(1...6)
          .textFieldStyle(.roundedBorder)
          .onKeyPress(.tab) {
            guard let first = picks.first else { return .ignored }
            accept(first)
            return .handled
          }
          .onKeyPress(.escape) {
            guard trigger != nil else { return .ignored }
            dismiss()
            return .handled
          }
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
    .task(id: client.state) {
      guard client.state == .connected else { return }
      skills = (try? await client.skills()) ?? []
    }
    .task(id: trigger) {
      guard case .file(let query) = trigger else { return files = [] }
      do { try await Task.sleep(for: .milliseconds(120)) } catch { return }  // debounce typing
      files = (try? await client.searchFiles(query)) ?? []
    }
  }

  private func accept(_ pick: Suggestions.Pick) {
    draft = Suggestions.inserting(pick, into: draft)
  }

  private func dismiss() {
    dismissed = trigger
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

/// One tap to take a suggestion, or the trailing button to wave them all away.
private struct SuggestionBar: View {
  let picks: [Suggestions.Pick]
  let accept: (Suggestions.Pick) -> Void
  let dismiss: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      ScrollView(.horizontal, showsIndicators: false) {
        LazyHStack(spacing: 8) {
          ForEach(picks, id: \.label) { pick in
            Button { accept(pick) } label: { chip(pick) }
              .buttonStyle(.bordered)
              .buttonBorderShape(.capsule)
              .controlSize(.small)
          }
        }
      }
      Button("Dismiss suggestions", systemImage: "xmark.circle.fill", action: dismiss)
        .labelStyle(.iconOnly)
        .foregroundStyle(.secondary)
    }
  }

  @ViewBuilder private func chip(_ pick: Suggestions.Pick) -> some View {
    switch pick {
    case .skill(let skill):
      Label(skill.name, systemImage: "slash.circle").lineLimit(1)
    case .file(let path):
      Label(path, systemImage: "doc").lineLimit(1).truncationMode(.head)
    }
  }
}

private extension Suggestions.Pick {
  /// Unique within one suggestion list.
  var label: String {
    switch self {
    case .skill(let skill): skill.name
    case .file(let path): path
    }
  }
}
