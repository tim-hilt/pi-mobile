import Foundation

/// What the composer offers while the user types a `/` skill or an `@` file reference.
enum Suggestions {
  /// What the draft is asking for, and what has been typed of it so far.
  enum Trigger: Equatable, Hashable {
    /// The draft is a lone `/word`: a skill invocation.
    case skill(query: String)
    /// The last word starts with `@`: a file reference.
    case file(query: String)
  }

  /// A suggestion the user picked.
  enum Pick: Equatable {
    case skill(Skill)
    case file(String)
  }

  /// The active trigger of `draft`, if any. Skills only trigger at the very start of the message.
  static func trigger(in draft: String) -> Trigger? {
    if draft.hasPrefix("/"), !draft.contains(where: \.isWhitespace) {
      let query = draft.dropFirst()
      return .skill(query: String(query.hasPrefix("skill:") ? query.dropFirst("skill:".count) : query))
    }
    let word = lastWord(of: draft)
    return word.hasPrefix("@") ? .file(query: String(word.dropFirst())) : nil
  }

  /// `skills` whose name matches `query`, case-insensitively: prefix matches first, then substring
  /// matches, each in the given order. An empty query matches all.
  static func skills(matching query: String, in skills: [Skill]) -> [Skill] {
    let query = query.lowercased()
    let prefixed = skills.filter { $0.name.lowercased().hasPrefix(query) }
    let contained = skills.filter { !$0.name.lowercased().hasPrefix(query) && $0.name.lowercased().contains(query) }
    return prefixed + contained
  }

  /// `draft` with the trigger word replaced by `pick`, followed by a space to keep typing.
  static func inserting(_ pick: Pick, into draft: String) -> String {
    switch pick {
    case .skill(let skill): return "/skill:\(skill.name) "
    case .file(let path): return draft.dropLast(lastWord(of: draft).count) + "@\(path) "
    }
  }

  private static func lastWord(of text: String) -> Substring {
    text[(text.lastIndex(where: \.isWhitespace).map { text.index(after: $0) } ?? text.startIndex)...]
  }
}
