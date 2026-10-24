import Foundation
import Testing

@testable import PiMobile

@Suite struct MarkdownTests {
  /// The blocks of `source` with their text flattened, so tests read like the rendered layout.
  private func blocks(_ source: String) -> [String] {
    Markdown(parsing: source).blocks.map { block in
      switch block {
      case .paragraph(let text): "p \(plain(text))"
      case .heading(let level, let text): "h\(level) \(plain(text))"
      case .listItem(let marker, let depth, let text): "\(depth) \(marker ?? "_") \(plain(text))"
      case .quote(let text): "> \(plain(text))"
      case .code(let code): "code \(code)"
      case .table(let rows): "table " + rows.map { $0.map(plain).joined(separator: "|") }.joined(separator: "/")
      case .rule: "rule"
      }
    }
  }

  private func plain(_ text: AttributedString) -> String { String(text.characters) }

  @Test func paragraphsAndHeadingsAreSeparateBlocks() {
    #expect(blocks("# Title\n\nFirst\n\n### Sub\nSecond") == ["h1 Title", "p First", "h3 Sub", "p Second"])
  }

  @Test func inlineStylingStaysOnTheBlockText() throws {
    guard case .paragraph(let text) = Markdown(parsing: "a **bold** `code`").blocks.first else {
      Issue.record("expected a paragraph")
      return
    }
    let bold = try #require(text.range(of: "bold"))
    let code = try #require(text.range(of: "code"))
    #expect(text[bold].inlinePresentationIntent == .stronglyEmphasized)
    #expect(text[code].inlinePresentationIntent == .code)
    #expect(text.runs.allSatisfy { $0.presentationIntent == nil })
  }

  @Test func listItemsCarryTheirMarkerAndNesting() {
    let source = """
      - one
      - two
        - nested

        more of two
      1. first
      2. second
      """
    #expect(
      blocks(source) == [
        "1 • one", "1 • two", "2 • nested", "1 _ more of two", "1 1. first", "1 2. second",
      ])
  }

  @Test func codeBlocksKeepTheirLinesWithoutTheTrailingNewline() {
    #expect(blocks("```swift\nlet a = 1\nlet b = 2\n```") == ["code let a = 1\nlet b = 2"])
  }

  @Test func anUnclosedCodeFenceIsCodeUntilTheEnd() {
    #expect(blocks("Look:\n```\nlet a") == ["p Look:", "code let a"])
  }

  @Test func quotesRulesAndTables() {
    let source = """
      > quoted

      ---

      | a | b |
      |---|---|
      | 1 | 2 |
      """
    #expect(blocks(source) == ["> quoted", "rule", "table a|b/1|2"])
  }

  @Test func adjacentTablesStaySeparate() {
    #expect(blocks("| a |\n|---|\n| 1 |\n\n| b |\n|---|\n| 2 |") == ["table a/1", "table b/2"])
  }

  @Test func plainTextIsOneParagraph() {
    #expect(blocks("just text") == ["p just text"])
    #expect(blocks("") == [])
  }
}
