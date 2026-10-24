import SwiftUI

/// One session's synced conversation, newest at the bottom, with the composer and the session's
/// status below it. Shows the session (joining it) when it appears.
struct TranscriptView: View {
  let client: BridgeClient
  let sessionId: String

  @State private var failure: String?
  @State private var showingModels = false
  @State private var showingStats = false

  /// Until the join lands, `client.transcript` still holds the previously shown session.
  private var isShown: Bool { client.transcript.sessionId == sessionId }
  private var isLive: Bool { isShown && client.state == .connected && !client.transcript.hasEnded }

  var body: some View {
    VStack(spacing: 0) {
      conversation
      ComposerView(client: client).disabled(!isShown)
      if isShown {
        StatusBar(cwd: client.transcript.cwd, status: client.transcript.status) { showingModels = true }
          .disabled(!isLive)
      }
    }
    .navigationTitle(isShown ? client.transcript.cwd.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "" : "")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      Button("Stats", systemImage: "info.circle") { showingStats = true }.disabled(!isLive)
    }
    .sheet(isPresented: $showingModels) { ModelsView(client: client) }
    .sheet(isPresented: $showingStats) { StatsView(client: client) }
    .task(id: sessionId) {
      do {
        try await client.show(sessionId: sessionId)
        failure = nil
      } catch {
        failure = error.localizedDescription
      }
    }
  }

  /// Always a scroll view, so dragging down dismisses the keyboard whatever is on show.
  private var conversation: some View {
    ScrollView {
      let transcript = client.transcript
      if !isShown {
        Group {
          if let failure {
            ContentUnavailableView("Could not open the session", systemImage: "exclamationmark.triangle", description: Text(failure))
          } else {
            ProgressView()
          }
        }
        .containerRelativeFrame(.vertical)
      } else if transcript.entries.isEmpty && !transcript.isRunning && !transcript.hasEnded {
        ContentUnavailableView("No messages yet", systemImage: "text.bubble").containerRelativeFrame(.vertical)
      } else {
        LazyVStack(alignment: .leading, spacing: 12) {
          ForEach(transcript.entries) { entry in
            switch entry {
            case .message(let message): MessageView(message: message)
            case .toolCall(let call): ToolCallView(call: call)
            case .run(let run): RunView(run: run)
            }
          }
          if let startedAt = transcript.runStartedAt { RunningView(startedAt: startedAt) }
          if transcript.hasEnded {
            Label("Session ended in pi", systemImage: "power").font(.footnote).foregroundStyle(.secondary)
          }
        }
        .padding()
      }
    }
    .defaultScrollAnchor(.bottom)
    .scrollDismissesKeyboard(.interactively)
  }
}

/// Sheet with the shown session's counts, run timing and cost.
private struct StatsView: View {
  let client: BridgeClient

  @Environment(\.dismiss) private var dismiss
  @State private var stats: SessionStats?
  @State private var failure: String?

  var body: some View {
    NavigationStack {
      List {
        if let failure { Text(failure).font(.footnote).foregroundStyle(.red) }
        if let stats {
          LabeledContent("Runs", value: "\(stats.runs) · \(format(durationMs: stats.runDurationMs))")
          LabeledContent("Messages", value: "\(stats.userMessages) sent · \(stats.assistantMessages) replies")
          LabeledContent("Tool calls", value: "\(stats.toolCalls)")
          LabeledContent("Tokens", value: stats.tokens.formatted())
          LabeledContent("Cost", value: stats.cost.formatted(.currency(code: "USD")))
        }
      }
      .navigationTitle("Stats")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
      }
      .task {
        do {
          stats = try await client.stats()
        } catch {
          failure = error.localizedDescription
        }
      }
    }
    .presentationDetents([.medium])
  }
}

private struct MessageView: View {
  let message: Transcript.Message

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      if !message.thinking.isEmpty {
        DisclosureGroup("Reasoning") {
          Text(message.thinking).italic()
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
      }
      if !message.text.isEmpty {
        switch message.role {
        case .user: Text(message.text)
        case .assistant: MarkdownView(markdown: Markdown(parsing: message.text))
        }
      }
      if message.isStreaming { ProgressView() }
    }
    .padding(message.role == .user ? 10 : 0)
    .background(message.role == .user ? Color.accentColor.opacity(0.15) : .clear, in: .rect(cornerRadius: 12))
    .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
  }
}

/// An agent's answer laid out block by block, its text selectable.
private struct MarkdownView: View {
  let markdown: Markdown

