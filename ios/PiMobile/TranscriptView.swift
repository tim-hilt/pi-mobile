import SwiftUI

/// One session's synced conversation, newest at the bottom, with the composer (which shows the
/// session's status) below it. Shows the session (joining it) when it appears, and goes back to
/// the session list once pi ends it.
struct TranscriptView: View {
  let client: BridgeClient
  let sessionId: String

  @State private var showingModels = false
  @Environment(\.dismiss) private var dismiss

  /// Until the join lands, `client.transcript` still holds the previously shown session, or this
  /// one as it ended.
  private var isShown: Bool { client.transcript.sessionId == sessionId && !client.transcript.hasEnded }
  private var isLive: Bool { isShown && client.state == .connected }

  var body: some View {
    VStack(spacing: 0) {
      conversation
      ComposerView(
        client: client, sessionId: sessionId, isLive: isLive, isRunning: client.transcript.isRunning,
        queue: client.transcript.queue, status: client.transcript.status
      ) { showingModels = true }
      // Laid out before the conversation, so open suggestions get their full height.
      .layoutPriority(1)
      .disabled(!isShown || client.state != .connected)
    }
    .navigationTitle(isShown ? client.transcript.cwd.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "" : "")
    .navigationBarTitleDisplayMode(.inline)
    .sheet(isPresented: $showingModels) { ModelsView(client: client).presentationDetents([.medium, .large]) }
    // The client joins it once connected, and again after every reconnect.
    .task(id: sessionId) { client.show(sessionId: sessionId) }
    // Ended while on show, live or found out on rejoining. Reopening an ended session doesn't
    // trigger this: it stays ended until a successful join's snapshot.
    .onChange(of: client.transcript.hasEnded) { _, hasEnded in
      if hasEnded && client.transcript.sessionId == sessionId { dismiss() }
    }
  }

  private var lostConnection: some View {
    ContentUnavailableView(
      "Lost connection", systemImage: "network.slash",
      description: Text("Reconnecting to the bridge in the background."))
  }

  /// Always a scroll view, so dragging down dismisses the keyboard whatever is on show.
  private var conversation: some View {
    ScrollView {
      let transcript = client.transcript
      if !isShown {
        Group {
          if client.state == .offline {
            lostConnection
          } else if let failure = client.showFailure {
            ContentUnavailableView("Could not open the session", systemImage: "exclamationmark.triangle", description: Text(failure))
          } else {
            ProgressView()
          }
        }
        .containerRelativeFrame(.vertical)
      } else if transcript.entries.isEmpty && transcript.streaming == nil && !transcript.isRunning {
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
          if let message = transcript.streaming { MessageView(message: message, isStreaming: true) }
          if let startedAt = transcript.runStartedAt { RunningView(startedAt: startedAt) }
          if client.state == .offline {
            Label("Lost connection", systemImage: "network.slash").font(.footnote).foregroundStyle(.secondary)
          }
        }
        .padding()
      }
    }
    .defaultScrollAnchor(.bottom)
    .scrollDismissesKeyboard(.interactively)
  }
}

private struct MessageView: View {
  let message: Transcript.Message
  /// Still being generated: `message` holds the deltas so far.
  var isStreaming = false

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
      if isStreaming { ProgressView() }
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

/// A tool execution, summarised in one line (`$ <command>`, `read <path>`, …). A running bash
/// call previews its output tail and elapsed time; other calls are quick and show neither.
/// Finished, it shows its outcome and, for bash, its duration. Expanding shows the full command
/// (or arguments) and output; for `edit`, the diff instead.
private struct ToolCallView: View {
  let call: Transcript.ToolCall

  @State private var isExpanded = false

  var body: some View {
    DisclosureGroup(isExpanded: $isExpanded) {
      details
        .font(.caption.monospaced())
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    } label: {
      if call.status == .running, call.command != nil { runningCommand } else { header }
    }
    .tint(.secondary)
    .foregroundStyle(.primary)
    .padding(10)
    .background(.quaternary, in: .rect(cornerRadius: 10))
  }

  @ViewBuilder private var details: some View {
    let diff = call.diff
    if !diff.isEmpty, call.status != .failed {
      VStack(alignment: .leading, spacing: 0) {
        ForEach(diff.indices, id: \.self) { index in
          let line = diff[index]
          switch line.kind {
          case .context: Text("  " + line.text).foregroundStyle(.secondary)
          case .removed: Text("- " + line.text).foregroundStyle(.red)
          case .added: Text("+ " + line.text).foregroundStyle(.green)
          }
        }
      }
    } else {
      VStack(alignment: .leading, spacing: 6) {
        if let command = call.command {
          Text(command)
        } else if let args = call.args {
          Text(args.formatted).foregroundStyle(.secondary)
        }
        if !call.output.isEmpty {
          Divider()
          Text(call.output).foregroundStyle(.secondary)
        }
      }
    }
  }

  private var header: some View {
    HStack {
      statusIcon
      Text(call.summary).font(.subheadline.monospaced()).lineLimit(1).truncationMode(.middle)
      Spacer(minLength: 4)
      if call.command != nil, let durationMs = call.durationMs {
        Text("took \(format(seconds: Double(durationMs) / 1000))")
          .font(.caption).foregroundStyle(.secondary).fixedSize()
      }
    }
  }

  @ViewBuilder private var statusIcon: some View {
    switch call.status {
    case .running: Image(systemName: "circle.dotted").foregroundStyle(.secondary)
    case .succeeded: Image(systemName: "checkmark.circle").foregroundStyle(.green)
    case .failed: Image(systemName: "xmark.circle").foregroundStyle(.red)
    }
  }

  private var runningCommand: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(call.summary).font(.subheadline.monospaced()).lineLimit(1)
      if !isExpanded {
        let tail = call.outputTail
        if !tail.isEmpty {
          Text(tail)
            .font(.caption2.monospaced())
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.tertiary))
        }
      }
      HStack(spacing: 6) {
        ProgressView().controlSize(.mini)
        ElapsedText(since: call.startedAt) { elapsed in
          call.timeoutSeconds.map { "\(elapsed) (timeout \(format(seconds: $0)))" } ?? elapsed
        }
      }
      .font(.caption)
      .foregroundStyle(.secondary)
    }
  }
}

/// Live elapsed time of the active run.
private struct RunningView: View {
  let startedAt: Date

  var body: some View {
    ElapsedText(since: startedAt) { "Running for \($0)…" }
      .font(.footnote)
      .foregroundStyle(.secondary)
  }
}

/// Whole seconds since `start`, e.g. `31m 21s`, updated every second and put into words by `text`.
private struct ElapsedText: View {
  let since: Date
  var text: (String) -> String = { $0 }

  var body: some View {
    TimelineView(.periodic(from: since, by: 1)) { context in
      Text(text(format(seconds: max(0, context.date.timeIntervalSince(since))))).monospacedDigit()
    }
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

/// Whole seconds, e.g. `1h 2m 3s`.
func format(seconds: Double) -> String {
  Duration.seconds(Int(seconds)).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .narrow))
}

func format(durationMs: Int) -> String {
  Duration.milliseconds(durationMs).formatted(
    .units(allowed: [.hours, .minutes, .seconds, .milliseconds], width: .narrow, maximumUnitCount: 2))
}
