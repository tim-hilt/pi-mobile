import { expect, test } from "vitest";
import { focusChange } from "./terminalFocus.js";

test("the terminal's focus-in and focus-out codes are focus changes", () => {
  expect(focusChange("\x1b[I")).toBe(true);
  expect(focusChange("\x1b[O")).toBe(false);
});

test.each(["a", "\x1b[A", "\x1b[200~\x1b[I", "", "\x1b[I\x1b[O", "\x1b"])(
  "other input %j passes through",
  (data) => {
    expect(focusChange(data)).toBeUndefined();
  }
);
