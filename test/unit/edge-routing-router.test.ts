import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BootError, get, param, params, post, route, yerd, type RunningServer } from "@toyz/yerd";
import { Router, paramNames } from "../../src/router/trie.js";
import { rawGet, raw, serve } from "./edge-routing-helpers.js";

/** A router where each pattern's handler is the pattern itself. */
function table(patterns: string[]): Router<string> {
  const router = new Router<string>();
  for (const p of patterns) router.add(p, "GET", p);
  return router;
}

describe("Router precedence", () => {
  const router = table([
    "/",
    "/users",
    "/users/new",
    "/users/:id",
    "/users/:id/edit",
    "/users/:id/*rest",
    "/files/*path",
    "/a/b/c",
    "/a/:x/c",
    "/a/b/*tail",
    "/deep/:a/:b/:c",
    "/mixed/:id/static",
    "/mixed/fixed/:other",
  ]);

  it.each([
    ["/", "/", {}],
    ["/users", "/users", {}],
    ["/users/", "/users", {}],
    ["/users/new", "/users/new", {}],
    ["/users/new/", "/users/new", {}],
    ["/users/42", "/users/:id", { id: "42" }],
    ["/users/42/edit", "/users/:id/edit", { id: "42" }],
    ["/users/new/edit", "/users/:id/edit", { id: "new" }],
    ["/users/42/x/y", "/users/:id/*rest", { id: "42", rest: "x/y" }],
    ["/users/42/edit/more", "/users/:id/*rest", { id: "42", rest: "edit/more" }],
    ["/files", "/files/*path", { path: "" }],
    ["/files/", "/files/*path", { path: "" }],
    ["/files/a", "/files/*path", { path: "a" }],
    ["/files/a/b/c.txt", "/files/*path", { path: "a/b/c.txt" }],
    ["/a/b/c", "/a/b/c", {}],
    ["/a/z/c", "/a/:x/c", { x: "z" }],
    ["/a/b/d", "/a/b/*tail", { tail: "d" }],
    // A splat matches zero segments too.
    ["/a/b", "/a/b/*tail", { tail: "" }],
    ["/deep/1/2/3", "/deep/:a/:b/:c", { a: "1", b: "2", c: "3" }],
    // Static wins at the first segment where both could apply, then backtracks into the param.
    ["/mixed/fixed/static", "/mixed/fixed/:other", { other: "static" }],
    ["/mixed/9/static", "/mixed/:id/static", { id: "9" }],
  ])("%s -> %s", (path, pattern, expected) => {
    const m = router.match(path);
    expect(m?.pattern).toBe(pattern);
    expect(m?.params).toEqual(expected);
  });

  it.each(["/nope", "/deep/1/2", "/deep/1/2/3/4", "/a", "/deep/1//3"])(
    "%s has no match",
    (path) => {
      expect(router.match(path)).toBeNull();
    },
  );

  it("backtracks out of a dead static branch into the param", () => {
    const r = table(["/x/static/only", "/x/:id/tail"]);
    expect(r.match("/x/static/tail")).toMatchObject({ pattern: "/x/:id/tail", params: { id: "static" } });
  });

  it("does not leave a failed branch's params behind", () => {
    const r = table(["/p/:a/one", "/p/lit/two"]);
    const m = r.match("/p/lit/two");
    expect(m?.params).toEqual({});
  });

  it("is case sensitive", () => {
    const r = table(["/About"]);
    expect(r.match("/About")).not.toBeNull();
    expect(r.match("/about")).toBeNull();
    expect(r.match("/ABOUT")).toBeNull();
  });

  it("registers patterns in any order with the same result", () => {
    const a = table(["/u/:id", "/u/new"]);
    const b = table(["/u/new", "/u/:id"]);
    expect(a.match("/u/new")?.pattern).toBe("/u/new");
    expect(b.match("/u/new")?.pattern).toBe("/u/new");
  });
});

