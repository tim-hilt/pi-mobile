import Testing

@testable import PiMobile

@Suite struct SuggestionsTests {
  private let skills = [
    Skill(name: "tdd", description: "Test-driven development."),
    Skill(name: "pr", description: "Write a PR body."),
    Skill(name: "diagnosing-bugs", description: "Debug hard bugs."),
    Skill(name: "prototype", description: "Build a throwaway prototype."),
  ]

  // MARK: Triggers

  @Test func aSlashAtTheStartOfTheDraftTriggersSkills() {
    #expect(Suggestions.trigger(in: "/") == .skill(query: ""))
    #expect(Suggestions.trigger(in: "/td") == .skill(query: "td"))
  }

  @Test func theSkillPrefixIsNotPartOfTheQuery() {
    #expect(Suggestions.trigger(in: "/skill:td") == .skill(query: "td"))
  }

  @Test func aSlashDoesNotTriggerOnceTheSkillIsChosenOrMidMessage() {
    #expect(Suggestions.trigger(in: "/skill:tdd add") == nil)
    #expect(Suggestions.trigger(in: "see /tmp") == nil)
    #expect(Suggestions.trigger(in: "") == nil)
  }

  @Test func anAtSignStartingTheLastWordTriggersFiles() {
    #expect(Suggestions.trigger(in: "@") == .file(query: ""))
    #expect(Suggestions.trigger(in: "look at @src/ser") == .file(query: "src/ser"))
    #expect(Suggestions.trigger(in: "multi\nline @a") == .file(query: "a"))
  }

  @Test func anAtSignInsideAWordOrBeforeASpaceDoesNotTrigger() {
    #expect(Suggestions.trigger(in: "mail me@host") == nil)
    #expect(Suggestions.trigger(in: "@src/a.ts and") == nil)
    #expect(Suggestions.trigger(in: "@src/a.ts ") == nil)
  }

  // MARK: Skill matching

  @Test func anEmptyQueryOffersEverySkill() {
    #expect(Suggestions.skills(matching: "", in: skills) == skills)
  }

  @Test func skillsMatchByPrefixBeforeSubstringIgnoringCase() {
    #expect(Suggestions.skills(matching: "PR", in: skills).map(\.name) == ["pr", "prototype"])
    #expect(Suggestions.skills(matching: "bug", in: skills).map(\.name) == ["diagnosing-bugs"])
    #expect(Suggestions.skills(matching: "zzz", in: skills).isEmpty)
  }

  // MARK: Insertion

  @Test func pickingASkillReplacesTheSlashWordWithTheInvocation() {
    #expect(Suggestions.inserting(.skill(skills[0]), into: "/td") == "/skill:tdd ")
  }

  @Test func pickingAFileReplacesTheAtWordWithTheReference() {
    #expect(Suggestions.inserting(.file("src/server.ts"), into: "look at @ser") == "look at @src/server.ts ")
    #expect(Suggestions.inserting(.file("a.ts"), into: "@") == "@a.ts ")
  }
}
