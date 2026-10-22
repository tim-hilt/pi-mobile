import SwiftUI

/// The synced conversation, newest at the bottom, with the composer below it.
struct TranscriptView: View {
  let client: BridgeClient

  var body: some View {
    VStack(spacing: 0) {
      conversation
      ComposerView(client: client)
    }
  }

  @ViewBuilder private var conversation: some View {
    let transcript = client.transcript
    if transcript.entries.isEmpty && !transcript.isRunning {
      ContentUnavailableView(
        client.state == .connected ? "No messages yet" : "Not connected",
        systemImage: "text.bubble")
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
        DisclosureGroup("Reasoning") {
          Text(message.thinking).italic()
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
      }
      if !message.text.isEmpty { Text(message.text) }
      if message.isStreaming { ProgressView() }
    }
    .padding(message.role == .user ? 10 : 0)
    .background(message.role == .user ? Color.accentColor.opacity(0.15) : .clear, in: .rect(cornerRadius: 12))
    .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
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

private func format(durationMs: Int) -> String {
  Duration.milliseconds(durationMs).formatted(
    .units(allowed: [.hours, .minutes, .seconds, .milliseconds], width: .narrow, maximumUnitCount: 2))
}
