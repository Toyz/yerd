// Lazy sessions: opened on first use, read up front only from async stores, never on `session: false` routes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, currentContext, get, group, post, route, session, yerd, type Middleware, type Session, type SessionRecord, type SessionStore } from "@toyz/yerd";
import { createAuth } from "@toyz/yerd/auth";
import { unsealFor } from "../../src/session/session.js";
import { SessionManager } from "../../src/session/manager.js";

// Count every unseal of a session cookie.
vi.mock(import("../../src/session/session.js"), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, unsealFor: vi.fn(original.unsealFor) as typeof original.unsealFor };
});

const SECRET = "l".repeat(32);
const unseals = vi.mocked(unsealFor);

afterEach(() => {
  vi.restoreAllMocks();
  unseals.mockClear();
});

declare module "@toyz/yerd" {
  interface SessionData {
    name?: string;
  }
}

const lazyAuth = createAuth<{ id: string }>({ load: (id) => ({ id }), sessionKey: "lazy_uid" });

@route("/json")
class Json {
  @get read() {
    return { ok: true };
  }
}

@route("/page")
class Page {
  @get show() {
    return <p>no session read here</p>;
  }
}

@route("/name")
class Name {
  @session accessor session!: Session;
  // Synchronous: the session has to be in hand without awaiting anything.
  @get read() {
    return { name: this.session.name ?? null };
  }
  @post write() {
    currentContext().session.name = "ada";
    return 204;
  }
}

