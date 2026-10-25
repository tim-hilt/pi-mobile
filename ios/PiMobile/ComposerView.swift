import SwiftUI

/// Message entry floating over the bottom of the transcript: send a prompt when idle; during a
/// run, steer or queue a follow-up, abort, and see what is still queued. Typing `/` offers the
/// session's skills and `@` its files; Tab (hardware keyboard) takes the first suggestion, Esc dismisses.
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
    // Glass panels floating over the conversation; the container lets them sample each other.
    GlassEffectContainer {
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
        .glassEffect(in: .rect(cornerRadius: 20))
      }
    }
    .padding(.horizontal)
    .padding(.vertical, 8)
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

/// Model and thinking level of the session, as one tappable pill.
private struct ModelButton: View {
  let status: Transcript.Status
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 4) {
        if let name = status.modelName {
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
      ForEach(queue.steering.enumerated(), id: \.offset) { _, text in
        row(text, symbol: "arrow.turn.down.right", label: "Steer")
      }
      ForEach(queue.followUp.enumerated(), id: \.offset) { _, text in
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

/// An autocomplete card above the field: one tap takes a suggestion, the header's button waves them
/// all away. The first row is what Tab takes.
private struct SuggestionBar: View {
  let picks: [Suggestions.Pick]
  let accept: (Suggestions.Pick) -> Void
  let dismiss: () -> Void

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text(title).font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
        Spacer()
        Button("Dismiss suggestions", systemImage: "xmark.circle.fill", action: dismiss)
          .labelStyle(.iconOnly)
          .symbolRenderingMode(.hierarchical)
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 8)
      Divider()
      // Grows with the rows, scrolls beyond a few.
      ViewThatFits(in: .vertical) {
        rows
        ScrollView { rows }
      }
      .frame(maxHeight: 420)
    }
    .glassEffect(in: .rect(cornerRadius: 20))
  }

  private var title: String {
    picks.first?.isFile == true ? "Files" : "Skills"
  }

  private var rows: some View {
    VStack(spacing: 0) {
      ForEach(picks.enumerated(), id: \.element.label) { index, pick in
        if index > 0 { Divider().padding(.leading, pick.isFile ? 46 : 14) }
        Button { accept(pick) } label: { row(pick) }
          .buttonStyle(.plain)
      }
    }
  }

  private func row(_ pick: Suggestions.Pick) -> some View {
    HStack(spacing: 12) {
      if pick.isFile {
        Image(systemName: "doc")
          .foregroundStyle(.tint)
          .frame(width: 20)
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(pick.title).lineLimit(1)
        if pick.isFile, let subtitle = pick.subtitle, !subtitle.isEmpty {
          Text(subtitle).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            .truncationMode(pick.isFile ? .head : .tail)  // folders keep their nearest part
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 9)
    .contentShape(.rect)
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

  var isFile: Bool {
    if case .file = self { true } else { false }
  }

  /// Skill name, or file name.
  var title: String {
    switch self {
    case .skill(let skill): skill.name
    case .file(let path): (path as NSString).lastPathComponent
    }
  }

  /// Skill description, or the file's folder.
  var subtitle: String? {
    switch self {
    case .skill(let skill): skill.description
    case .file(let path): (path as NSString).deletingLastPathComponent
    }
  }
}
