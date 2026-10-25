import SwiftUI

/// Sheet to set the joined session's thinking level, and to pick a model from those it can switch
/// to, grouped by provider.
struct ModelsView: View {
  let client: BridgeClient

  @Environment(\.dismiss) private var dismiss
  @State private var models: [ModelInfo]?
  @State private var query = ""
  @State private var failure: String?

  /// Providers in the order pi lists them, each with its models matching `query`.
  private var groups: [(provider: String, models: [ModelInfo])] {
    var order: [String] = []
    var byProvider: [String: [ModelInfo]] = [:]
    for model in models ?? [] where query.isEmpty || "\(model.provider) \(model.id) \(model.name)".localizedStandardContains(query) {
      if byProvider[model.provider] == nil { order.append(model.provider) }
      byProvider[model.provider, default: []].append(model)
    }
    return order.map { ($0, byProvider[$0] ?? []) }
  }

  var body: some View {
    NavigationStack {
      List {
        if let failure { Text(failure).font(.footnote).foregroundStyle(.red) }
        thinkingPicker
        if models?.isEmpty == true {
          ContentUnavailableView(
            "No models", systemImage: "cpu", description: Text("Log in to a provider in pi with /login."))
        }
        ForEach(groups, id: \.provider) { group in
          Section(group.provider) {
            ForEach(group.models, id: \.self) { model in
              Button { select(model) } label: { row(model) }
            }
          }
        }
      }
      .overlay { if models == nil && failure == nil { ProgressView() } }
      .searchable(text: $query)
      .navigationTitle("Model")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(role: .close) { dismiss() } }
      }
      .task { await load() }
    }
  }

  /// Hidden for models that can't think (their only level is `off`) and while searching.
  @ViewBuilder private var thinkingPicker: some View {
    let status = client.transcript.status
    if query.isEmpty, status.thinkingLevels.count > 1, let level = status.thinkingLevel {
      Picker("Thinking", selection: Binding(get: { level }, set: setThinkingLevel)) {
        ForEach(status.thinkingLevels, id: \.self) { Text($0.capitalized).tag($0) }
      }
    }
  }

  private func row(_ model: ModelInfo) -> some View {
    HStack {
      VStack(alignment: .leading, spacing: 2) {
        Text(model.name)
        Text(model.id).font(.caption.monospaced()).foregroundStyle(.secondary)
      }
      Spacer()
      // The status names only the model's id; the same id under two providers is rare enough.
      if model.id == client.transcript.status.model { Image(systemName: "checkmark").foregroundStyle(.tint) }
    }
    .foregroundStyle(.primary)
  }

  private func load() async {
    do {
      models = try await client.models()
      failure = nil
    } catch {
      failure = error.localizedDescription
    }
  }

  /// Stays open: the picker follows once pi's status reports the new level.
  private func setThinkingLevel(_ level: String) {
    Task {
      do {
        try await client.setThinkingLevel(level)
        failure = nil
      } catch {
        failure = error.localizedDescription
      }
    }
  }

  /// Switches and closes the sheet on success; the composer then shows the new model.
  private func select(_ model: ModelInfo) {
    Task {
      do {
        try await client.setModel(model)
        dismiss()
      } catch {
        failure = error.localizedDescription
      }
    }
  }
}
