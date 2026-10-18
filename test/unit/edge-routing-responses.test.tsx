import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HttpError, RUNTIME_PATH, YerdResponse, bare, catches, currentContext, get, post, put, redirect, res, route, serializeCookie, setHeader, status,
  type ErrorPageProps, type LayoutProps, type RunningServer,
} from "@toyz/yerd";
import { rawGet, serve } from "./edge-routing-helpers.js";

const Root = ({ children, meta }: LayoutProps) => <html><head><title>{meta.title ?? "site"}</title></head><body>{children}</body></html>;

class Point {
  constructor(readonly x: number, readonly y: number) {}
}

async function* chunks() {
  yield "a";
  yield new TextEncoder().encode("b");
  yield 3;
  yield null;
  yield undefined;
  yield "c";
}

async function* failsFirst(): AsyncGenerator<string> {
  throw new Error("stream internals");
}

/** Return values by name: GET /ret/:name returns returns[name](). */
const returns: Record<string, () => unknown> = {
  string: () => "hi",
  empty: () => "",
  unicode: () => "café \u{1F408}",
  n201: () => 201,
  n204: () => 204,
  n304: () => 304,
  n404: () => 404,
  n599: () => 599,
  n100: () => 100,
  n103: () => 103,
  n199: () => 199,
  n600: () => 600,
  n0: () => 0,
  nFloat: () => 200.5,
  nNaN: () => NaN,
  object: () => ({ a: 1, nested: { b: [1, "two", null] } }),
  array: () => [1, 2, 3],
  emptyArray: () => [],
  true: () => true,
  false: () => false,
  date: () => ({ at: new Date(0) }),
  bareDate: () => new Date(0),
  instance: () => new Point(1, 2),
  nullProto: () => Object.assign(Object.create(null), { k: "v" }),
  null: () => null,
  undefined: () => undefined,
  promise: () => Promise.resolve({ later: true }),
  promiseOfNumber: () => Promise.resolve(202),
  bytes: () => new Uint8Array([104, 105]),
  buffer: () => Buffer.from("buf"),
  stream: () => chunks(),
  readable: () => Readable.from(["x", "y"]),
  webStream: () => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("web")); c.close(); } }),
  streamFailsFirst: () => failsFirst(),
  map: () => new Map([["a", 1]]),
  set: () => new Set([1]),
  error: () => new Error("returned"),
  regexp: () => /x/,
  arrayBuffer: () => new ArrayBuffer(2),
  bigint: () => 10n,
  symbol: () => Symbol("s"),
  fn: () => () => 1,
  response: () => new Response("proxied", { status: 201 }),
  headers: () => new Headers({ a: "1" }),
  blob: () => new Blob(["b"]),
  searchParams: () => new URLSearchParams("a=1"),
  circular: () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    return o;
  },
  jsx: () => <p>jsx</p>,
  bare: () => bare(<p>bare</p>),
};

@route("/ret/:name")
class Returns {
  @get show() {
    return returns[currentContext().params.name!]!();
  }
}

