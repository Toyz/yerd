import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cookie, currentContext, get, parseCookies, route, serializeCookie, toInt, yerd,
  type CookieOptions, type RunningServer,
} from "@toyz/yerd";

describe("parseCookies", () => {
  it.each<[string | undefined, Record<string, string>]>([
    [undefined, {}],
    ["", {}],
    ["a=1", { a: "1" }],
    ["a=1; b=2", { a: "1", b: "2" }],
    ["a=1;b=2", { a: "1", b: "2" }],
    ["  a  =  1  ;   b=2  ", { a: "1", b: "2" }],
    ["a=1; a=2", { a: "1" }],
    ["a=; b=2", { a: "", b: "2" }],
    ["a=b=c", { a: "b=c" }],
    ["a=%20x%3B", { a: " x;" }],
    ["a=%E2%9C%93", { a: "✓" }],
    ["a=%E0%A4%A", { a: "%E0%A4%A" }],
    ["a=%", { a: "%" }],
    ["a=%ZZ; b=ok", { a: "%ZZ", b: "ok" }],
    ['a="quoted"', { a: "quoted" }],
    ['a=""', { a: "" }],
    ['a="%41"', { a: "A" }],
    ['a="unterminated', { a: '"unterminated' }],
    ['a=x"', { a: 'x"' }],
    ["novalue; b=2", { b: "2" }],
    ["=nameless; b=2", { b: "2" }],
    [";;;", {}],
    ["; a=1 ;", { a: "1" }],
    ["a=1, b=2", { a: "1, b=2" }],
    ["A=1; a=2", { A: "1", a: "2" }],
  ])("%j", (header, expected) => {
    expect({ ...parseCookies(header) }).toEqual(expected);
  });

  // Regression: "=x" was skipped but " =x" (a space before the =) was stored under "".
  it("skips a nameless cookie whatever the whitespace", () => {
    expect(Object.keys(parseCookies(" =x; \t=y; b=2"))).toEqual(["b"]);
  });

  // Regression: a lone '"' both starts and ends with a quote, so it was "unquoted" to "".
  it('keeps a single " value as is', () => {
    expect(parseCookies('a="').a).toBe('"');
  });

  it("returns a null-prototype object, so __proto__ and constructor are plain names", () => {
    const out = parseCookies("__proto__=x; constructor=y");
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(out.__proto__).toBe("x");
    expect(out.constructor).toBe("y");
    expect(parseCookies("a=1").constructor).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("handles a very long header with many cookies", () => {
    const header = Array.from({ length: 5000 }, (_, i) => `c${i}=${i}`).join("; ");
    const out = parseCookies(header);
    expect(Object.keys(out)).toHaveLength(5000);
    expect(out.c4999).toBe("4999");
  });
});

describe("serializeCookie", () => {
  it("applies the defaults", () => {
    expect(serializeCookie("a", "b")).toBe("a=b; Path=/; HttpOnly; SameSite=Lax");
  });

  it.each<[CookieOptions, string]>([
    [{ maxAge: 60 }, "a=b; Max-Age=60; Path=/; HttpOnly; SameSite=Lax"],
    [{ maxAge: 59.9 }, "a=b; Max-Age=59; Path=/; HttpOnly; SameSite=Lax"],
    [{ maxAge: 0 }, "a=b; Max-Age=0; Path=/; HttpOnly; SameSite=Lax"],
    [{ maxAge: -5 }, "a=b; Max-Age=-5; Path=/; HttpOnly; SameSite=Lax"],
    [{ expires: new Date(0) }, "a=b; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax"],
    [{ path: "/app" }, "a=b; Path=/app; HttpOnly; SameSite=Lax"],
    [{ domain: "example.com" }, "a=b; Path=/; Domain=example.com; HttpOnly; SameSite=Lax"],
    [{ domain: "" }, "a=b; Path=/; HttpOnly; SameSite=Lax"],
    [{ httpOnly: false }, "a=b; Path=/; SameSite=Lax"],
    [{ secure: true, sameSite: "None" }, "a=b; Path=/; HttpOnly; Secure; SameSite=None"],
    [{ sameSite: "Strict" }, "a=b; Path=/; HttpOnly; SameSite=Strict"],
  ])("%j", (options, expected) => {
    expect(serializeCookie("a", "b", options)).toBe(expected);
  });

  it.each([
    ["", "empty"],
    ["a b", "space"],
    ["a;b", "semicolon"],
    ["a=b", "equals"],
    ["a,b", "comma"],
    ['a"b', "quote"],
    ["a\r\nSet-Cookie: x=y", "CRLF"],
    ["a\0", "NUL"],
    ["café", "non-ASCII"],
    ["a(b)", "separator"],
  ])("refuses the name %j (%s)", (name) => {
    expect(() => serializeCookie(name, "v")).toThrow(TypeError);
  });

  it.each([
    ["a;b=c", "a%3Bb%3Dc"],
    ["x\r\nSet-Cookie: evil=1", "x%0D%0ASet-Cookie%3A%20evil%3D1"],
    ["; Domain=evil.com", "%3B%20Domain%3Devil.com"],
    ['"q"', "%22q%22"],
    ["✓", "%E2%9C%93"],
    ["", ""],
  ])("percent-encodes the value %j", (value, encoded) => {
    expect(serializeCookie("a", value)).toBe(`a=${encoded}; Path=/; HttpOnly; SameSite=Lax`);
  });

  it("round-trips through parseCookies", () => {
    const values = ["plain", "with space", "semi;colon", "eq=uals", "✓ unicode", '"quotes"', "%41 literal percent"];
    for (const value of values) {
      const set = serializeCookie("k", value);
      const pair = set.split(";")[0]!;
      expect(parseCookies(pair).k).toBe(value);
    }
  });

  // Regression: path and domain went into the header verbatim, so a ";" let a
  // caller-supplied value add attributes, and CR/LF reached the socket layer.
  it.each<[CookieOptions]>([
    [{ path: "/; Domain=evil.com" }],
    [{ path: "/\r\nSet-Cookie: evil=1" }],
    [{ path: "/a\0" }],
    [{ domain: "example.com; Secure" }],
    [{ domain: "example.com\nX: y" }],
  ])("refuses attribute injection through %j", (options) => {
    expect(() => serializeCookie("a", "b", options)).toThrow(TypeError);
  });

  // Regression: these wrote "Max-Age=NaN" / "Expires=Invalid Date", which
  // browsers ignore, silently turning the cookie into a session cookie.
  it.each<[string, CookieOptions]>([
    ["maxAge NaN", { maxAge: NaN }],
    ["maxAge Infinity", { maxAge: Infinity }],
    ["maxAge -Infinity", { maxAge: -Infinity }],
    ["expires Invalid Date", { expires: new Date(NaN) }],
  ])("refuses a nonsense lifetime (%s)", (_label, options) => {
    expect(() => serializeCookie("a", "b", options)).toThrow(TypeError);
  });
});

@route("/cookies")
class CookiePage {
  @cookie("theme") accessor theme = "light";
  @cookie("n", { transform: toInt }) accessor n: number | undefined;
  @cookie("sid", { required: true }) accessor sid!: string;
  @cookie("constructor") accessor ctor: string | undefined;

  @get read() {
    return { theme: this.theme, n: this.n ?? null, sid: this.sid, ctor: this.ctor ?? null };
  }
}

@route("/set")
class SetPage {
  @get set() {
    const ctx = currentContext();
    const q = ctx.query;
    const options: CookieOptions = {};
    if (q.has("path")) options.path = q.get("path")!;
    if (q.has("maxAge")) options.maxAge = Number(q.get("maxAge"));
    ctx.setCookie("a", q.get("v") ?? "1", options);
    ctx.setCookie("b", "2");
    ctx.deleteCookie("old", { path: "/x" });
    return "ok";
  }
}

let server: RunningServer;
beforeAll(async () => {
  // The refused cookies below are 500s, which log; keep the test output clean.
  server = await yerd({ routes: [CookiePage, SetPage] }).logging({ filter: "off" }).listen(0, "127.0.0.1");
});
afterAll(() => server.close());

const withCookie = (value: string) => fetch(server.url + "/cookies", { headers: { cookie: value } });

describe("@cookie and Set-Cookie over HTTP", () => {
  it("reads cookies, with the initializer as default and transforms applied", async () => {
    const r = await withCookie("sid=abc; n=42");
    expect(await r.json()).toEqual({ theme: "light", n: 42, sid: "abc", ctor: null });
  });

  it("a required cookie that's missing is a 400", async () => {
    const r = await withCookie("theme=dark");
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("Missing required cookie: sid");
  });

  it("a cookie that fails its transform is a 400 with the transform's message", async () => {
    const r = await withCookie("sid=x; n=4.2");
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('Expected an integer, got "4.2"');
  });

  it("the first of duplicate cookies wins, and an empty value is still present", async () => {
    const r = await withCookie("sid=first; sid=second; theme=");
    expect(await r.json()).toEqual({ theme: "", n: null, sid: "first", ctor: null });
  });

  it("garbage around real cookies doesn't break parsing", async () => {
    const r = await withCookie(";;garbage; =x; sid=%E0%A4%A; theme=%E2%9C%93;");
    expect(await r.json()).toEqual({ theme: "✓", n: null, sid: "%E0%A4%A", ctor: null });
  });

  it("constructor is only read when sent", async () => {
    expect(await (await withCookie("sid=1")).json()).toMatchObject({ ctor: null });
    expect(await (await withCookie("sid=1; constructor=c")).json()).toMatchObject({ ctor: "c" });
  });

  it("a cookie header over Node's header size limit is a 431, not a crash", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(server.url + "/cookies", { headers: { cookie: `sid=${"x".repeat(20_000)}` } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(431);
  });

  it("sends every Set-Cookie, including the deletion", async () => {
    const r = await fetch(server.url + "/set?v=x%3By");
    expect(r.headers.getSetCookie()).toEqual([
      "a=x%3By; Path=/; HttpOnly; SameSite=Lax",
      "b=2; Path=/; HttpOnly; SameSite=Lax",
      "old=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/x; HttpOnly; SameSite=Lax",
    ]);
  });

  it("a cookie path with a line break is refused before any header is written (500, no injected header)", async () => {
    const r = await fetch(server.url + "/set?path=" + encodeURIComponent("/\r\nX-Evil: 1"));
    expect(r.status).toBe(500);
    expect(r.headers.get("x-evil")).toBeNull();
    expect(r.headers.getSetCookie()).toEqual([]);
  });

  it("a cookie path with ; can't add attributes", async () => {
    const r = await fetch(server.url + "/set?path=" + encodeURIComponent("/; Domain=evil.com"));
    expect(r.status).toBe(500);
    expect(r.headers.getSetCookie().join("\n")).not.toContain("evil.com");
  });
});

describe("serializeCookie with text that can't be encoded", () => {
  it("refuses a lone surrogate with a TypeError, not a URIError", async () => {
    const { serializeCookie } = await import("@toyz/yerd");
    expect(() => serializeCookie("a", "x\uD800y")).toThrow(TypeError);
    expect(() => serializeCookie("a", "x\uD800y")).toThrow(/isn't well-formed text/);
  });
});
