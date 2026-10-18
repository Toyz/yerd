// seal()/unseal(): what the cookie store trusts. Anything a client changes must come back undefined.
import { describe, expect, it } from "vitest";
import { seal, unseal } from "@toyz/yerd";

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

describe("seal / unseal round trips", () => {
  it.each<[string, unknown]>([
    ["an object", { user: "ada", n: 1 }],
    ["an array", [1, "two", null, { three: 3 }]],
    ["null", null],
    ["false", false],
    ["zero", 0],
    ["a negative float", -1.5],
    ["an empty string", ""],
    ["an empty object", {}],
    ["unicode", { name: "é中\u{1f600}", rtl: "‮" }],
    ["a NUL and control characters", { s: "a\u0000b\u0001\n\r\t" }],
    ["deep nesting", JSON.parse("[".repeat(200) + "]".repeat(200)) as unknown],
    ["a __proto__ key, as data", JSON.parse('{"__proto__":{"admin":true}}') as unknown],
  ])("keeps %s", (_label, value) => {
    expect(unseal([B], seal([A], value))).toBeUndefined();
    expect(unseal([A], seal([A], value))).toEqual(value);
  });

  it("drops what JSON drops: undefined fields, functions; dates become strings", () => {
    const at = new Date(0);
    expect(unseal([A], seal([A], { u: undefined, f: () => 1, at }))).toEqual({ at: at.toISOString() });
  });

  it("refuses to seal what JSON can't hold", () => {
    expect(() => seal([A], { n: 1n })).toThrow(TypeError);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => seal([A], loop)).toThrow(TypeError);
  });

  it("refuses to seal undefined (JSON.stringify gives no text to encrypt)", () => {
    expect(() => seal([A], undefined)).toThrow(TypeError);
  });

  it("uses a fresh IV every time: the same value never seals the same way twice", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(seal([A], { same: true }));
    expect(seen.size).toBe(50);
  });

  it("produces base64url only (safe in a cookie without encoding)", () => {
    for (let i = 0; i < 20; i++) expect(seal([A], { i, s: "+/=" })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("handles a large value", () => {
    const big = { blob: "x".repeat(1_000_000) };
    expect(unseal([A], seal([A], big))).toEqual(big);
  });
});

describe("unseal refuses anything tampered", () => {
  const sealed = seal([A], { user: "ada", role: "admin" });
  const raw = Buffer.from(sealed, "base64url");

  it("flipping any single bit of any byte (iv, tag, ciphertext)", () => {
    for (let i = 0; i < raw.length; i++) {
      for (const bit of [0x01, 0x80]) {
        const copy = Buffer.from(raw);
        copy[i]! ^= bit;
        expect(unseal([A], copy.toString("base64url")), `byte ${i} bit ${bit}`).toBeUndefined();
      }
    }
  });

  it("every truncation", () => {
    for (let n = 0; n < raw.length; n++) {
      expect(unseal([A], raw.subarray(0, n).toString("base64url")), `first ${n} bytes`).toBeUndefined();
    }
  });

  it("extra bytes appended or prepended", () => {
    expect(unseal([A], Buffer.concat([raw, Buffer.from([0])]).toString("base64url"))).toBeUndefined();
    expect(unseal([A], Buffer.concat([Buffer.from([0]), raw]).toString("base64url"))).toBeUndefined();
    expect(unseal([A], sealed + sealed)).toBeUndefined();
  });

  it("swapping the tag from another sealing of the same value", () => {
    const other = Buffer.from(seal([A], { user: "ada", role: "admin" }), "base64url");
    const mixed = Buffer.concat([raw.subarray(0, 12), other.subarray(12, 28), raw.subarray(28)]);
    expect(unseal([A], mixed.toString("base64url"))).toBeUndefined();
  });

  it("splicing ciphertext from one cookie under another's iv and tag", () => {
    const other = Buffer.from(seal([A], { user: "bob", role: "user!" }), "base64url");
    const spliced = Buffer.concat([raw.subarray(0, 28), other.subarray(28)]);
    expect(unseal([A], spliced.toString("base64url"))).toBeUndefined();
  });

  it.each([
    ["empty", ""],
    ["one char", "a"],
    ["not base64 at all", "!!!!@@@@####$$$$%%%%^^^^&&&&****(((("],
    ["spaces", " ".repeat(64)],
    ["percent-encoded", encodeURIComponent(raw.toString("base64"))],
    ["unicode", "é".repeat(64)],
    ["a JSON object", JSON.stringify({ user: "ada" })],
    ["exactly 28 zero bytes", Buffer.alloc(28).toString("base64url")],
    ["29 zero bytes", Buffer.alloc(29).toString("base64url")],
    ["a huge string", "A".repeat(2_000_000)],
  ])("garbage: %s", (_label, value) => {
    expect(unseal([A], value)).toBeUndefined();
  });

  it("accepts standard base64 for the same bytes (Buffer decodes both alphabets): still authenticated", () => {
    // Not a weakness: the bytes are identical, so the tag still has to verify.
    expect(unseal([A], raw.toString("base64"))).toEqual({ user: "ada", role: "admin" });
  });
});

describe("secrets and rotation", () => {
  it("refuses a value sealed with another secret", () => {
    expect(unseal([B], seal([A], 1))).toBeUndefined();
  });

  it("opens with any listed secret, in any position", () => {
    const old = seal([A], { v: 1 });
    expect(unseal([B, A], old)).toEqual({ v: 1 });
    expect(unseal([B, C, A], old)).toEqual({ v: 1 });
    expect(unseal([A, B], old)).toEqual({ v: 1 });
  });

  it("seals with the first secret only", () => {
    const fresh = seal([B, A], { v: 2 });
    expect(unseal([B], fresh)).toEqual({ v: 2 });
    expect(unseal([A], fresh)).toBeUndefined();
  });

  it("stops opening once the old secret is dropped", () => {
    const old = seal([A], { v: 1 });
    expect(unseal([B], old)).toBeUndefined();
  });

  it("opens nothing with no secrets", () => {
    expect(unseal([], seal([A], 1))).toBeUndefined();
  });

  it("derives distinct keys: secrets differing in one character don't open each other", () => {
    const near = "a".repeat(31) + "b";
    expect(unseal([near], seal([A], 1))).toBeUndefined();
  });

  it("is not fooled by a secret that is a prefix of another", () => {
    const longer = A + "x";
    expect(unseal([longer], seal([A], 1))).toBeUndefined();
    expect(unseal([A], seal([longer], 1))).toBeUndefined();
  });
});