/** Explicit responses by name. */
const explicit: Record<string, () => unknown> = {
  resEmpty: () => res(),
  resNull201: () => res(null, { status: 201 }),
  res204Body: () => res("ignored body", { status: 204 }),
  res304Body: () => res({ a: 1 }, { status: 304, headers: { etag: '"x"' } }),
  res204Stream: () => res(chunks(), { status: 204 }),
  resHeaders: () => res({ a: 1 }, { headers: { "Content-Type": "application/vnd.thing+json", "X-Mixed-Case": "v" } }),
  resJsx: () => res(<p>made</p>, { status: 201 }),
  resNested: () => res(res("inner", { status: 418, headers: { "x-inner": "1" } }), { status: 202, headers: { "x-outer": "1" } }),
  resCookies: () => res("c", { cookies: [{ name: "a", value: "1 2;3" }, { name: "b", value: "x", maxAge: 60, secure: true, sameSite: "Strict" }] }),
  resBadStatus: () => res("x", { status: 99 }),
  resCrlfValue: () => res("x", { headers: { "x-a": "1\r\nSet-Cookie: pwned=1" } }),
  resLfValue: () => res("x", { headers: { "x-a": "1\nx-b: 2" } }),
  resNulValue: () => res("x", { headers: { "x-a": "1\0" } }),
  resCtlValue: () => res("x", { headers: { "x-a": "a\x01b" } }),
  resWideValue: () => res("x", { headers: { "x-a": "日本" } }),
  resLatin1Value: () => res("x", { headers: { "x-a": "café" } }),
  resBadName: () => res("x", { headers: { "bad name": "v" } }),
  resCrlfName: () => res("x", { headers: { "x-a\r\nSet-Cookie": "pwned=1" } }),
  resColonName: () => res("x", { headers: { "x-a:": "v" } }),
  resEmptyName: () => res("x", { headers: { "": "v" } }),
  cookieCrlfPath: () => res("x", { cookies: [{ name: "a", value: "b", path: "/\r\nX-Evil: 1" }] }),
  cookieSemicolonDomain: () => res("x", { cookies: [{ name: "a", value: "b", domain: "example.com; SameSite=None" }] }),
  cookieBadName: () => res("x", { cookies: [{ name: "a b", value: "c" }] }),
  ctxCrlf: () => {
    currentContext().setHeader("x-a", "1\r\nSet-Cookie: pwned=1");
    return "x";
  },
  ctxBadName: () => {
    currentContext().setHeader("bad name", "v");
    return "x";
  },
  ctxWide: () => {
    currentContext().setHeader("x-a", "✓");
    return "x";
  },
  redirect: () => redirect("/to"),
  redirect301: () => redirect("/to", 301),
  redirect302: () => redirect("/to", 302),
  redirect307: () => redirect("/to", 307),
  redirect308: () => redirect("/to", 308),
  redirectAbsolute: () => redirect("https://example.com/a?b=c#d"),
  redirectCrlf: () => redirect("/to\r\nSet-Cookie: pwned=1"),
  redirectLf: () => redirect("/to\nSet-Cookie: pwned=1"),
  redirectUnicode: () => redirect("/日本?q=café#é"),
  redirectEncoded: () => redirect("/already%20encoded?q=%C3%A9"),
  redirectSpace: () => redirect("/a b"),
};

@route("/exp/:name")
class Explicit {
  @get show() {
    return explicit[currentContext().params.name!]!();
  }
}

@route("/declared")
class Declared {
  @get @status(201) @setHeader("cache-control", "no-store") @setHeader("X-Thing", "a")
  plain() { return { ok: true }; }

  @post @status(201) number() { return 202; }

  @put @status(201) explicitRes() { return res("x", { status: 200 }); }

  @get(() => currentContext().headers["x-v"] === "nothing") @status(202) nothing() { return undefined; }

  @get(() => currentContext().headers["x-v"] === "override") @setHeader("cache-control", "no-store")
  override() { return res("x", { headers: { "Cache-Control": "max-age=60" } }); }

  @get(() => currentContext().headers["x-v"] === "ctx") @setHeader("cache-control", "no-store")
  ctx() {
    currentContext().setHeader("Cache-Control", "private");
    currentContext().status(203);
    return res("x", { headers: { "cache-control": "max-age=60" } });
  }

  @get(() => currentContext().headers["x-v"] === "ctx-number")
  ctxNumber() {
    currentContext().status(203);
    return 202;
  }

  @get(() => currentContext().headers["x-v"] === "throws") @status(201) @setHeader("x-declared", "1")
  throws(): never {
    currentContext().setHeader("x-ctx", "1");
    currentContext().setCookie("attempts", "1");
    throw new HttpError(401, "Nope");
  }

  @get(() => currentContext().headers["x-v"] === "bad-ctx-status")
  badCtxStatus() {
    currentContext().status(100);
    return "x";
  }
}

let server: RunningServer;
beforeAll(async () => {
  server = await serve([Returns, Explicit, Declared], (app) => app.layout(Root));
});
afterAll(() => server.close());

