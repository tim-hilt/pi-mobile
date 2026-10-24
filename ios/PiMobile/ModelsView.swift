import SwiftUI

/// Sheet listing the models the joined session can switch to, grouped by provider, to pick one.
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
        ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
      }
      .task { await load() }
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

  /// Switches and closes the sheet on success; the status bar then shows the new model.
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
