import { expect, test } from "vitest";
import { pairingQr, pairingUrl } from "./pairing.js";

test("encodes address and token into a pimobile://connect URL", () => {
  const url = new URL(pairingUrl("wss://pi.example.com", "a b&c"));
  expect(url.protocol).toBe("pimobile:");
  expect(url.host).toBe("connect");
  expect(url.searchParams.get("url")).toBe("wss://pi.example.com");
  expect(url.searchParams.get("token")).toBe("a b&c");
});

test("renders a multi-line QR code", () => {
  expect(
    pairingQr(pairingUrl("wss://pi.example.com", "t")).split("\n").length
  ).toBeGreaterThan(10);
});
