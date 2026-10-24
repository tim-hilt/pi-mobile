import SwiftUI

/// The synced conversation, newest at the bottom, with the composer and the session's status below it.
struct TranscriptView: View {
  let client: BridgeClient
  /// Called with the config from a scanned pairing QR code.
  let onPair: (BridgeConfig) -> Void

  @State private var showingScanner = false
  @State private var showingSessions = false
  @State private var showingModels = false

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        conversation
        ComposerView(client: client)
        if client.transcript.sessionId != nil {
          StatusBar(cwd: client.transcript.cwd, status: client.transcript.status) { showingModels = true }
            .disabled(client.state != .connected || client.transcript.hasEnded)
        }
      }
      .navigationTitle(client.transcript.cwd.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "Transcript")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        Button("Sessions", systemImage: "list.bullet") { showingSessions = true }
          .disabled(client.state != .connected)
      }
      .sheet(isPresented: $showingSessions) { SessionsView(client: client) }
      .sheet(isPresented: $showingModels) { ModelsView(client: client) }
      .sheet(isPresented: $showingScanner) { PairingScanner(onScan: onPair) }
    }
  }

  @ViewBuilder private var conversation: some View {
    let transcript = client.transcript
    if client.state != .connected && transcript.sessionId == nil {
      ContentUnavailableView {
        Label("Not connected", systemImage: "network.slash")
      } description: {
        Text("Run the bridge on your Mac and scan the QR code it prints.")
      } actions: {
        Button("Scan QR Code to Log In", systemImage: "qrcode.viewfinder") { showingScanner = true }
          .buttonStyle(.borderedProminent)
      }
    } else if transcript.sessionId == nil {
      ContentUnavailableView {
        Label("No session joined", systemImage: "terminal")
      } description: {
        Text("Start pi on your Mac, then pick its session.")
      } actions: {
        Button("Sessions") { showingSessions = true }
      }
    } else if transcript.entries.isEmpty && !transcript.isRunning && !transcript.hasEnded {
      ContentUnavailableView("No messages yet", systemImage: "text.bubble")
    } else {
      ScrollView {
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
      .defaultScrollAnchor(.bottom)
      .scrollDismissesKeyboard(.interactively)
    }
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
