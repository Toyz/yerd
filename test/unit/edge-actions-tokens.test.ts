import { createHash, createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  ActionForm, checkActionToken, csrfTag, fillHoles, resolveSecrets, safeBack, signAction, verifyAction,
  type TokenPayload,
} from "../../src/actions/action.js";
import { crossSiteReason } from "../../src/server/app.js";
import { HttpError } from "../../src/respond/response.js";

const A = "a".repeat(32);
const B = "b".repeat(32);

/** What a call threw, as status and message (or "ok"). */
function outcome(fn: () => unknown): string {
  try {
    fn();
    return "ok";
  } catch (error) {
    return error instanceof HttpError ? `${error.status} ${error.message}` : `throws ${(error as Error).name}: ${(error as Error).message}`;
  }
}

function macOf(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

describe("action token signing", () => {
  const payload: TokenPayload = { c: "Todos", a: "remove", p: { id: 7 }, e: 2_000_000_000 };
  const token = signAction(A, payload);
  const [data, sig] = token.split(".") as [string, string];

  it("round-trips the payload", () => {
    expect(verifyAction([A], token)).toEqual(payload);
  });

  it("is two base64url parts with no padding", () => {
    expect(token).toMatch(/^[\w-]+\.[\w-]+$/);
  });

  // Every way of mangling a token is a 400, never a 500 (timingSafeEqual throws on unequal lengths).
  it.each([
    ["empty", "", "400 Malformed action token"],
    ["no dot", data + sig, "400 Malformed action token"],
    ["dot first", `.${sig}`, "400 Malformed action token"],
    ["only a dot", ".", "400 Malformed action token"],
    ["no signature", `${data}.`, "400 Invalid action signature"],
    ["truncated signature", `${data}.${sig.slice(0, -1)}`, "400 Invalid action signature"],
    ["signature one char longer", `${data}.${sig}A`, "400 Invalid action signature"],
    ["signature with a multibyte char of the same length", `${data}.${sig.slice(0, -1)}é`, "400 Invalid action signature"],
    ["third part", `${token}.x`, "400 Invalid action signature"],
    ["truncated payload", `${data.slice(0, -2)}.${sig}`, "400 Invalid action signature"],
    ["payload with whitespace", ` ${token}`, "400 Invalid action signature"],
    ["trailing whitespace", `${token} `, "400 Invalid action signature"],
    ["standard base64 padding on the signature", `${data}.${sig}=`, "400 Invalid action signature"],
    ["signature of another secret", signAction(B, payload), "400 Invalid action signature"],
    ["garbage", "%%%.%%%", "400 Invalid action signature"],
  ])("refuses a token with %s", (_name, bad, expected) => {
    expect(outcome(() => verifyAction([A], bad))).toBe(expected);
  });

  it("refuses a payload changed under the old signature (args, class, action, expiry, session)", () => {
    for (const change of [{ p: { id: 8 } }, { c: "Admin" }, { a: "destroyAll" }, { e: 4_000_000_000 }, { s: "other" }]) {
      const forged = Buffer.from(JSON.stringify({ ...payload, ...change })).toString("base64url");
      expect(outcome(() => verifyAction([A], `${forged}.${sig}`))).toBe("400 Invalid action signature");
    }
  });

  it("refuses a correctly signed payload that isn't JSON as malformed, not a crash", () => {
    const garbage = Buffer.from("{not json").toString("base64url");
    expect(outcome(() => verifyAction([A], `${garbage}.${macOf(A, garbage)}`))).toBe("400 Malformed action token");
  });

  it("checks every secret: rotation accepts the old one until it's dropped", () => {
    const old = signAction(B, payload);
    expect(verifyAction([A, B], old)).toEqual(payload);
    expect(verifyAction([B, A], token)).toEqual(payload);
    expect(outcome(() => verifyAction([A], old))).toBe("400 Invalid action signature");
    expect(outcome(() => verifyAction([], token))).toBe("400 Invalid action signature");
  });
});

describe("checkActionToken", () => {
  const now = Math.floor(Date.now() / 1000);
  const nonce = "nonce-123";
  const tag = csrfTag(nonce);

  it.each([
    ["prerendered (no expiry), sessions on, no session", { e: undefined }, undefined, true, "ok"],
    ["prerendered with a foreign session tag", { e: undefined, s: "zzz" }, nonce, true, "ok"],
    ["fresh, sessions off", { e: now + 60 }, undefined, false, "ok"],
    ["fresh, sessions off, any tag", { e: now + 60, s: "zzz" }, undefined, false, "ok"],
    ["fresh, made for this session", { e: now + 60, s: tag }, nonce, true, "ok"],
    ["expired", { e: now - 1, s: tag }, nonce, true, "403 This form has expired; reload the page and try again"],
    ["expired, sessions off", { e: now - 1 }, undefined, false, "403 This form has expired; reload the page and try again"],
    ["sessions on, token has no tag", { e: now + 60 }, nonce, true, "403 This form was made for a different session; reload the page and try again"],
    ["sessions on, visitor has no nonce", { e: now + 60, s: tag }, undefined, true, "403 This form was made for a different session; reload the page and try again"],
    ["another session's token", { e: now + 60, s: csrfTag("other") }, nonce, true, "403 This form was made for a different session; reload the page and try again"],
    ["the raw nonce instead of its tag", { e: now + 60, s: nonce }, nonce, true, "403 This form was made for a different session; reload the page and try again"],
  ] as const)("%s", (_name, fields, sessionNonce, sessionsOn, expected) => {
    const payload = { c: "X", a: "y", p: {}, ...fields } as TokenPayload;
    expect(outcome(() => checkActionToken(payload, sessionNonce, sessionsOn))).toBe(expected);
  });

  it("csrfTag is a stable 22-char hash that doesn't reveal the nonce", () => {
    expect(csrfTag(nonce)).toBe(tag);
    expect(tag).toHaveLength(22);
    expect(tag).not.toContain(nonce);
    expect(csrfTag("a")).not.toBe(csrfTag("b"));
  });

  it("csrfTag's memo of the last nonce never hands one session's tag to another", () => {
    const sha = (s: string) => createHash("sha256").update(s).digest("base64url").slice(0, 22);
    for (const n of ["a", "a", "b", "a", "b", "b", nonce]) expect(csrfTag(n)).toBe(sha(n));
  });
});

describe("resolveSecrets", () => {
  const saved = { secret: process.env.YERD_SECRET, env: process.env.NODE_ENV };
  afterEach(() => {
    if (saved.secret === undefined) delete process.env.YERD_SECRET;
    else process.env.YERD_SECRET = saved.secret;
    process.env.NODE_ENV = saved.env;
  });

  it("takes an explicit secret or list, newest first", () => {
    expect(resolveSecrets(A)).toEqual([A]);
    expect(resolveSecrets([B, A])).toEqual([B, A]);
  });

  it("splits and trims YERD_SECRET, skipping empty entries", () => {
    process.env.YERD_SECRET = ` ${A} ,, ${B} ,`;
    expect(resolveSecrets(undefined)).toEqual([A, B]);
  });

  it("refuses any secret under 32 bytes, counting bytes not characters", () => {
    expect(() => resolveSecrets("short")).toThrow("at least 32 bytes");
    expect(() => resolveSecrets([A, "short"])).toThrow("at least 32 bytes");
    // 16 two-byte characters are 32 bytes.
    expect(resolveSecrets("é".repeat(16))).toHaveLength(1);
    expect(() => resolveSecrets("a".repeat(31))).toThrow();
  });

  it("falls back to one random secret per process, the same on every call", () => {
    delete process.env.YERD_SECRET;
    process.env.NODE_ENV = "test";
    const first = resolveSecrets(undefined);
    expect(first).toHaveLength(1);
    expect(Buffer.byteLength(first[0]!)).toBeGreaterThanOrEqual(32);
    expect(resolveSecrets(undefined)).toEqual(first);
  });
});

describe("safeBack", () => {
  it.each([
    ["/x", "/x"],
    ["/x?a=1#b", "/x?a=1#b"],
    ["/", "/"],
    ["//evil.com", "/fallback"],
    ["//evil.com/x", "/fallback"],
    ["/\\evil.com", "/fallback"],
    ["\\\\evil.com", "/fallback"],
    ["/\t/evil.com", "/fallback"],
    ["/\n/evil.com", "/fallback"],
    ["/\r/evil.com", "/fallback"],
    ["/\x00x", "/fallback"],
    ["/\x7fx", "/fallback"],
    ["https://evil.com", "/fallback"],
    ["javascript:alert(1)", "/fallback"],
    ["x", "/fallback"],
    ["", "/fallback"],
    [" /x", "/fallback"],
    ["/%2F%2Fevil.com", "/%2F%2Fevil.com"],
    // Dot segments resolve to "//evil.com", a protocol-relative URL: refused (was an open redirect).
    ["/..//evil.com", "/fallback"],
    ["/.//evil.com", "/fallback"],
    ["/x/..//evil.com", "/fallback"],
    ["/%2e%2e//evil.com", "/fallback"],
    ["/x?next=//evil.com", "/x?next=//evil.com"],
    ["/x#//evil.com", "/x#//evil.com"],
    ["/./x", "/x"],
    ["/x/../y", "/y"],
  ])("%j -> %j", (input, expected) => {
    expect(safeBack(input, "/fallback")).toBe(expected);
  });

  it("falls back on null and undefined", () => {
    expect(safeBack(null, "/f")).toBe("/f");
    expect(safeBack(undefined, "/f")).toBe("/f");
  });

  it("never returns something a browser reads as another origin", () => {
    const tricky = ["/..//evil.com", "/.//evil.com", "/%5Cevil.com", "/x/..//evil.com", "/　/evil.com", "/ /evil.com"];
    for (const input of tricky) {
      const out = safeBack(input, "/f");
      expect(new URL(out, "https://site.test").origin).toBe("https://site.test");
      expect(out.startsWith("//")).toBe(false);
    }
  });
});

describe("crossSiteReason", () => {
  const req = (headers: Record<string, string | undefined>) => ({ headers }) as unknown as IncomingMessage;
  const none = new Set<string>();
  const trusted = new Set(["https://admin.example.com"]);

  it.each([
    ["no headers (curl, server to server)", { host: "app.test" }, none, undefined],
    ["Sec-Fetch-Site same-origin", { host: "app.test", "sec-fetch-site": "same-origin" }, none, undefined],
    ["Sec-Fetch-Site none (typed in the address bar)", { host: "app.test", "sec-fetch-site": "none" }, none, undefined],
    ["Sec-Fetch-Site cross-site", { host: "app.test", "sec-fetch-site": "cross-site" }, none, "Cross-site requests are refused"],
    ["Sec-Fetch-Site same-site (a sibling subdomain)", { host: "app.test", "sec-fetch-site": "same-site" }, none, "Cross-site requests are refused"],
    ["cross-site even with a matching Origin", { host: "app.test", origin: "http://app.test", "sec-fetch-site": "cross-site" }, none, "Cross-site requests are refused"],
    ["same-origin verdict beats a mismatched Origin", { host: "app.test", origin: "http://evil.test", "sec-fetch-site": "same-origin" }, none, undefined],
    ["matching Origin", { host: "app.test", origin: "http://app.test" }, none, undefined],
    ["Origin with the default port spelled out", { host: "app.test", origin: "https://app.test:443" }, none, undefined],
    ["Host with the default port spelled out", { host: "app.test:443", origin: "https://app.test" }, none, undefined],
    ["Origin on another port", { host: "app.test", origin: "http://app.test:8080" }, none, "Cross-origin requests are refused"],
    ["Origin of a subdomain", { host: "app.test", origin: "http://evil.app.test" }, none, "Cross-origin requests are refused"],
    ["Origin that only starts with the host", { host: "app.test", origin: "http://app.test.evil.com" }, none, "Cross-origin requests are refused"],
    ["Origin null (sandboxed frame, data: URL)", { host: "app.test", origin: "null" }, none, "Requests from an opaque origin are refused"],
    ["malformed Origin", { host: "app.test", origin: "not a url" }, none, "Malformed Origin header"],
    ["Referer from the same host", { host: "app.test", referer: "http://app.test/page?x=1" }, none, undefined],
    ["Referer from another host", { host: "app.test", referer: "http://evil.test/page" }, none, "Cross-origin requests are refused"],
    ["Referer with userinfo pointing elsewhere", { host: "app.test", referer: "http://app.test@evil.test/" }, none, "Cross-origin requests are refused"],
    ["Origin wins over a same-host Referer", { host: "app.test", origin: "http://evil.test", referer: "http://app.test/" }, none, "Cross-origin requests are refused"],
    ["trusted Origin, even cross-site", { host: "app.test", origin: "https://admin.example.com", "sec-fetch-site": "cross-site" }, trusted, undefined],
    ["trusted origin by Referer", { host: "app.test", referer: "https://admin.example.com/x" }, trusted, undefined],
    ["trusted origin by Referer still loses to a cross-site verdict", { host: "app.test", referer: "https://admin.example.com/x", "sec-fetch-site": "cross-site" }, trusted, "Cross-site requests are refused"],
    ["a trusted origin's other scheme isn't trusted", { host: "app.test", origin: "http://admin.example.com" }, trusted, "Cross-origin requests are refused"],
    ["X-Forwarded-Host is ignored without trustProxy", { host: "internal:3000", origin: "https://app.test", "x-forwarded-host": "app.test" }, none, "Cross-origin requests are refused"],
  ] as const)("%s", (_name, headers, trust, expected) => {
    expect(crossSiteReason(req(headers), trust, false)).toBe(expected);
  });

  it("believes the first X-Forwarded-Host only with trustProxy", () => {
    const headers = { host: "internal:3000", origin: "https://app.test", "x-forwarded-host": "app.test, other.test" };
    expect(crossSiteReason(req(headers), none, true)).toBeUndefined();
    expect(crossSiteReason(req({ ...headers, "x-forwarded-host": "evil.test, app.test" }), none, true)).toBe("Cross-origin requests are refused");
  });
});

describe("fillHoles", () => {
  const fields = (record: Record<string, string | string[]>) => Object.assign(Object.create(null), record);

  it("returns the args untouched when the token has no holes", () => {
    const args = { id: 1, nested: { __yxHole: 0 } };
    expect(fillHoles(args, undefined, fields({}))).toBe(args);
    expect(fillHoles(args, [], fields({ _yxh0: "x" }))).toBe(args);
  });

  it.each([
    [["el", "value"], "  hi ", "  hi "],
    [["el", "textContent"], "", ""],
    [["el", "id"], "x", "x"],
    [["el", "name"], "q", "q"],
    [["el", "checked"], "true", true],
    [["el", "checked"], "false", false],
    [["el", "checked"], "on", false],
    [["el", "checked"], "TRUE", false],
    [["el", "open"], "true", true],
    [["el", "disabled"], "", false],
    [["el", "valueAsNumber"], "42", 42],
    [["el", "valueAsNumber"], "NaN", NaN],
    [["el", "valueAsNumber"], "-1.5e2", -150],
    [["el", "valueAsNumber"], "abc", NaN],
    [["el", "selectedIndex"], "-1", -1],
    [["el", "scrollTop"], "120.5", 120.5],
    [["el", "scrollLeft"], "0", 0],
    [["el", "dataset", "id"], "7", "7"],
    // dataset entries are strings, whatever they're called.
    [["el", "dataset", "checked"], "true", "true"],
    [["el", "dataset", "valueAsNumber"], "3", "3"],
    [["drag", "dataset", "id"], "card-1", "card-1"],
    [["drag", "checked"], "true", true],
    [["ref", "#q", "value"], "cats", "cats"],
    [["ref", "#q", "checked"], "true", true],
    [["ref", "#n", "valueAsNumber"], "5", 5],
    [["ref", "#q", "dataset", "open"], "true", "true"],
    // A selector that happens to read "dataset" is still a selector.
    [["ref", "dataset", "checked"], "true", true],
    [["ref", "dataset", "valueAsNumber"], "2", 2],
  ])("%j from %j is %j", (source, sent, expected) => {
    expect(fillHoles({ v: { __yxHole: 0 } }, [source], fields({ _yxh0: sent }))).toEqual({ v: expected });
  });

  it("fills holes in arrays and nested objects, by index", () => {
    const args = { list: [{ __yxHole: 1 }, "fixed", { deep: { __yxHole: 0 } }], n: 3 };
    const holes = [["el", "value"], ["el", "checked"]];
    expect(fillHoles(args, holes, fields({ _yxh0: "a", _yxh1: "true" }))).toEqual({ list: [true, "fixed", { deep: "a" }], n: 3 });
  });

  it("takes the first of a repeated field", () => {
    expect(fillHoles({ q: { __yxHole: 0 } }, [["el", "value"]], fields({ _yxh0: ["first", "second"] }))).toEqual({ q: "first" });
  });

  it("ignores extra _yxh fields; they can't add arguments", () => {
    expect(fillHoles({ q: { __yxHole: 0 } }, [["el", "value"]], fields({ _yxh0: "a", _yxh1: "evil", _yxh99: "x" }))).toEqual({ q: "a" });
  });

  it("refuses a missing hole with a 400", () => {
    expect(outcome(() => fillHoles({ q: { __yxHole: 0 } }, [["el", "value"]], fields({})))).toBe(
      "400 This action reads the page when it fires, which needs JavaScript",
    );
    // An empty value is a value.
    expect(fillHoles({ q: { __yxHole: 0 } }, [["el", "value"]], fields({ _yxh0: "" }))).toEqual({ q: "" });
  });

  it("refuses a marker whose index has no hole source", () => {
    expect(outcome(() => fillHoles({ q: { __yxHole: 3 } }, [["el", "value"]], fields({ _yxh3: "x" })))).toMatch(/^400 /);
  });

  it("leaves look-alikes alone: extra keys, string indexes", () => {
    const args = { a: { __yxHole: 0, other: 1 }, b: { __yxHole: "0" }, c: { __yxHole: 0 } };
    expect(fillHoles(args, [["el", "value"]], fields({ _yxh0: "v" }))).toEqual({ a: { __yxHole: 0, other: 1 }, b: { __yxHole: "0" }, c: "v" });
  });

  it("a posted hole value is only ever a string, boolean or number, never an object", () => {
    // Bracket names are plain field names to the form parser.
    const out = fillHoles({ q: { __yxHole: 0 } }, [["el", "value"]], fields({ _yxh0: '{"admin":true}', "_yxh0[admin]": "true" }));
    expect(out).toEqual({ q: '{"admin":true}' });
  });

  it("doesn't write through __proto__ keys in the args", () => {
    const args = JSON.parse('{"__proto__": {"polluted": {"__yxHole": 0}}, "q": {"__yxHole": 0}}');
    const out = fillHoles(args, [["el", "value"]], fields({ _yxh0: "x" })) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(out.q).toBe("x");
  });
});

describe("ActionForm", () => {
  const form = new ActionForm(
    Object.assign(Object.create(null), { one: "1", many: ["a", "b"], empty: "" }),
    Object.assign(Object.create(null), {
      pic: [new File(["x"], "a.png"), new File([], "")],
      none: [new File([], "")],
      blank: [new File([], "blank.txt")],
    }),
  );

  it.each([
    ["get", "one", "1"],
    ["get", "many", "a"],
    ["get", "empty", ""],
    ["get", "missing", undefined],
    ["has", "empty", true],
    ["has", "missing", false],
    ["has", "pic", false],
    ["has", "__proto__", false],
    ["has", "toString", false],
  ] as const)("%s(%j) is %j", (method, name, expected) => {
    expect((form[method] as (n: string) => unknown)(name)).toBe(expected);
  });

  it("all() lists every value; string() 400s on a missing field", () => {
    expect(form.all("one")).toEqual(["1"]);
    expect(form.all("many")).toEqual(["a", "b"]);
    expect(form.all("missing")).toEqual([]);
    expect(form.string("empty")).toBe("");
    expect(outcome(() => form.string("missing"))).toBe("400 Missing form field: missing");
  });

  it("files() skips an empty file input but keeps an empty named file", () => {
    expect(form.files("pic").map((f) => f.name)).toEqual(["a.png"]);
    expect(form.file("none")).toBeUndefined();
    expect(form.file("blank")?.name).toBe("blank.txt");
    expect(form.files("missing")).toEqual([]);
    expect(form.files("__proto__")).toEqual([]);
  });
});
