import { expect, test } from "vitest";
import { PROTOCOL_VERSION } from "./protocol.js";

test("bridge speaks protocol version 3", () => {
  expect(PROTOCOL_VERSION).toBe(3);
});
