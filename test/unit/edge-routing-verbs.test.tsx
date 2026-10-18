import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BootError, HttpError, accepts, all, catches, createGuard, currentContext, del, get, head, isBot, options, post, put, res, route, varies, yerd,
  type ErrorPageProps, type LayoutProps, type RunningServer,
} from "@toyz/yerd";
import { raw, serve } from "./edge-routing-helpers.js";

const Root = ({ children }: LayoutProps) => <html><body>{children}</body></html>;
const ErrorPage = ({ status, message }: ErrorPageProps) => <p>{status}: {message}</p>;

@route("/only-get")
class OnlyGet {
  @get show() {
    return "hello there";
  }
}

@route("/page")
class Page {
  @get show() {
    return <h1>page</h1>;
  }
}

@route("/crud")
class Crud {
  @get read() { return "read"; }
  @post create() { return "create"; }
  @del remove() { return "remove"; }
}

@route("/own-head")
class OwnHead {
  @get read() { return "full body"; }
  @head peek() { return res(null, { headers: { "x-peek": "1" } }); }
}

@route("/catch-all")
class CatchAll {
  @get read() { return "get"; }
  @all rest() { return `all:${currentContext().method}`; }
}

@route("/only-all")
class OnlyAll {
  @all any() { return `any:${currentContext().method}`; }
}

@route("/opts")
class Opts {
  @get read() { return "r"; }
  @options describe() { return res(null, { status: 204, headers: { allow: "GET, OPTIONS", "access-control-allow-methods": "GET" } }); }
}

@route("/throws")
class Throws {
  @get sync(): string { throw new Error("boom internals"); }
  @post async rejects(): Promise<string> { throw new Error("async internals"); }
  @put http(): string { throw new HttpError(409, "Conflict here"); }
}

let server: RunningServer;
beforeAll(async () => {
  server = await serve([OnlyGet, Page, Crud, OwnHead, CatchAll, OnlyAll, Opts, Throws]);
});
afterAll(() => server.close());

const call = (path: string, init: RequestInit = {}) => fetch(server.url + path, init);

