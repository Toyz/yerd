// rateLimit(): a value guard counting requests per key in fixed windows, 429 + Retry-After past the limit.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionForm, MemoryRateLimitStore, action, get, group, guards, post, prerender, rateLimit, route, yerd, type RateLimitStore } from "@toyz/yerd";

const loginLimit = rateLimit({ name: "login", limit: 2, window: "1m" });

@route("/login")
class Login {
  @get page() {
    return <form action={this.signIn}><button>go</button></form>;
  }
  @action @loginLimit signIn(_: {}, _form: ActionForm) {
    return "signed in";
  }
}

const perKey = rateLimit({ limit: 1, window: 1000, key: (ctx) => ctx.headers["x-api-key"] as string | undefined, message: "Slow down" });

@route("/keyed")
class Keyed {
  @get @guards(perKey) page() {
    return "ok";
  }
}

const apiLimit = rateLimit({ name: "api", limit: 3, window: "10s" });

@group("/api", { guards: [apiLimit] })
class Api {}

@route("/a", { group: Api })
class A {
  @get one() {
    return "a";
  }
  @post write() {
    return 204;
  }
}

@route("/b", { group: Api })
class B {
  @get one() {
    return "b";
  }
}

function app(routes: Function[], trustProxy = false) {
  return yerd({ routes, services: [], handleSignals: false, trustProxy });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("rateLimit", () => {
  it("lets `limit` requests through per window, then answers 429 with Retry-After", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const server = app([A, B]);
    const from = (ip: string) => ({ headers: { "x-forwarded-for": ip } });
    // No trustProxy: the header is ignored, every request is the same in-process client.
    expect((await server.request("/api/a", from("1.1.1.1"))).status).toBe(200);
    expect((await server.request("/api/b", from("2.2.2.2"))).status).toBe(200);
    expect((await server.request("/api/a")).status).toBe(200);
    const blocked = await server.request("/api/b", { headers: { accept: "application/json" } });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("10");
    expect(await blocked.json()).toEqual({ error: "Too Many Requests", code: "too_many_requests" });

    vi.advanceTimersByTime(4_500);
    expect((await server.request("/api/a")).headers.get("retry-after")).toBe("6");
    vi.advanceTimersByTime(5_500);
    expect((await server.request("/api/a")).status).toBe(200);
  });

  it("keys by the last X-Forwarded-For entry under trustProxy, not the client-supplied ones", async () => {
    const limit = rateLimit({ limit: 1, window: "1m" });
    @route("/p")
    class P {
      @get @guards(limit) page() {
        return "ok";
      }
    }
    const server = app([P], true);
    const via = (chain: string) => server.request("/p", { headers: { "x-forwarded-for": chain } });
    expect((await via("9.9.9.9, 10.0.0.1")).status).toBe(200);
    // A forged first entry doesn't make a new client.
    expect((await via("8.8.8.8, 10.0.0.1")).status).toBe(429);
    expect((await via("10.0.0.2")).status).toBe(200);
  });

  it("guards actions, and counts by a custom key; no key, no limit", async () => {
    const client = app([Login]).client();
    await client.page("/login");
    expect((await client.action("/login", {})).status).toBe(200);
    expect((await client.action("/login", {})).status).toBe(200);
    expect((await client.action("/login", {})).status).toBe(429);

    const server = app([Keyed]);
    const keyed = (key?: string) => server.request("/keyed", key ? { headers: { "x-api-key": key } } : {});
    expect((await keyed("k1")).status).toBe(200);
    const blocked = await keyed("k1");
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toContain("Slow down");
    expect((await keyed("k2")).status).toBe(200);
    expect((await keyed()).status).toBe(200);
    expect((await keyed()).status).toBe(200);
  });

  it("works with an async store, keyed by name", async () => {
    const seen: string[] = [];
    const counts = new Map<string, number>();
    const store: RateLimitStore = {
      async hit(key, windowMs) {
        seen.push(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return { count: counts.get(key)!, resetAt: Date.now() + windowMs };
      },
    };
    const limit = rateLimit({ name: "shared", limit: 1, window: "2s", store, key: async () => "u1" });
    @route("/s")
    class S {
      @get @guards(limit) page() {
        return "ok";
      }
    }
    const server = app([S]);
    expect((await server.request("/s")).status).toBe(200);
    const blocked = await server.request("/s");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("2");
    expect(seen).toEqual(["shared:u1", "shared:u1"]);
  });

  it("doesn't count prerendering, even app-wide", async () => {
    @prerender({ paths: ["/docs/a", "/docs/b"] }) @route("/docs/:page")
    class Docs {
      @get page() {
        return <h1>docs</h1>;
      }
    }
    const dir = mkdtempSync(join(tmpdir(), "yerd-rate-prerender-"));
    try {
      const server = yerd({ routes: [Docs], services: [], handleSignals: false }).guard(rateLimit({ limit: 1, window: "1m" }));
      await server.prerender(dir);
      expect(readFileSync(join(dir, "docs", "b", "index.html"), "utf8")).toContain("<h1>docs</h1>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses bad options", () => {
    expect(() => rateLimit({ limit: 0, window: "1m" })).toThrow("positive integer");
    expect(() => rateLimit({ limit: 1.5, window: "1m" })).toThrow("positive integer");
    expect(() => rateLimit({ limit: 1, window: 0 })).toThrow("longer than 0");
    expect(() => rateLimit({ limit: 1, window: "soon" })).toThrow("Invalid duration");
    expect(() => new MemoryRateLimitStore({ maxKeys: 0 })).toThrow("positive integer");
  });
});

describe("MemoryRateLimitStore", () => {
  it("counts in fixed windows and sweeps expired ones", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = new MemoryRateLimitStore();
    const start = Date.now();
    expect(store.hit("a", 1000)).toEqual({ count: 1, resetAt: start + 1000 });
    expect(store.hit("a", 1000)).toEqual({ count: 2, resetAt: start + 1000 });
    store.hit("b", 1000);
    expect(store.size).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(store.hit("a", 1000)).toEqual({ count: 1, resetAt: start + 2000 });
    // "b" expired and was swept on the way.
    expect(store.size).toBe(1);
  });

  it("drops the oldest window past maxKeys", () => {
    const store = new MemoryRateLimitStore({ maxKeys: 2 });
    store.hit("a", 60_000);
    store.hit("a", 60_000);
    store.hit("b", 60_000);
    store.hit("c", 60_000);
    expect(store.size).toBe(2);
    // "a" was forgotten: it starts over.
    expect(store.hit("a", 60_000).count).toBe(1);
    expect(store.hit("c", 60_000).count).toBe(2);
  });
});