@route("/api/peek", { session: false })
class Peek {
  @get read() {
    try {
      return { name: currentContext().session.name ?? null };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }
}

@group("/v1", { session: false })
class V1 {}

@route("/items", { group: V1 })
class Items {
  @get list() {
    try {
      currentContext().session;
      return { session: true };
    } catch {
      return { session: false };
    }
  }
}

@route("/me", { group: V1, session: true })
class Me {
  @get show() {
    return { name: currentContext().session.name ?? null };
  }
}

@route("/whoami-api", { session: false })
class WhoAmIApi {
  @get show() {
    return { user: lazyAuth.current()?.id ?? null };
  }
}

const routes = [Json, Page, Name, Peek, Items, Me, WhoAmIApi];

/** An id store whose reads take a trip through the event loop, like Redis. */
class AsyncStore implements SessionStore {
  readonly kind = "id" as const;
  readonly records = new Map<string, SessionRecord>();
  readonly log: string[] = [];
  fail = false;
  async get(id: string) {
    this.log.push("get started");
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (this.fail) throw new Error("store down");
    this.log.push("get settled");
    return structuredClone(this.records.get(id));
  }
  async set(id: string, record: SessionRecord) {
    this.records.set(id, structuredClone(record));
  }
  async destroy(id: string) {
    this.records.delete(id);
  }
}

function makeApp(store?: SessionStore, extra: { use?: Middleware; rolling?: boolean } = {}) {
  const app = yerd({ routes, services: [], handleSignals: false, secret: SECRET }).sessions({ ...(store ? { store } : {}), rolling: extra.rolling });
  if (extra.use) app.use(extra.use);
  return app;
}

/** A client that has signed in (the session holds a name). */
async function withSession(app: ReturnType<typeof makeApp>) {
  const client = app.client();
  await client.request("/name", { method: "POST" });
  expect(client.cookies.get("yerd_session")).toBeDefined();
  return client;
}

describe.each<[string, () => MemoryStore | undefined]>([
  ["cookie store", () => undefined],
  ["memory store", () => new MemoryStore()],
])("a session cookie on a request that never uses the session (%s)", (_label, makeStore) => {
  it("isn't unsealed or read from the store, and nothing is committed", async () => {
    const store = makeStore();
    const app = makeApp(store);
    const client = await withSession(app);
    const reads = store ? vi.spyOn(store, "get") : undefined;
    const commits = vi.spyOn(SessionManager.prototype, "commit");
    unseals.mockClear();
    const r = await client.request("/json");
    expect(await r.json()).toEqual({ ok: true });
    expect(unseals).not.toHaveBeenCalled();
    expect(reads?.mock.calls.length ?? 0).toBe(0);
    expect(commits).not.toHaveBeenCalled();
    expect(r.headers.getSetCookie()).toEqual([]);
  });

  it("is opened synchronously the first time something reads it, once", async () => {
    const store = makeStore();
    const app = makeApp(store);
    const client = await withSession(app);
    const reads = store ? vi.spyOn(store, "get") : undefined;
    unseals.mockClear();
    expect(await (await client.request("/name")).json()).toEqual({ name: "ada" });
    expect(unseals).toHaveBeenCalledTimes(1);
    if (reads) expect(reads).toHaveBeenCalledTimes(1);
  });
});

describe("an async store", () => {
  it("has its read started before middleware runs, so the handler reads the session synchronously", async () => {
    const store = new AsyncStore();
    const seen: string[][] = [];
    const watch: Middleware = (_ctx, next) => {
      seen.push([...store.log]);
      return next();
    };
    const app = makeApp(store, { use: watch });
    const client = await withSession(app);
    store.log.length = 0;
    seen.length = 0;
    expect(await (await client.request("/name")).json()).toEqual({ name: "ada" });
    expect(seen).toEqual([["get started", "get settled"]]);
  });

  it("is read up front even for a handler that doesn't use the session (it can't know), but not without a cookie", async () => {
    const store = new AsyncStore();
    const app = makeApp(store);
    const client = await withSession(app);
    store.log.length = 0;
    await client.request("/json");
    expect(store.log).toEqual(["get started", "get settled"]);
    store.log.length = 0;
    await app.request("/json");
    expect(store.log).toEqual([]);
  });

  it("is never read for a `session: false` route", async () => {
    const store = new AsyncStore();
    const app = makeApp(store);
    const client = await withSession(app);
    store.log.length = 0;
    expect(await (await client.request("/api/peek")).json()).toEqual({
      error: "Peek (/api/peek) has `session: false`, so it has no session; drop the option (on the route or its group) to use one there",
    });
    expect(store.log).toEqual([]);
  });

  it("failing is an error for a route that has a session, not for one that opted out", async () => {
    const store = new AsyncStore();
    const app = makeApp(store);
    const client = await withSession(app);
    store.fail = true;
    expect((await client.request("/name")).status).toBe(500);
    expect((await client.request("/api/peek")).status).toBe(200);
  });

  it("a store that says it's sync but returns a promise is refused plainly", async () => {
    const store = Object.assign(new AsyncStore(), { sync: true });
    const app = makeApp(store);
    const client = await withSession(app);
    const r = await client.request("/name");
    expect(r.status).toBe(500);
  });
});

describe("session: false", () => {
  it("never reads the store or unseals the cookie, and throws a clear error on access", async () => {
    const store = new MemoryStore();
    const app = makeApp(store);
    const client = await withSession(app);
    const reads = vi.spyOn(store, "get");
    unseals.mockClear();
    const r = await client.request("/api/peek");
    expect(await r.json()).toEqual({ error: expect.stringMatching(/^Peek \(\/api\/peek\) has `session: false`/) });
    expect(reads).not.toHaveBeenCalled();
    expect(unseals).not.toHaveBeenCalled();
    expect(r.headers.getSetCookie()).toEqual([]);
  });

  it("is inherited from a group, and a route's own setting wins", async () => {
    const app = makeApp();
    const client = await withSession(app);
    expect(await (await client.request("/v1/items")).json()).toEqual({ session: false });
    expect(await (await client.request("/v1/me")).json()).toEqual({ name: "ada" });
  });

  it("refuses to boot a route reading the session through @session", async () => {
    @route("/broken", { session: false })
    class Broken {
      @session accessor session!: Session;
      @get read() {
        return this.session.name ?? null;
      }
    }
    const app = yerd({ routes: [Broken], services: [], handleSignals: false, secret: SECRET }).sessions();
    await expect(app.start()).rejects.toThrow(/Broken\.session \(@session\): \/broken has `session: false`/);
  });

  it("auth middleware sees nobody signed in there, without reading the session", async () => {
    const store = new MemoryStore();
    const app = yerd({ routes, services: [], handleSignals: false, secret: SECRET }).sessions({ store }).use(lazyAuth);
    const client = app.client();
    await client.request("/name", { method: "POST" });
    const reads = vi.spyOn(store, "get");
    expect(await (await client.request("/whoami-api")).json()).toEqual({ user: null });
    expect(reads).not.toHaveBeenCalled();
  });
});

describe("rolling refresh", () => {
  it("extends only a session that was used", async () => {
    const T0 = 1_800_000_000_000;
    let now = T0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const app = makeApp(undefined, { rolling: true });
    const client = await withSession(app);
    // Past a tenth of the default 14-day maxAge: a used session is due for a refresh.
    now += 2 * 86_400_000;
    expect((await client.request("/json")).headers.getSetCookie()).toEqual([]);
    expect((await client.request("/name")).headers.getSetCookie()).toHaveLength(1);
  });
});

describe("unread flash", () => {
  @route("/flash")
  class Flash {
    @post set() {
      currentContext().session.flash("notice", "saved");
      return 204;
    }
    @get read() {
      return { notice: currentContext().session.flash("notice") ?? null };
    }
  }

  it("waits for the next request that uses the session", async () => {
    const app = yerd({ routes: [Flash, Json], services: [], handleSignals: false, secret: SECRET }).sessions();
    const client = app.client();
    await client.request("/flash", { method: "POST" });
    await client.request("/json");
    expect(await (await client.request("/flash")).json()).toEqual({ notice: "saved" });
    expect(await (await client.request("/flash")).json()).toEqual({ notice: null });
  });
});

describe("Cache-Control", () => {
  it("still marks HTML private for a visitor whose session cookie came in, read or not", async () => {
    const app = makeApp();
    const client = await withSession(app);
    expect((await client.request("/page")).headers.get("cache-control")).toBe("private, no-cache");
    expect((await app.request("/page")).headers.get("cache-control")).toBeNull();
  });
});