describe("coercion table", () => {
  it.each([
    ["string", 200, "text/plain; charset=utf-8", "hi"],
    ["empty", 200, "text/plain; charset=utf-8", ""],
    ["unicode", 200, "text/plain; charset=utf-8", "café \u{1F408}"],
    ["n201", 201, null, ""],
    ["n204", 204, null, ""],
    ["n304", 304, null, ""],
    ["n404", 404, null, ""],
    ["n599", 599, null, ""],
    ["object", 200, "application/json; charset=utf-8", '{"a":1,"nested":{"b":[1,"two",null]}}'],
    ["array", 200, "application/json; charset=utf-8", "[1,2,3]"],
    ["emptyArray", 200, "application/json; charset=utf-8", "[]"],
    ["true", 200, "application/json; charset=utf-8", "true"],
    ["false", 200, "application/json; charset=utf-8", "false"],
    ["date", 200, "application/json; charset=utf-8", '{"at":"1970-01-01T00:00:00.000Z"}'],
    ["bareDate", 200, "application/json; charset=utf-8", '"1970-01-01T00:00:00.000Z"'],
    ["instance", 200, "application/json; charset=utf-8", '{"x":1,"y":2}'],
    ["nullProto", 200, "application/json; charset=utf-8", '{"k":"v"}'],
    ["null", 204, null, ""],
    ["undefined", 204, null, ""],
    ["promise", 200, "application/json; charset=utf-8", '{"later":true}'],
    ["promiseOfNumber", 202, null, ""],
    ["bytes", 200, "application/octet-stream", "hi"],
    ["buffer", 200, "application/octet-stream", "buf"],
    ["stream", 200, "text/plain; charset=utf-8", "ab3c"],
    ["readable", 200, "text/plain; charset=utf-8", "xy"],
    ["webStream", 200, "text/plain; charset=utf-8", "web"],
    ["jsx", 200, "text/html; charset=utf-8", "<!doctype html><html><head><title>site</title></head><body><p>jsx</p></body></html>"],
    ["bare", 200, "text/html; charset=utf-8", "<p>bare</p>"],
  ])("%s -> %i %s", async (name, statusCode, type, body) => {
    const r = await fetch(`${server.url}/ret/${name}`);
    expect(r.status).toBe(statusCode);
    expect(r.headers.get("content-type")).toBe(type);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await r.text()).toBe(body);
  });

  it.each([
    "n100", "n103", "n199", "n600", "n0", "nFloat", "nNaN",
    "map", "set", "error", "regexp", "arrayBuffer", "bigint", "symbol", "fn", "circular",
    "response", "headers", "blob", "searchParams", "streamFailsFirst",
  ])("%s is refused with a plain 500", async (name) => {
    const r = await rawGet(server.url, `/ret/${name}`);
    expect(r.status).toBe(500);
    expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.body).toBe("Internal Server Error");
  });

  it("204 and 304 send no Content-Length", async () => {
    for (const name of ["n204", "n304", "null"]) {
      const r = await rawGet(server.url, `/ret/${name}`);
      expect(r.headers["content-length"]).toBeUndefined();
      expect(r.body).toBe("");
    }
  });

  it("content-length counts bytes, not characters", async () => {
    const r = await fetch(`${server.url}/ret/unicode`);
    expect(r.headers.get("content-length")).toBe(String(Buffer.byteLength("café \u{1F408}")));
  });
});