describe("HEAD", () => {
  it("runs the GET handler, keeps its headers and length, sends no body", async () => {
    const g = await call("/only-get");
    const h = await call("/only-get", { method: "HEAD" });
    expect(h.status).toBe(200);
    expect(h.headers.get("content-type")).toBe(g.headers.get("content-type"));
    expect(h.headers.get("content-length")).toBe(String("hello there".length));
    expect(await h.text()).toBe("");
  });

  it("works for streamed JSX pages (no body on the wire)", async () => {
    const r = await raw(server.url, "HEAD /page HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(r.body).toBe("");
  });

  it("uses an explicit @head handler when there is one", async () => {
    const h = await call("/own-head", { method: "HEAD" });
    expect(h.headers.get("x-peek")).toBe("1");
  });

  it("falls back to GET before @all", async () => {
    const h = await call("/catch-all", { method: "HEAD" });
    expect(h.status).toBe(200);
    expect(h.headers.get("content-length")).toBe("3");
  });

  it("a 404 and a 405 carry no body either", async () => {
    const missing = await raw(server.url, "HEAD /missing HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    expect(missing.status).toBe(404);
    expect(missing.body).toBe("");
  });
});

describe("405 and Allow", () => {
  it.each([
    ["/only-get", "POST", "GET, HEAD"],
    ["/only-get", "PUT", "GET, HEAD"],
    ["/only-get", "PATCH", "GET, HEAD"],
    ["/only-get", "DELETE", "GET, HEAD"],
    ["/only-get", "OPTIONS", "GET, HEAD"],
    ["/crud", "PUT", "GET, POST, DELETE, HEAD"],
    ["/own-head", "POST", "GET, HEAD"],
  ])("%s %s -> 405 Allow: %s", async (path, method, allow) => {
    const r = await call(path, { method });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe(allow);
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await r.text()).toBe("Method Not Allowed");
  });

  it("an unknown method is a 405 too", async () => {
    const r = await raw(server.url, "PROPFIND /only-get HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe("GET, HEAD");
  });

  it("an unknown method reaches @all", async () => {
    const r = await raw(server.url, "PROPFIND /only-all HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    expect(r.status).toBe(200);
    expect(r.body).toBe("any:PROPFIND");
  });

  it("HEAD of a 405 has the Allow header and no body", async () => {
    const r = await raw(server.url, "HEAD /crud HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    // HEAD falls back to GET here, so it's served.
    expect(r.status).toBe(200);
    const p = await raw(server.url, "PATCH /crud HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    expect(p.status).toBe(405);
    expect(p.headers.allow).toBe("GET, POST, DELETE, HEAD");
  });

  it("keeps Allow when the error page renders the 405", async () => {
    const own = await serve([OnlyGet], (app) => app.layout(Root).errorPage(ErrorPage));
    try {
      const r = await fetch(own.url + "/only-get", { method: "POST", headers: { accept: "text/html" } });
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("GET, HEAD");
      expect(await r.text()).toContain("<p>405: Method Not Allowed</p>");
    } finally {
      await own.close();
    }
  });

  it("keeps Allow when app.onError answers the 405", async () => {
    const own = await serve([OnlyGet], (app) => app.onError((e) => (e instanceof HttpError && e.status === 405 ? { nope: true } : undefined)));
    try {
      const r = await fetch(own.url + "/only-get", { method: "DELETE" });
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("GET, HEAD");
      expect(await r.json()).toEqual({ nope: true });
    } finally {
      await own.close();
    }
  });
});

describe("@all and @options", () => {
  it.each([
    ["GET", "get"],
    ["POST", "all:POST"],
    ["PUT", "all:PUT"],
    ["DELETE", "all:DELETE"],
    ["OPTIONS", "all:OPTIONS"],
  ])("/catch-all %s -> %s", async (method, body) => {
    const r = await call("/catch-all", { method });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(body);
  });

  it("an @all-only route answers HEAD with its handler and no body", async () => {
    const r = await call("/only-all", { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-length")).toBe(String("any:HEAD".length));
  });

  it("an @options handler answers OPTIONS itself", async () => {
    const r = await call("/opts", { method: "OPTIONS" });
    expect(r.status).toBe(204);
    expect(r.headers.get("allow")).toBe("GET, OPTIONS");
    expect(r.headers.get("access-control-allow-methods")).toBe("GET");
  });

  it("a route's 405 Allow list mentions its @options handler", async () => {
    const r = await call("/opts", { method: "POST" });
    expect(r.headers.get("allow")).toBe("GET, OPTIONS, HEAD");
  });
});

describe("handlers that fail", () => {
  it.each([
    ["GET", 500, "Internal Server Error"],
    ["POST", 500, "Internal Server Error"],
    ["PUT", 409, "Conflict here"],
  ])("%s -> %i without leaking internals", async (method, status, body) => {
    const r = await call("/throws", { method });
    expect(r.status).toBe(status);
    expect(await r.text()).toBe(body);
  });
});

// ── @get(when) ──

const fromApp = varies("X-Client", (ctx) => ctx.headers["x-client"] === "app");
const beta = createGuard("beta", (ctx) => (ctx.headers["x-beta"] === "1" ? true : "/no-beta"));
const slowYes = async () => {
  await new Promise((r) => setTimeout(r, 5));
  return true;
};
const exploding = () => {
  throw new Error("test exploded");
};

@route("/when")
class When {
  @get(fromApp) forApp() { return "app"; }
  @get(beta) forBeta() { return "beta"; }
  @get page() { return "default"; }
}

@route("/when-order")
class WhenOrder {
  @get(() => true) first() { return "first"; }
  @get(() => true) second() { return "second"; }
}

@route("/when-async")
class WhenAsync {
  @get(slowYes) slow() { return "slow"; }
  @get fallback() { return "fallback"; }
}

@route("/when-throws")
class WhenThrows {
  @get(exploding) never() { return "never"; }
  @get fallback() { return "fallback"; }
  @catches() caught(error: unknown) { return res(`caught ${(error as Error).message}`, { status: 503 }); }
}

@route("/no-default")
class NoDefault {
  @get((ctx) => ctx.headers["x-ok"] === "1") ok() { return "ok"; }
}

@route("/bots")
class Bots {
  @get page() { return "people"; }
  @get(isBot) crawlable() { return "crawler"; }
}

@route("/bot-json")
class BotJson {
  @get page() { return "page"; }
  @get(isBot) @accepts("json") data() { return { bot: true }; }
}

@route("/bot-only")
class BotOnly {
  @get(isBot) @accepts("json") data() { return { bot: true }; }
  @get(isBot) html() { return "bot html"; }
}

@route("/two-varies")
class TwoVaries {
  @get(varies("x-a", (ctx) => ctx.headers["x-a"] === "1")) a() { return "a"; }
  @get(varies("x-b", (ctx) => ctx.headers["x-b"] === "1")) b() { return res("b", { headers: { vary: "Cookie" } }); }
  @get plain() { return "plain"; }
}

const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";

describe("@get(when)", () => {
  let s: RunningServer;
  beforeAll(async () => {
    s = await serve([When, WhenOrder, WhenAsync, WhenThrows, NoDefault, Bots, BotJson, BotOnly, TwoVaries]);
  });
  afterAll(() => s.close());
  const go = (path: string, headers: Record<string, string> = {}, method = "GET") => fetch(s.url + path, { headers, method, redirect: "manual" });

  it.each([
    [{}, "default"],
    [{ "x-client": "app" }, "app"],
    [{ "x-beta": "1" }, "beta"],
    // Both pass: the first declared wins.
    [{ "x-client": "app", "x-beta": "1" }, "app"],
    // A failing guard used as a test moves on; it never redirects.
    [{ "x-beta": "0" }, "default"],
  ])("headers %j -> %s", async (headers, body) => {
    const r = await go("/when", headers);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(body);
    // Every response says it depends on the header the varies() test reads, lowercased.
    expect(r.headers.get("vary")).toBe("x-client");
  });

  it("tries variants in declaration order", async () => {
    expect(await (await go("/when-order")).text()).toBe("first");
  });

  it("awaits async tests", async () => {
    expect(await (await go("/when-async")).text()).toBe("slow");
  });

  it("a test that throws is the route's error, which @catches sees", async () => {
    const r = await go("/when-throws");
    expect(r.status).toBe(503);
    expect(await r.text()).toBe("caught test exploded");
  });

  it("with no default and no passing test the answer is 404", async () => {
    expect((await go("/no-default")).status).toBe(404);
    expect(await (await go("/no-default", { "x-ok": "1" })).text()).toBe("ok");
  });

  it("with no default, other verbs still get a 405", async () => {
    const r = await go("/no-default", {}, "POST");
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET, HEAD");
  });

  it("HEAD runs the variants too", async () => {
    const r = await go("/no-default", { "x-ok": "1" }, "HEAD");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-length")).toBe("2");
  });

  it.each([
    [GOOGLEBOT, "crawler"],
    [FIREFOX, "people"],
    ["", "people"],
  ])("isBot: %s -> %s, Vary: user-agent", async (ua, body) => {
    const r = await go("/bots", { "user-agent": ua });
    expect(await r.text()).toBe(body);
    expect(r.headers.get("vary")).toBe("user-agent");
  });

  it.each([
    // A crawler sending a browser-style Accept asked for HTML, not JSON.
    [GOOGLEBOT, BROWSER_ACCEPT, "page"],
    // A bare */* never beats the default.
    [GOOGLEBOT, "*/*", "page"],
    [GOOGLEBOT, "application/json", '{"bot":true}'],
    [FIREFOX, "application/json", "page"],
  ])("@get(isBot) @accepts(json): %s with Accept %s -> %s", async (ua, accept, body) => {
    const r = await go("/bot-json", { "user-agent": ua, accept });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(body);
  });

  it.each([
    [BROWSER_ACCEPT, "bot html"],
    ["application/json", '{"bot":true}'],
  ])("with only variants, an @accepts one still needs its type by name (Accept %s)", async (accept, body) => {
    expect(await (await go("/bot-only", { "user-agent": GOOGLEBOT, accept })).text()).toBe(body);
  });

  it("merges every variant's Vary with what the handler set", async () => {
    const plain = await go("/two-varies");
    expect(plain.headers.get("vary")).toBe("x-a, x-b");
    const b = await go("/two-varies", { "x-b": "1" });
    expect(await b.text()).toBe("b");
    expect(b.headers.get("vary")).toBe("Cookie, x-a, x-b");
  });

  it("refuses a path argument", () => {
    expect(() => (get as unknown as (p: string) => unknown)("/sub")).toThrow(/takes a request test/);
  });

  it("refuses static and private methods", () => {
    expect(() => {
      class Bad {
        @get static nope() { return 1; }
      }
      return Bad;
    }).toThrow(/public instance method/);
  });
});

describe("boot errors for verbs", () => {
  it("two plain handlers for one verb", async () => {
    @route("/twice") class Twice {
      @get a() { return 1; }
      @get b() { return 2; }
    }
    const error = (await yerd({ routes: [Twice], services: [] }).boot().catch((e: unknown) => e)) as BootError;
    expect(error.problems).toContain("Duplicate route: GET /twice (Twice.b and Twice.a; give one of them @accepts)");
  });

  it("two @accepts handlers for the same type", async () => {
    @route("/acc") class Acc {
      @get @accepts("json") a() { return 1; }
      @get @accepts("application/json", "xml") b() { return 2; }
    }
    const error = (await yerd({ routes: [Acc], services: [] }).boot().catch((e: unknown) => e)) as BootError;
    expect(error.problems).toContain("Acc.b and Acc.a both @accepts the same type for GET /acc");
  });

  it("a class with no verbs", async () => {
    @route("/none") class None {}
    const error = (await yerd({ routes: [None], services: [] }).boot().catch((e: unknown) => e)) as BootError;
    expect(error.problems).toContain("None (/none) has no verb methods (@get, @post, ...)");
  });

  it("a variant beside a plain handler is not a duplicate", async () => {
    @route("/fine") class Fine {
      @get a() { return 1; }
      @get(() => true) b() { return 2; }
      @get(() => false) c() { return 3; }
    }
    await expect(yerd({ routes: [Fine], services: [] }).boot()).resolves.toBeUndefined();
  });
});
