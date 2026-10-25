import SwiftUI

/// Message entry below the transcript: send a prompt when idle; during a run, steer or queue a
/// follow-up, abort, and see what is still queued. Typing `/` offers the session's
/// skills and `@` its files; Tab (hardware keyboard) takes the first suggestion, Esc dismisses.
/// Below the text sit the session's model and thinking level (tapping calls `pickModel`), its
/// context fill and price; the send button shows only once there is something to send.
struct ComposerView: View {
  /// Takes the commands; the transcript state below is passed in, so streaming leaves this alone.
  let client: BridgeClient
  /// The session typed into; its skills are offered.
  let sessionId: String
  /// Whether the session can be driven: shown, connected and not ended.
  let isLive: Bool
  let isRunning: Bool
  let queue: Transcript.Queue
  let status: Transcript.Status
  let pickModel: () -> Void

  @State private var draft = ""
  @State private var failure: String?
  @State private var skills: [Skill] = []
  /// Matches for the `@` word being typed; refreshed as it changes.
  @State private var files: [String] = []
  /// A trigger the user waved away; suggestions stay hidden until the draft's trigger changes.
  @State private var dismissed: Suggestions.Trigger?

  private var canSend: Bool {
    isLive && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
      if !queue.isEmpty { QueueView(queue: queue) }
      if let failure { Text(failure).font(.footnote).foregroundStyle(.red) }
      VStack(alignment: .leading, spacing: 8) {
        TextField("Message…", text: $draft, axis: .vertical)
          .lineLimit(1...6)
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
        HStack(spacing: 8) {
          ModelButton(status: status, action: pickModel).disabled(!isLive)
          Spacer(minLength: 0)
          Text(usage).font(.caption.monospacedDigit()).foregroundStyle(.secondary).lineLimit(1)
          if isRunning {
            Button("Abort", systemImage: "stop.circle.fill", role: .destructive) { run { try await client.abort() } }
              .labelStyle(.iconOnly)
              .font(.title)
          }
          if canSend { sendButton }
        }
        .frame(minHeight: 32)  // keeps the row steady as the send button comes and goes
      }
      .padding(10)
      .background(.background, in: .rect(cornerRadius: 20))
      .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(.separator))
    }
    .padding(.horizontal)
    .padding(.vertical, 8)
    .background(.bar)
    // Skills belong to the session: reload when joining another.
    .task(id: isLive ? sessionId : nil) {
      guard isLive else { return }
      skills = (try? await client.skills()) ?? []
    }
    .task(id: trigger) {
      guard case .file(let query) = trigger else { return files = [] }
      do { try await Task.sleep(for: .milliseconds(120)) } catch { return }  // debounce typing
      files = (try? await client.searchFiles(query)) ?? []
    }
  }

  /// Context fill and price, e.g. `18.8k/1.0M • $2.39`.
  private var usage: String {
    [status.contextUsage, status.cost.formatted(.currency(code: "USD"))]
      .compactMap { $0 }
      .joined(separator: " • ")
  }

  private func accept(_ pick: Suggestions.Pick) {
    draft = Suggestions.inserting(pick, into: draft)
  }

  private func dismiss() {
    dismissed = trigger
  }

  /// Idle: a plain send. During a run the tap steers, and a long press offers the follow-up.
  @ViewBuilder private var sendButton: some View {
    if isRunning {
      Menu {
        Button("Follow up after the run", systemImage: "clock") { send(.followUp) }
      } label: {
        Image(systemName: "arrow.up.circle.fill").font(.title)
      } primaryAction: {
        send(.steer)
      }
    } else {
      Button("Send", systemImage: "arrow.up.circle.fill") { send(.steer) }
        .labelStyle(.iconOnly)
        .font(.title)
    }
  }

  private func send(_ mode: PromptMode) {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    draft = ""
    run(restoring: text) { try await client.send(text, mode: mode) }
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

/// Provider, model and thinking level of the session, as one tappable pill.
private struct ModelButton: View {
  let status: Transcript.Status
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 4) {
        if let name = status.modelName {
          if let provider = status.provider { Text(provider) }
          Text(name)
        } else {
          Text("No model")
        }
        // Models that can't think have only `off`; no point saying so.
        if let level = status.thinkingLevel, status.thinkingLevels.count > 1 {
          Text(level).foregroundStyle(.secondary)
        }
      }
      .font(.caption)
      .lineLimit(1)
    }
    .buttonStyle(.bordered)
    .buttonBorderShape(.capsule)
    .controlSize(.small)
    .tint(.primary)
  }
}

/// Messages sent during a run that the agent has not taken in yet.
private struct QueueView: View {
  let queue: Transcript.Queue

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("Queued").font(.footnote.bold())
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