describe("res(), redirect() and headers", () => {
  it.each([
    ["resEmpty", 200, {}, ""],
    ["resNull201", 201, {}, ""],
    ["resJsx", 201, { "content-type": "text/html; charset=utf-8" }, "<!doctype html><html><head><title>site</title></head><body><p>made</p></body></html>"],
    ["resHeaders", 200, { "content-type": "application/vnd.thing+json", "x-mixed-case": "v" }, '{"a":1}'],
    // The outer res() decides the status; headers from both reach the client.
    ["resNested", 202, { "x-inner": "1", "x-outer": "1" }, "inner"],
    ["resLatin1Value", 200, {}, "x"],
    ["redirect", 303, { location: "/to" }, ""],
    ["redirect301", 301, { location: "/to" }, ""],
    ["redirect302", 302, { location: "/to" }, ""],
    ["redirect307", 307, { location: "/to" }, ""],
    ["redirect308", 308, { location: "/to" }, ""],
    ["redirectAbsolute", 303, { location: "https://example.com/a?b=c#d" }, ""],
    // Non-ASCII is percent-encoded as UTF-8; existing escapes are left alone.
    ["redirectUnicode", 303, { location: "/%E6%97%A5%E6%9C%AC?q=caf%C3%A9#%C3%A9" }, ""],
    ["redirectEncoded", 303, { location: "/already%20encoded?q=%C3%A9" }, ""],
    ["redirectSpace", 303, { location: "/a b" }, ""],
  ])("%s -> %i", async (name, statusCode, headers, body) => {
    const r = await fetch(`${server.url}/exp/${name}`, { redirect: "manual" });
    expect(r.status).toBe(statusCode);
    for (const [k, v] of Object.entries(headers)) expect(r.headers.get(k)).toBe(v);
    expect(await r.text()).toBe(body);
  });

  it("204 and 304 from res() drop the body and its Content-Length", async () => {
    for (const name of ["res204Body", "res304Body", "res204Stream"]) {
      const r = await rawGet(server.url, `/exp/${name}`);
      expect(r.status).toBe(name.includes("304") ? 304 : 204);
      expect(r.headers["content-length"]).toBeUndefined();
      expect(r.headers["transfer-encoding"]).toBeUndefined();
      expect(r.body).toBe("");
    }
  });

  it("a 204 with a body leaves a keep-alive connection usable", async () => {
    // Two requests on one socket: a stray Content-Length would desync the second.
    const { connect } = await import("node:net");
    const { hostname, port } = new URL(server.url);
    const text = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), hostname);
      let data = "";
      socket.on("data", (c: Buffer) => (data += c.toString("latin1")));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
      socket.write("GET /exp/res204Body HTTP/1.1\r\nHost: x\r\n\r\nGET /ret/string HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    });
    expect(text.match(/^HTTP\/1\.1 \d+/gm)).toEqual(["HTTP/1.1 204", "HTTP/1.1 200"]);
    expect(text.endsWith("hi")).toBe(true);
  });

  it("sends every cookie, value encoded, with the defaults", async () => {
    const r = await fetch(`${server.url}/exp/resCookies`);
    expect(r.headers.getSetCookie()).toEqual([
      "a=1%202%3B3; Path=/; HttpOnly; SameSite=Lax",
      "b=x; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Strict",
    ]);
  });

  it.each([
    "resBadStatus", "resCrlfValue", "resLfValue", "resNulValue", "resCtlValue", "resWideValue",
    "resBadName", "resCrlfName", "resColonName", "resEmptyName",
    "cookieCrlfPath", "cookieSemicolonDomain", "cookieBadName",
    "ctxCrlf", "ctxBadName", "ctxWide", "redirectCrlf", "redirectLf",
  ])("%s is an ordinary 500: no injected header, nothing half written", async (name) => {
    const r = await rawGet(server.url, `/exp/${name}`);
    expect(r.status).toBe(500);
    expect(r.body).toBe("Internal Server Error");
    // The error went through the normal error path, which sets these.
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(r.headers["set-cookie"]).toBeUndefined();
    expect(r.headers["x-evil"]).toBeUndefined();
    expect(r.headers["x-b"]).toBeUndefined();
    expect(r.headers.location).toBeUndefined();
  });

  it("a bad header from a handler reaches @catches like any error", async () => {
    @route("/caught-header")
    class CaughtHeader {
      @get show() { return res("x", { headers: { "x-a": "✓" } }); }
      @catches(TypeError) fix(error: TypeError) { return res(`caught: ${error.message}`, { status: 422 }); }
    }
    const s = await serve([CaughtHeader]);
    try {
      const r = await fetch(s.url + "/caught-header");
      expect(r.status).toBe(422);
      expect(await r.text()).toBe("caught: Header x-a contains a control character or a character above U+00FF");
    } finally {
      await s.close();
    }
  });

  it("constructors and decorators refuse bad input up front", () => {
    expect(() => new YerdResponse(200, { "a b": "c" }, null)).toThrow(/isn't a valid header name/);
    expect(() => new YerdResponse(1000, {}, null)).toThrow(/200-599/);
    expect(() => setHeader("x-a", "1\r\n2")).toThrow(/line break or NUL/);
    expect(() => setHeader("bad name", "v")).toThrow(/isn't a valid header name/);
    expect(() => setHeader("x-a", "✓")).toThrow(/above U\+00FF/);
    expect(() => status(199)).toThrow(/200-599/);
    expect(() => status(600)).toThrow(/200-599/);
    expect(() => status(201.5)).toThrow(/200-599/);
    expect(() => serializeCookie("a", "b", { path: "/;Domain=evil" })).toThrow(/Invalid cookie path/);
    expect(() => serializeCookie("a", "b", { domain: "a.com\n" })).toThrow(/Invalid cookie domain/);
    expect(serializeCookie("a", "b", { path: "/x y", domain: "example.com" })).toBe("a=b; Path=/x y; Domain=example.com; HttpOnly; SameSite=Lax");
  });
});

describe("@status, @setHeader, ctx.status, ctx.setHeader", () => {
  const go = (headers: Record<string, string> = {}, method = "GET") => fetch(server.url + "/declared", { headers, method });

  it("@status replaces the default 200 and @setHeader adds headers (names lowercased)", async () => {
    const r = await go();
    expect(r.status).toBe(201);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-thing")).toBe("a");
  });

  it("a returned number beats @status", async () => {
    expect((await go({}, "POST")).status).toBe(202);
  });

  it("res() with a status beats @status, even res(..., { status: 200 })", async () => {
    expect((await go({}, "PUT")).status).toBe(200);
  });

  it("@status replaces the 204 for an empty result", async () => {
    expect((await go({ "x-v": "nothing" })).status).toBe(202);
  });

  it("a header the result sets beats @setHeader", async () => {
    expect((await go({ "x-v": "override" })).headers.get("cache-control")).toBe("max-age=60");
  });

  it("ctx.setHeader beats the result; ctx.status loses to an explicit res() status", async () => {
    const r = await go({ "x-v": "ctx" });
    expect(r.headers.get("cache-control")).toBe("private");
    expect(r.status).toBe(200);
  });

  it("ctx.status loses to a returned number", async () => {
    expect((await go({ "x-v": "ctx-number" })).status).toBe(202);
  });

  it("on a throw: the error's status, ctx headers and cookies, no @status or @setHeader", async () => {
    const r = await go({ "x-v": "throws" });
    expect(r.status).toBe(401);
    expect(r.headers.get("x-ctx")).toBe("1");
    expect(r.headers.get("x-declared")).toBeNull();
    expect(r.headers.getSetCookie()).toEqual(["attempts=1; Path=/; HttpOnly; SameSite=Lax"]);
    expect(await r.text()).toBe("Nope");
  });

  it("ctx.status(100) is refused", async () => {
    expect((await go({ "x-v": "bad-ctx-status" })).status).toBe(500);
  });
});

// ── errors ──

class AppError extends Error {}
class NotFoundError extends AppError {
  constructor(readonly what: string) {
    super(`${what} not found`);
  }
}
class Unrelated extends Error {}

const throws: Record<string, () => unknown> = {
  notFound: () => { throw new NotFoundError("cat"); },
  app: () => { throw new AppError("generic app"); },
  unrelated: () => { throw new Unrelated("unrelated"); },
  http: () => { throw new HttpError(409, "conflict"); },
  passThrough: () => { throw new TypeError("pass me on"); },
  catcherThrows: () => { throw new RangeError("range"); },
  string: () => { throw "a string"; },
  undefined: () => { throw undefined; },
  object: () => { throw { status: 404 }; },
};

@route("/err/:name")
class Errors {
  @get show() {
    return throws[currentContext().params.name!]!();
  }

  @catches(NotFoundError) missing(error: NotFoundError) { return <p>no {error.what}</p>; }
  @catches(AppError) app(error: AppError) { return res(`app: ${error.message}`, { status: 503 }); }
  @catches(HttpError) http(error: HttpError) { return `http ${error.status}`; }
  @catches(RangeError) broken(): never { throw new Error("the catcher broke"); }
  @catches() rest(error: unknown) {
    if (error instanceof TypeError) return undefined;
    if (error instanceof Unrelated) return 451;
    return { caught: String(error) };
  }
}

@route("/plain-err/:name")
class PlainErrors {
  @get show() {
    return throws[currentContext().params.name!]!();
  }
}

@route("/http-err")
class HttpErrors {
  @get show(): never {
    const q = currentContext().query;
    const code = Number(q.get("status"));
    const expose = q.get("expose");
    throw new HttpError(code, q.get("message") ?? undefined, {
      ...(expose === null ? {} : { expose: expose === "1" }),
      ...(q.get("details") ? { details: { field: "qty" } } : {}),
    });
  }
}

@route("/thrown-number")
class ThrownNumber {
  @get show(): never {
    throw Number(currentContext().query.get("n"));
  }
}

describe("@catches", () => {
  let s: RunningServer;
  beforeAll(async () => {
    s = await serve([Errors], (app) => app.layout(Root));
  });
  afterAll(() => s.close());

  it.each([
    // JSX renders in the route's layouts and keeps the error's status (500 for non-HttpErrors).
    ["notFound", 500, "<!doctype html><html><head><title>site</title></head><body><p>no cat</p></body></html>"],
    // A parent class catches subclasses; the first matching method wins.
    ["app", 503, "app: generic app"],
    ["http", 409, "http 409"],
    // A returned number is the status.
    ["unrelated", 451, ""],
    // Undefined passes the error on: no more catchers match, so the plain 500.
    ["passThrough", 500, "Internal Server Error"],
    // A catcher that throws: the original error is answered.
    ["catcherThrows", 500, "Internal Server Error"],
    ["string", 500, '{"caught":"a string"}'],
    ["undefined", 500, '{"caught":"undefined"}'],
    ["object", 500, '{"caught":"[object Object]"}'],
  ])("%s -> %i", async (name, statusCode, body) => {
    const r = await fetch(`${s.url}/err/${name}`);
    expect(r.status).toBe(statusCode);
    expect(await r.text()).toBe(body);
  });

  it("refuses static methods", () => {
    expect(() => {
      class Bad {
        @catches() static nope() {}
      }
      return Bad;
    }).toThrow(/public instance method/);
  });
});

describe("HttpError and thrown values without handlers", () => {
  let s: RunningServer;
  beforeAll(async () => {
    s = await serve([PlainErrors, HttpErrors, ThrownNumber]);
  });
  afterAll(() => s.close());

  it.each([
    ["status=404&message=No+such+cat", 404, "No such cat", "text/plain; charset=utf-8"],
    ["status=404", 404, "HTTP 404", "text/plain; charset=utf-8"],
    ["status=422&message=Bad&details=1", 422, '{"error":"Bad","field":"qty"}', "application/json; charset=utf-8"],
    ["status=400&message=secret&expose=0", 400, "Bad Request", "text/plain; charset=utf-8"],
    ["status=400&message=secret&expose=0&details=1", 400, "Bad Request", "text/plain; charset=utf-8"],
    ["status=500&message=db+password+wrong", 500, "Internal Server Error", "text/plain; charset=utf-8"],
    ["status=500&message=shown&expose=1", 500, "shown", "text/plain; charset=utf-8"],
    // Unexposed messages fall back to the real status text, not "HTTP 503".
    ["status=503&message=db+down", 503, "Service Unavailable", "text/plain; charset=utf-8"],
    ["status=502", 502, "Bad Gateway", "text/plain; charset=utf-8"],
    ["status=429&message=x&expose=0", 429, "Too Many Requests", "text/plain; charset=utf-8"],
    ["status=413&expose=0", 413, "Content Too Large", "text/plain; charset=utf-8"],
    ["status=599&message=x", 599, "HTTP 599", "text/plain; charset=utf-8"],
  ])("%s -> %i %s", async (query, statusCode, body, type) => {
    const r = await fetch(`${s.url}/http-err?${query}`);
    expect(r.status).toBe(statusCode);
    expect(r.headers.get("content-type")).toBe(type);
    expect(await r.text()).toBe(body);
  });

  it.each([100, 101, 103, 199, 600, 1000, 0, -1])("new HttpError(%i) is itself an error: a plain 500", async (code) => {
    const r = await rawGet(s.url, `/http-err?status=${code}&message=x`);
    expect(r.status).toBe(500);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.body).toBe("Internal Server Error");
  });

  it("HttpError refuses a non-integer status", () => {
    expect(() => new HttpError(404.5)).toThrow(/200-599/);
    expect(() => new HttpError(NaN)).toThrow(/200-599/);
  });

  it.each([
    [404, 404, "Not Found"],
    [503, 503, "Service Unavailable"],
    [100, 500, "Internal Server Error"],
    [1000, 500, "Internal Server Error"],
    [12.5, 500, "Internal Server Error"],
  ])("throw %d -> %i", async (n, statusCode, body) => {
    const r = await rawGet(s.url, `/thrown-number?n=${n}`);
    expect(r.status).toBe(statusCode);
    expect(r.body).toBe(body);
  });

  it.each(["string", "undefined", "object", "notFound"])("throw %s -> plain 500", async (name) => {
    const r = await fetch(`${s.url}/plain-err/${name}`);
    expect(r.status).toBe(500);
    expect(await r.text()).toBe("Internal Server Error");
  });

  it("HEAD of an error has no body", async () => {
    const r = await fetch(`${s.url}/plain-err/notFound`, { method: "HEAD" });
    expect(r.status).toBe(500);
    expect(await r.text()).toBe("");
  });
});

