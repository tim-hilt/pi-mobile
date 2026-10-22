import SwiftUI

/// Sheet for starting a new session, switching to a recent one, and reading the current session's
/// stats. The bridge refuses to change session mid-run, so the actions are disabled then.
struct SessionsView: View {
  let client: BridgeClient

  @Environment(\.dismiss) private var dismiss
  @State private var list: SessionList?
  @State private var stats: SessionStats?
  @State private var failure: String?

  private var canChange: Bool { client.state == .connected && !client.transcript.isRunning }

  var body: some View {
    NavigationStack {
      List {
        if let failure { Text(failure).font(.footnote).foregroundStyle(.red) }
        if client.transcript.isRunning {
          Text("Abort the active run to change session.").font(.footnote).foregroundStyle(.secondary)
        }
        if let stats { Section("This session") { StatsRows(stats: stats) } }
        if let list {
          Section("Recent") {
            ForEach(list.sessions) { session in
              Button { change { try await client.switchSession(id: session.id) } } label: {
                SessionRow(session: session, isCurrent: session.id == list.currentId)
              }
              .disabled(!canChange)
            }
          }
        }
      }
      .navigationTitle("Sessions")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
        ToolbarItem(placement: .primaryAction) {
          Button("New session", systemImage: "square.and.pencil") { change { try await client.newSession() } }
            .disabled(!canChange)
        }
      }
      // A session change replaces the transcript's session id, which refreshes both lists.
      .task(id: client.transcript.sessionId) { await load() }
    }
  }

  private func load() async {
    do {
      async let sessions = client.sessions()
      async let current = client.stats()
      (list, stats) = try await (sessions, current)
      failure = nil
    } catch {
      failure = "\(error)"
    }
  }

  /// Runs a session change and closes the sheet on success, so the new transcript is in view.
  private func change(_ action: @escaping () async throws -> Void) {
    Task {
      do {
        try await action()
        dismiss()
      } catch {
        failure = (error as? ProtocolError)?.message ?? "\(error)"
      }
    }
  }
}

private struct SessionRow: View {
  let session: SessionSummary
  let isCurrent: Bool

  var body: some View {
    HStack {
      VStack(alignment: .leading, spacing: 2) {
        Text(session.title).lineLimit(2)
        Text("\(session.modifiedAt.formatted(.relative(presentation: .named))) · \(session.messageCount) messages")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer()
      if isCurrent { Image(systemName: "checkmark").foregroundStyle(.tint) }
    }
    .foregroundStyle(.primary)
  }
}

private struct StatsRows: View {
  let stats: SessionStats

  var body: some View {
    LabeledContent("Runs", value: "\(stats.runs) · \(format(durationMs: stats.runDurationMs))")
    LabeledContent("Messages", value: "\(stats.userMessages) sent · \(stats.assistantMessages) replies")
    LabeledContent("Tool calls", value: "\(stats.toolCalls)")
    LabeledContent("Tokens", value: stats.tokens.formatted())
    LabeledContent("Cost", value: stats.cost.formatted(.currency(code: "USD")))
  }
}
