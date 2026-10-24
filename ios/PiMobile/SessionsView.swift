import SwiftUI

/// Sheet listing the pi sessions running on the Mac, grouped by directory, to join one; plus the
/// joined session's stats.
struct SessionsView: View {
  let client: BridgeClient

  @Environment(\.dismiss) private var dismiss
  @State private var list: SessionList?
  @State private var stats: SessionStats?
  @State private var failure: String?

  /// Directories in order of their most recently active session.
  private var groups: [(cwd: String, sessions: [LiveSession])] {
    var order: [String] = []
    var byCwd: [String: [LiveSession]] = [:]
    for session in list?.sessions ?? [] {
      if byCwd[session.cwd] == nil { order.append(session.cwd) }
      byCwd[session.cwd, default: []].append(session)
    }
    return order.map { ($0, byCwd[$0] ?? []) }
  }

  var body: some View {
    NavigationStack {
      List {
        if let failure { Text(failure).font(.footnote).foregroundStyle(.red) }
        if let stats, !client.transcript.hasEnded { Section("This session") { StatsRows(stats: stats) } }
        if list?.sessions.isEmpty == true {
          ContentUnavailableView(
            "No pi sessions", systemImage: "terminal",
            description: Text("Start pi on your Mac to see it here."))
        }
        ForEach(groups, id: \.cwd) { group in
          Section(URL(fileURLWithPath: group.cwd).lastPathComponent) {
            ForEach(group.sessions) { session in
              Button { join(session.id) } label: {
                SessionRow(session: session, isJoined: session.id == list?.joinedId)
              }
            }
          }
        }
      }
      .navigationTitle("Sessions")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
      }
      .refreshable { await load() }
      // A new session on show refreshes both lists.
      .task(id: client.transcript.sessionId) { await load() }
    }
  }

  private func load() async {
    do {
      list = try await client.sessions()
      stats = list?.joinedId == nil ? nil : try await client.stats()
      failure = nil
    } catch {
      failure = error.localizedDescription
    }
  }

  /// Joins and closes the sheet on success, so its transcript is in view.
  private func join(_ id: String) {
    Task {
      do {
        try await client.join(sessionId: id)
        dismiss()
      } catch {
        failure = error.localizedDescription
      }
    }
  }
}

private struct SessionRow: View {
  let session: LiveSession
  let isJoined: Bool

  var body: some View {
    HStack {
      VStack(alignment: .leading, spacing: 2) {
        Text(session.title).lineLimit(2)
        Text(session.activeAt.formatted(.relative(presentation: .named)))
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer()
      if session.running { ProgressView().controlSize(.small) }
      if isJoined { Image(systemName: "checkmark").foregroundStyle(.tint) }
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