describe("onError and the error page", () => {
  const ErrorPage = ({ status: code, message, error }: ErrorPageProps) => (
    <section><h1>{code}</h1><p>{message}</p><i>{error instanceof Error ? error.constructor.name : typeof error}</i></section>
  );
  const BrokenPage = (): never => {
    throw new Error("error page broke");
  };

  let s: RunningServer;
  let broken: RunningServer;
  beforeAll(async () => {
    s = await serve([PlainErrors, HttpErrors], (app) =>
      app.layout(Root).errorPage(ErrorPage).onError((error, ctx) => {
        if (ctx.path === "/plain-err/app") return res(<p>maintenance</p>, { status: 503 });
        if (error instanceof Unrelated) return 410;
        if (error instanceof HttpError && error.status === 404 && ctx.path.startsWith("/api/")) return { error: "no such endpoint" };
        if (ctx.path === "/plain-err/catcherThrows") throw new Error("onError broke");
        return undefined;
      }),
    );
    broken = await serve([PlainErrors], (app) => app.layout(Root).errorPage(BrokenPage));
  });
  afterAll(async () => {
    await s.close();
    await broken.close();
  });

  const html = { accept: "text/html" };

  it("onError sees 404s for unknown paths", async () => {
    const r = await fetch(`${s.url}/api/nothing`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "no such endpoint" });
  });

  it("onError JSX renders in the root layouts with the status it picked", async () => {
    const r = await fetch(`${s.url}/plain-err/app`);
    expect(r.status).toBe(503);
    expect(await r.text()).toBe("<!doctype html><html><head><title>site</title></head><body><p>maintenance</p></body></html>");
  });

  it("onError returning a number picks the status", async () => {
    expect((await fetch(`${s.url}/plain-err/unrelated`)).status).toBe(410);
  });

  it("onError that throws falls back to the error page for the original error", async () => {
    const r = await fetch(`${s.url}/plain-err/catcherThrows`, { headers: html });
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(text).toContain("<h1>500</h1><p>Internal Server Error</p><i>RangeError</i>");
    expect(text).not.toContain("range");
  });

  it.each([
    ["/plain-err/notFound", 500, "Internal Server Error", "<title>Internal Server Error</title>"],
    ["/http-err?status=404&message=No+cat", 404, "No cat", "<title>No cat</title>"],
    ["/http-err?status=503&message=secret", 503, "Service Unavailable", "<title>Service Unavailable</title>"],
    ["/nowhere", 404, "Not Found", "<title>Not Found</title>"],
  ])("error page for %s: %i %s", async (path, code, message, title) => {
    const r = await fetch(s.url + path, { headers: html });
    expect(r.status).toBe(code);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const text = await r.text();
    expect(text).toContain(`<h1>${code}</h1><p>${message}</p>`);
    expect(text).toContain(title);
    expect(text).not.toContain("secret");
  });

  it("API clients and the runtime's own requests get plain text", async () => {
    expect(await (await fetch(`${s.url}/nowhere`)).text()).toBe("Not Found");
    expect(await (await fetch(`${s.url}/nowhere`, { headers: { accept: "application/json" } })).text()).toBe("Not Found");
    expect(await (await fetch(`${s.url}/nowhere`, { headers: { ...html, yx: "1" } })).text()).toBe("Not Found");
  });

  it("an error page that throws falls back to the plain response", async () => {
    const r = await fetch(`${broken.url}/plain-err/notFound`, { headers: html });
    expect(r.status).toBe(500);
    expect(await r.text()).toBe("Internal Server Error");
    const missing = await fetch(`${broken.url}/nowhere`, { headers: html });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("Not Found");
  });
});

