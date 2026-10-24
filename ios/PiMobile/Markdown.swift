import Foundation

/// Markdown split into the blocks a view stacks one below the other. Each block's text keeps its
/// inline styling (emphasis, code, links) for `Text` to render; block structure is in the case.
struct Markdown: Equatable {
  enum Block: Equatable {
    case paragraph(AttributedString)
    case heading(level: Int, AttributedString)
    /// One paragraph of a list item. `marker` (`•` or `3.`) is set on the item's first paragraph
    /// only; `depth` is 1 for a top-level list.
    case listItem(marker: String?, depth: Int, AttributedString)
    case quote(AttributedString)
    /// A fenced or indented code block, without its trailing newline.
    case code(String)
    /// Rows of cells, the header row first.
    case table([[AttributedString]])
    case rule
  }

  let blocks: [Block]

  /// Never fails: text Foundation can't parse becomes one plain paragraph.
  init(parsing source: String) {
    guard
      let parsed = try? AttributedString(
        markdown: source,
        options: .init(interpretedSyntax: .full, failurePolicy: .returnPartiallyParsedIfPossible))
    else {
      blocks = source.isEmpty ? [] : [.paragraph(AttributedString(source))]
      return
    }

    // Foundation tags every run with its block's `presentationIntent`: the chain of enclosing
    // blocks, innermost first, each with an identity unique within the document.
    var blocks: [Block] = []
    var startedListItems: Set<Int> = []
    /// Identities of the table and row the last cell belonged to; each cell is its own run.
    var lastCell: (table: Int, row: Int)?
    for (intent, range) in parsed.runs[\.presentationIntent] {
      var text = AttributedString(parsed[range])
      text.presentationIntent = nil
      let components = intent?.components ?? []

      if let row = components.first(where: \.kind.isTableRow),
        let table = components.first(where: \.kind.isTable)
      {
        if lastCell?.table == table.identity, case .table(var rows) = blocks.last {
          if lastCell?.row == row.identity { rows[rows.count - 1].append(text) } else { rows.append([text]) }
          blocks[blocks.count - 1] = .table(rows)
        } else {
          blocks.append(.table([[text]]))
        }
        lastCell = (table.identity, row.identity)
        continue
      }
      lastCell = nil
      blocks.append(Self.block(text, in: components, startedListItems: &startedListItems))
    }
    self.blocks = blocks
  }

  /// The block for `text`, given its enclosing blocks innermost first. `startedListItems` holds
  /// the identities of list items whose first paragraph has been seen.
  private static func block(
    _ text: AttributedString, in components: [PresentationIntent.IntentType],
    startedListItems: inout Set<Int>
  ) -> Block {
    for component in components {
      switch component.kind {
      case .header(let level): return .heading(level: level, text)
      case .codeBlock: return .code(String(text.characters).replacing(/\n$/, with: ""))
      case .thematicBreak: return .rule
      case .blockQuote: return .quote(text)
      case .listItem(let ordinal):
        let lists = components.filter { $0.kind == .orderedList || $0.kind == .unorderedList }
        let isFirstParagraph = startedListItems.insert(component.identity).inserted
        let marker = lists.first?.kind == .orderedList ? "\(ordinal)." : "•"
        return .listItem(marker: isFirstParagraph ? marker : nil, depth: lists.count, text)
      default: continue
      }
    }
    return .paragraph(text)
  }
}

extension PresentationIntent.Kind {
  fileprivate var isTableRow: Bool {
    switch self {
    case .tableHeaderRow, .tableRow: true
    default: false
    }
  }

  fileprivate var isTable: Bool {
    if case .table = self { true } else { false }
  }
}