  /// Width of a list item's marker; item text, its continuation paragraphs and nested lists align on it.
  @ScaledMetric private var markerWidth = 18.0

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(markdown.blocks.indices, id: \.self) { index in
        block(markdown.blocks[index])
      }
    }
    .textSelection(.enabled)
  }

  @ViewBuilder private func block(_ block: Markdown.Block) -> some View {
    switch block {
    case .paragraph(let text): Text(text)
    case .heading(let level, let text):
      Text(text).font(level == 1 ? .title2 : level == 2 ? .title3 : .headline).bold()
    case .listItem(let marker, let depth, let text):
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text(marker ?? "").monospacedDigit().frame(minWidth: markerWidth, alignment: .trailing)
        Text(text)
      }
      .padding(.leading, CGFloat(depth - 1) * (markerWidth + 6))
    case .quote(let text):
      Text(text)
        .foregroundStyle(.secondary)
        .padding(.leading, 10)
        .overlay(alignment: .leading) { Rectangle().fill(.tertiary).frame(width: 3) }
    case .code(let code):
      ScrollView(.horizontal) {
        Text(code).font(.caption.monospaced()).padding(8)
      }
      .background(.quaternary, in: .rect(cornerRadius: 8))
    case .table(let rows):
      ScrollView(.horizontal) {
        Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
          ForEach(rows.indices, id: \.self) { row in
            GridRow {
              ForEach(rows[row].indices, id: \.self) { column in
                Text(rows[row][column]).bold(row == 0)
              }
            }
            if row == 0 { Divider() }
          }
        }
      }
      .font(.callout)
    case .rule: Divider()
    }
  }
}

/// A tool execution: name and duration in the header, expandable to arguments and output.
private struct ToolCallView: View {
  let call: Transcript.ToolCall

  var body: some View {
    DisclosureGroup {
      VStack(alignment: .leading, spacing: 6) {
        if let args = call.args { Text(args.formatted).textSelection(.enabled) }
        if !call.output.isEmpty {
          Divider()
          Text(call.output).textSelection(.enabled)
        }
      }
      .font(.caption.monospaced())
      .frame(maxWidth: .infinity, alignment: .leading)
    } label: {
      HStack {
        switch call.status {
        case .running: ProgressView().controlSize(.small)
        case .succeeded: Image(systemName: "checkmark.circle").foregroundStyle(.green)
        case .failed: Image(systemName: "xmark.circle").foregroundStyle(.red)
        }
        Text(call.name).font(.subheadline.monospaced())
        Spacer()
        if let durationMs = call.durationMs {
          Text(format(durationMs: durationMs)).font(.caption).foregroundStyle(.secondary)
        }
      }
    }
    .padding(10)
    .background(.quaternary, in: .rect(cornerRadius: 10))
  }
}

/// One line like pi's footer: directory on the left; model, context fill and price on the right.
/// Tapping the model calls `pickModel`.
private struct StatusBar: View {
  let cwd: String?
  let status: Transcript.Status
  let pickModel: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      if let cwd { Text(Self.abbreviatingHome(cwd)).truncationMode(.head) }
      Spacer(minLength: 0)
      Group {
        Button(status.model ?? "No model", action: pickModel).buttonStyle(.borderless)
        Text("· \(details)")
      }
      .layoutPriority(1)
    }
    .font(.caption.monospacedDigit())
    .foregroundStyle(.secondary)
    .lineLimit(1)
    .padding(.horizontal)
    .padding(.bottom, 4)
    .background(.bar)
  }

  private var details: String {
    [status.contextUsage, status.cost.formatted(.currency(code: "USD"))]
      .compactMap { $0 }
      .joined(separator: " · ")
  }

  /// `~` for the Mac user's home, as pi shows it. The app can't ask the Mac where home is, so it
  /// assumes macOS's (and Linux's) layout.
  private static func abbreviatingHome(_ path: String) -> String {
    path.replacing(/^\/(Users|home)\/[^\/]+/, with: "~")
  }
}

/// Live elapsed time of the active run.
private struct RunningView: View {
  let startedAt: Date

  var body: some View {
    HStack(spacing: 6) {
      ProgressView().controlSize(.small)
      Text("Running")
      Text(startedAt, style: .timer).monospacedDigit()
    }
    .font(.footnote)
    .foregroundStyle(.secondary)
  }
}

/// How a finished run ended; anything but success is called out in colour with its reason.
private struct RunView: View {
  let run: Transcript.Run

  var body: some View {
    let (label, symbol, colour) = appearance
    VStack(alignment: .leading, spacing: 2) {
      Label("\(label) · \(format(durationMs: run.durationMs))", systemImage: symbol)
      if let message = run.errorMessage { Text(message).font(.caption) }
    }
    .font(.footnote)
    .foregroundStyle(colour)
  }

  private var appearance: (String, String, Color) {
    switch run.stopReason {
    case .success: ("Finished", "checkmark", .secondary)
    case .error: ("Failed", "exclamationmark.triangle.fill", .red)
    case .aborted: ("Aborted", "stop.circle.fill", .orange)
    case .length: ("Cut off: output limit reached", "scissors", .orange)
    }
  }
}

func format(durationMs: Int) -> String {
  Duration.milliseconds(durationMs).formatted(
    .units(allowed: [.hours, .minutes, .seconds, .milliseconds], width: .narrow, maximumUnitCount: 2))
}