describe("the runtime script", () => {
  const get = (headers: Record<string, string> = {}, method = "GET") => fetch(server.url + RUNTIME_PATH, { headers, method });

  it("is JavaScript with an ETag, revalidated every time", async () => {
    const r = await get({ "accept-encoding": "identity" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("no-cache");
    expect(r.headers.get("vary")).toBe("accept-encoding");
    expect(r.headers.get("etag")).toMatch(/^"[\w-]{16}"$/);
    expect(r.headers.get("content-encoding")).toBeNull();
    expect((await r.text()).length).toBeGreaterThan(1000);
  });

  it.each([
    ["br", "br"],
    ["gzip, deflate, br", "br"],
    ["gzip", "gzip"],
    ["br;q=0, gzip", "gzip"],
    ["*", "br"],
    ["*;q=0", null],
    ["identity", null],
    ["", null],
    ["BR", "br"],
  ])("Accept-Encoding %j -> %s", async (accept, encoding) => {
    const r = await rawGet(server.url, RUNTIME_PATH, accept ? `Accept-Encoding: ${accept}\r\n` : "");
    expect(r.status).toBe(200);
    expect(r.headers["content-encoding"]).toBe(encoding ?? undefined);
    expect(Number(r.headers["content-length"])).toBe(r.body.length);
  });

  it.each([
    (etag: string) => etag,
    (etag: string) => `W/${etag}`,
    (etag: string) => `"other", ${etag}`,
    () => "*",
  ])("If-None-Match variant %# -> 304 with no body", async (make) => {
    const etag = (await get()).headers.get("etag")!;
    const r = await rawGet(server.url, RUNTIME_PATH, `If-None-Match: ${make(etag)}\r\n`);
    expect(r.status).toBe(304);
    expect(r.headers.etag).toBe(etag);
    expect(r.headers["content-length"]).toBeUndefined();
    expect(r.body).toBe("");
  });

  it("a stale ETag gets the script", async () => {
    expect((await get({ "if-none-match": '"stale"' })).status).toBe(200);
  });

  it("HEAD has the length and no body", async () => {
    const r = await rawGet(server.url, RUNTIME_PATH);
    const h = await fetch(server.url + RUNTIME_PATH, { method: "HEAD", headers: { "accept-encoding": "identity" } });
    expect(h.status).toBe(200);
    expect(h.headers.get("content-length")).toBe(r.headers["content-length"]);
    expect(await h.text()).toBe("");
  });

  it("other methods are a 404 (no route lives there)", async () => {
    expect((await get({}, "POST")).status).toBe(404);
  });
});