describe("Router segments and decoding", () => {
  const router = table(["/p/:id", "/s/*rest", "/static/a b"]);

  it.each([
    ["/p/hello%20world", "hello world"],
    ["/p/caf%C3%A9", "café"],
    ["/p/%E2%9C%93", "✓"],
    // An encoded slash stays inside the one segment it was sent in, decoded.
    ["/p/a%2Fb", "a/b"],
    ["/p/%2e%2e", ".."],
    // Invalid escapes are passed through rather than failing the request.
    ["/p/%", "%"],
    ["/p/%zz", "%zz"],
    ["/p/%E0%A4%A", "%E0%A4%A"],
    ["/p/100%25", "100%"],
    ["/p/a+b", "a+b"],
  ])("param from %s is %j", (path, value) => {
    expect(router.match(path)?.params).toEqual({ id: value });
  });

  it("decodes each splat segment and keeps the real slashes", () => {
    expect(router.match("/s/a%20b/c%2Fd/%")?.params).toEqual({ rest: "a b/c/d/%" });
  });

  it("an empty segment never fills a param", () => {
    expect(router.match("/p/")).toBeNull();
    expect(router.match("/p//")).toBeNull();
  });

  it("a doubled slash before a param leaves no match", () => {
    expect(router.match("//p/1")).toBeNull();
    expect(router.match("/p//1")).toBeNull();
  });

  it("a splat keeps empty segments, so its value can start with a slash", () => {
    // Worth knowing for anyone joining a splat onto a filesystem path.
    expect(router.match("/s//etc/passwd")?.params).toEqual({ rest: "/etc/passwd" });
  });

  it("static segments match the raw (still encoded) path", () => {
    expect(router.match("/static/a b")).not.toBeNull();
    expect(router.match("/static/a%20b")).toBeNull();
  });

  it("only one trailing slash is ignored", () => {
    expect(router.match("/p/1/")).not.toBeNull();
    expect(router.match("/p/1//")).toBeNull();
  });
});

describe("Router registration", () => {
  it.each([
    [["/a/:id", "/a/:other"], /names this segment :other/],
    [["/f/*a", "/f/*b"], /names this splat \*b/],
    [["/x", "/x/"], /Duplicate route: GET \/x\/ \(already registered as \/x\)/],
    [["/x/:id", "/x/:id/"], /Duplicate route/],
    [["/e/:"], /Empty parameter name/],
    [["/s/*/more"], /A splat must be the last segment/],
    [["/dup/:id/sub/:id"], /name id appears twice/],
    [["/dup/:path/*path"], /name path appears twice/],
  ])("%j is refused", (patterns, message) => {
    expect(() => table(patterns)).toThrow(message);
  });

  it("allows the same verb on a param route and a static sibling", () => {
    expect(() => table(["/a/:id", "/a/b"])).not.toThrow();
  });

  it("allows the same pattern for different verbs", () => {
    const r = new Router<string>();
    r.add("/v", "GET", "g");
    r.add("/v", "POST", "p");
    expect([...r.match("/v")!.handlers.keys()]).toEqual(["GET", "POST"]);
  });

  it.each([
    ["/", []],
    ["/a/:b/c/:d", ["b", "d"]],
    ["/f/*", ["wildcard"]],
    ["/f/*rest", ["rest"]],
    ["/x/:id/", ["id"]],
  ])("paramNames(%s) is %j", (pattern, names) => {
    expect(paramNames(pattern)).toEqual(names);
  });
});

describe("Router depth", () => {
  it("matches thousands of segments without overflowing the stack", () => {
    const r = table(["/deep/*rest"]);
    const path = "/deep" + "/a".repeat(5000);
    expect(r.match(path)?.params.rest?.split("/").length).toBe(5000);
  });

  it("stays fast on a wide param/static tree", () => {
    const patterns: string[] = [];
    for (let i = 0; i < 12; i++) {
      patterns.push("/t" + Array.from({ length: i }, (_, d) => `/:p${d}`).join("") + "/end" + i);
      patterns.push("/t" + "/s".repeat(i) + "/x" + i);
    }
    const r = new Router<string>();
    for (const p of patterns) {
      // Param names must agree at each depth, which they do here.
      r.add(p, "GET", p);
    }
    const started = performance.now();
    expect(r.match("/t" + "/s".repeat(11) + "/nomatch")).toBeNull();
    expect(performance.now() - started).toBeLessThan(200);
  });
});

// ── over HTTP ──

@route("/r/:id")
class ParamRoute {
  @param("id") accessor id!: string;
  @get show() {
    return { id: this.id };
  }
}

@route("/r/new")
class StaticSibling {
  @get show() {
    return "static";
  }
}

@route("/files/*path")
class Splat {
  @params accessor all!: Record<string, string>;
  @get show() {
    return this.all;
  }
}

@route("/Case")
class CaseRoute {
  @get show() {
    return "case";
  }
}

@route("/q")
class QueryRoute {
  @get show() {
    return "q";
  }
}

let server: RunningServer;
beforeAll(async () => {
  server = await serve([ParamRoute, StaticSibling, Splat, CaseRoute, QueryRoute]);
});
afterAll(() => server.close());

describe("paths over HTTP", () => {
  it.each([
    ["/r/new", 200, "static"],
    ["/r/new/", 200, "static"],
    ["/r/42", 200, '{"id":"42"}'],
    ["/r/42?x=1&y=2", 200, '{"id":"42"}'],
    ["/r/a%2Fb", 200, '{"id":"a/b"}'],
    ["/r/%F0%9F%90%88", 200, '{"id":"\u{1F408}"}'],
    ["/r/%", 200, '{"id":"%"}'],
    ["/r/%3Fnot-a-query", 200, '{"id":"?not-a-query"}'],
    ["/r/", 404, '{"error":"Not Found","code":"not_found"}'],
    ["/R/new", 404, '{"error":"Not Found","code":"not_found"}'],
    ["/case", 404, '{"error":"Not Found","code":"not_found"}'],
    ["/Case", 200, "case"],
    ["/q?", 200, "q"],
    ["/q?a=%ZZ", 200, "q"],
    ["/files", 200, '{"path":""}'],
    ["/files/a/b", 200, '{"path":"a/b"}'],
  ])("GET %s -> %i %s", async (path, status, body) => {
    const r = await fetch(server.url + path);
    expect(r.status).toBe(status);
    expect(await r.text()).toBe(body);
  });

  it("dot segments are not normalized server side (fetch would; a raw client doesn't)", async () => {
    const r = await rawGet(server.url, "/r/../r/new");
    expect(r.status).toBe(404);
    const p = await rawGet(server.url, "/r/..");
    expect(p.status).toBe(200);
    expect(p.body).toBe('{"id":".."}');
  });

  it("a splat sees encoded dot segments decoded, for the handler to refuse", async () => {
    const r = await rawGet(server.url, "/files/%2e%2e/%2e%2e/etc/passwd");
    expect(JSON.parse(r.body)).toEqual({ path: "../../etc/passwd" });
  });

  it("absolute-form targets route by their path (and do normalize dot segments, as URL parsing does)", async () => {
    expect((await rawGet(server.url, "http://example.com/r/new")).body).toBe("static");
    expect((await rawGet(server.url, "http://example.com/x/../r/new?a=1")).body).toBe("static");
  });

  it("a target that is neither origin-form nor a URL is a 400", async () => {
    const r = await rawGet(server.url, "*");
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: "Bad Request", code: "bad_request" });
  });

  it("OPTIONS * answers for the whole server", async () => {
    const r = await raw(server.url, "OPTIONS * HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    expect(r.status).toBe(204);
    expect(r.headers.allow).toBe("GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
  });

  it("a path near the header limit is a plain 404, and one over it is refused by Node", async () => {
    const near = await fetch(server.url + "/" + "a".repeat(8000));
    expect(near.status).toBe(404);
    const over = await rawGet(server.url, "/" + "a".repeat(20_000));
    expect(over.status).toBe(431);
  });

  it("a long param value is passed through whole", async () => {
    const id = "x".repeat(4000);
    const r = await fetch(`${server.url}/r/${id}`);
    expect(await r.json()).toEqual({ id });
  });
});

describe("boot-time route conflicts", () => {
  it("refuses two classes on the same pattern and verb", async () => {
    @route("/same") class One { @get a() { return 1; } }
    @route("/same/") class Two { @get b() { return 2; } }
    const error = (await yerd({ routes: [One, Two], services: [] }).boot().catch((e: unknown) => e)) as BootError;
    expect(error).toBeInstanceOf(BootError);
    expect(error.problems.join("\n")).toContain("Two: Duplicate route: GET /same/ (already registered as /same)");
  });

  it("refuses sibling params with different names", async () => {
    @route("/c/:a") class A { @get a() { return 1; } }
    @route("/c/:b/x") class B { @get b() { return 2; } }
    const error = (await yerd({ routes: [A, B], services: [] }).boot().catch((e: unknown) => e)) as BootError;
    expect(error.problems.join("\n")).toMatch(/names this segment :b, but another route already named it :a/);
  });

  it("refuses a pattern that names a param twice", async () => {
    @route("/twice/:id/and/:id") class Twice { @get a() { return 1; } }
    const error = (await yerd({ routes: [Twice], services: [] }).boot().catch((e: unknown) => e)) as BootError;
    expect(error.problems.join("\n")).toMatch(/name id appears twice/);
  });

  it("lets different verbs share a pattern across classes", async () => {
    @route("/split") class Reader { @get a() { return "r"; } }
    @route("/split") class Writer { @post b() { return "w"; } }
    const s = await serve([Reader, Writer]);
    try {
      expect(await (await fetch(s.url + "/split")).text()).toBe("r");
      expect(await (await fetch(s.url + "/split", { method: "POST" })).text()).toBe("w");
    } finally {
      await s.close();
    }
  });

  it("refuses a pattern without a leading slash at decoration time", () => {
    expect(() => route("no-slash")).toThrow(/must start with "\/"/);
  });
});
