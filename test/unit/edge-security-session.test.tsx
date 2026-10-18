// The Session API in every order, through a real server: what gets saved, what gets dropped, what cookies go out.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HttpError, MemoryStore, Session, action, get, post, query, route, session, setHeader, yerd,
  type RunningServer, type SessionStore,
} from "@toyz/yerd";
import { shapeSession } from "../../src/session/session.js";

const SECRET = "e".repeat(32);

declare module "@toyz/yerd" {
  interface SessionData {
    name?: string;
    n?: number;
  }
}

/**
 * Runs a list of session operations from the query string, e.g.
 * `?do=destroy,set:name=bob,flash:notice=hi`, then answers with what it saw.
 */
@route("/ops")
class Ops {
  @session accessor session!: Session;
  @query("do") accessor ops: string | undefined;

  @post run() {
    const s = this.session;
    const seen: Record<string, unknown> = { isNew: s.isNew };
    for (const op of (this.ops ?? "").split(",").filter(Boolean)) {
      const [verb, arg = ""] = op.split(":") as [string, string?];
      const [key = "", value] = arg.split("=");
      if (verb === "set") s.set(key as "name", value!);
      else if (verb === "del") s.delete(key as "name");
      else if (verb === "clear") s.clear();
      else if (verb === "destroy") s.destroy();
      else if (verb === "regen") s.regenerate();
      else if (verb === "flash") s.flash(key, value);
      else if (verb === "read") seen[`flash:${key}`] = s.flash(key) ?? null;
      else if (verb === "prop") (s as unknown as Record<string, unknown>)[key] = value === undefined ? undefined : value;
      else if (verb === "throw") throw new Error("crash");
      else if (verb === "http") throw new HttpError(400, "nope");
    }
    seen.name = s.get("name") ?? null;
    return seen;
  }
}

@route("/peek")
class Peek {
  @session accessor session!: Session;
  @get show() {
    return { name: this.session.get("name") ?? null, notice: this.session.flash("notice") ?? null, isNew: this.session.isNew };
  }
}

function client(base: string) {
  let jar = "";
  const sets: string[] = [];
  return {
    sets,
    get jar() {
      return jar;
    },
    async fetch(path: string, init: RequestInit = {}) {
      const r = await fetch(base + path, { redirect: "manual", ...init, headers: { cookie: jar, ...(init.headers as object) } });
      for (const c of r.headers.getSetCookie()) {
        sets.push(c);
        jar = /Max-Age=0/.test(c) ? "" : c.split(";")[0]!;
      }
      return r;
    },
    async ops(list: string) {
      return this.fetch(`/ops?do=${encodeURIComponent(list)}`, { method: "POST" });
    },
    async peek() {
      return (await this.fetch("/peek")).json() as Promise<{ name: string | null; notice: string | null; isNew: boolean }>;
    },
  };
}

type Case = [ops: string, status: number, after: { name: string | null; notice?: string | null }, cookie: "cleared" | "set" | "none"];

const orders: Case[] = [
  ["destroy", 200, { name: null }, "cleared"],
  ["destroy,set:name=bob", 200, { name: "bob" }, "set"],
  ["regen,destroy", 200, { name: null }, "cleared"],
  ["destroy,regen", 200, { name: null }, "cleared"],
  ["destroy,flash:notice=bye", 200, { name: null, notice: "bye" }, "set"],
  ["set:name=bob,destroy", 200, { name: null }, "cleared"],
  ["clear", 200, { name: null }, "set"],
  ["destroy,clear", 200, { name: null }, "cleared"],
  ["destroy,del:name", 200, { name: null }, "cleared"],
  ["destroy,set:name=bob,destroy", 200, { name: null }, "cleared"],
  ["destroy,set:name=bob,regen", 200, { name: "bob" }, "set"],
  ["regen", 200, { name: "ada" }, "set"],
  ["regen,regen", 200, { name: "ada" }, "set"],
  ["set:name=bob,throw", 500, { name: "ada" }, "none"],
  ["destroy,throw", 500, { name: "ada" }, "none"],
  ["set:name=bob,http", 400, { name: "bob" }, "set"],
  ["destroy,http", 400, { name: null }, "cleared"],
  ["del:name", 200, { name: null }, "set"],
  ["del:missing", 200, { name: "ada" }, "none"],
  ["set:name=ada", 200, { name: "ada" }, "set"],
  ["prop:name", 200, { name: null }, "set"],
  ["prop:name=zed", 200, { name: "zed" }, "set"],
  ["read:notice", 200, { name: "ada" }, "none"],
  ["clear,set:name=bob", 200, { name: "bob" }, "set"],
];

describe.each<[string, () => SessionStore | undefined]>([
  ["cookie store", () => undefined],
  ["memory store", () => new MemoryStore()],
])("session operations in order (%s)", (_label, makeStore) => {
  let server: RunningServer;
  let store: SessionStore | undefined;
  beforeAll(async () => {
    store = makeStore();
    server = await yerd({ routes: [Ops, Peek], services: [], handleSignals: false, secret: SECRET })
      .sessions(store ? { store } : {})
      .listen(0, "127.0.0.1");
  });
  afterAll(() => server.close());

  it.each(orders)("%s", async (ops, status, after, cookie) => {
    const c = client(server.url);
    await c.ops("set:name=ada");
    c.sets.length = 0;
    const r = await c.ops(ops);
    expect(r.status).toBe(status);
    const sent = c.sets;
    if (cookie === "none") expect(sent).toEqual([]);
    if (cookie === "cleared") {
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatch(/^yerd_session=; Max-Age=0;/);
    }
    if (cookie === "set") {
      expect(sent).toHaveLength(1);
      expect(sent[0]).not.toMatch(/Max-Age=0/);
    }
    // Only a cleared cookie leaves the next request without a session.
    expect(await c.peek()).toEqual({ name: after.name, notice: after.notice ?? null, isNew: cookie === "cleared" });
  });

  it("a crash after destroy() keeps the old session working (nothing commits)", async () => {
    const c = client(server.url);
    await c.ops("set:name=ada");
    const jar = c.jar;
    await c.ops("destroy,throw");
    expect(c.jar).toBe(jar);
    expect((await c.peek()).name).toBe("ada");
  });
});

describe("ids across operations (memory store)", () => {
  let server: RunningServer;
  const store = new MemoryStore();
  beforeAll(async () => {
    server = await yerd({ routes: [Ops, Peek], services: [], handleSignals: false, secret: SECRET }).sessions({ store }).listen(0, "127.0.0.1");
  });
  afterAll(() => server.close());

  it("regenerate and destroy-then-set retire the old record; clear keeps it", async () => {
    const c = client(server.url);
    await c.ops("set:name=ada");
    expect(store.size).toBe(1);
    await c.ops("regen");
    expect(store.size).toBe(1);
    await c.ops("destroy,set:name=bob");
    expect(store.size).toBe(1);
    await c.ops("clear,set:name=cy");
    expect(store.size).toBe(1);
    await c.ops("destroy");
    expect(store.size).toBe(0);
  });

  it("the cookie from before a regenerate stops working", async () => {
    const c = client(server.url);
    await c.ops("set:name=ada");
    const stolen = c.jar;
    await c.ops("regen");
    const r = await fetch(server.url + "/peek", { headers: { cookie: stolen } });
    expect((await r.json()).name).toBeNull();
  });

  it("the cookie from before a destroy stops working", async () => {
    const c = client(server.url);
    await c.ops("set:name=ada");
    const stolen = c.jar;
    await c.ops("destroy");
    expect((await (await fetch(server.url + "/peek", { headers: { cookie: stolen } })).json()).name).toBeNull();
  });
});

describe("cookie store replay (stateless by design)", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await yerd({ routes: [Ops, Peek], services: [], handleSignals: false, secret: SECRET }).sessions().listen(0, "127.0.0.1");
  });
  afterAll(() => server.close());

  it("a copied cookie still loads after destroy() until it expires: there is no server state to revoke", async () => {
    // Documented trade-off of CookieStore; use an id store when logout must revoke copies.
    const c = client(server.url);
    await c.ops("set:name=ada");
    const copied = c.jar;
    await c.ops("destroy");
    expect((await (await fetch(server.url + "/peek", { headers: { cookie: copied } })).json()).name).toBe("ada");
  });
});

describe("flash", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await yerd({ routes: [Ops, Peek], services: [], handleSignals: false, secret: SECRET }).sessions().listen(0, "127.0.0.1");
  });
  afterAll(() => server.close());

  it("lives exactly one request, read or not", async () => {
    const c = client(server.url);
    await c.ops("flash:notice=hi");
    expect((await c.peek()).notice).toBe("hi");
    expect((await c.peek()).notice).toBeNull();
    await c.ops("flash:notice=again");
    await c.ops(""); // unread, but this request still consumes it
    expect((await c.peek()).notice).toBeNull();
  });

  it("a flash read in the same request it was set isn't there yet", async () => {
    const c = client(server.url);
    const r = await c.ops("flash:notice=hi,read:notice");
    expect((await r.json())["flash:notice"]).toBeNull();
    expect((await c.peek()).notice).toBe("hi");
  });

  it("a flash on a brand new visitor starts a session", async () => {
    const c = client(server.url);
    const r = await c.ops("flash:notice=welcome");
    expect(r.headers.getSetCookie()).toHaveLength(1);
    expect(await c.peek()).toEqual({ name: null, notice: "welcome", isNew: false });
  });

  it("a flash set then the session destroyed is dropped", async () => {
    const c = client(server.url);
    await c.ops("set:name=ada");
    await c.ops("flash:notice=x,destroy");
    expect(await c.peek()).toEqual({ name: null, notice: null, isNew: true });
  });
});

describe("isNew", () => {
  @route("/with-action")
  class WithAction {
    @session accessor session!: Session;
    @get page() {
      return (
        <div>
          <p id="new">{String(this.session.isNew)}</p>
          <form action={this.go} />
        </div>
      );
    }
    @action go() {}
  }

  let server: RunningServer;
  beforeAll(async () => {
    server = await yerd({ routes: [WithAction, Ops, Peek], services: [], handleSignals: false, secret: SECRET }).sessions().listen(0, "127.0.0.1");
  });
  afterAll(() => server.close());

  it("is true on a first page visit even when the page's form sets the CSRF nonce", async () => {
    const c = client(server.url);
    const first = await (await c.fetch("/with-action", { headers: { accept: "text/html" } })).text();
    expect(first).toContain('<p id="new">true</p>');
    const second = await (await c.fetch("/with-action", { headers: { accept: "text/html" } })).text();
    expect(second).toContain('<p id="new">false</p>');
  });

  it("stays true for the whole first request, even after a set()", async () => {
    const c = client(server.url);
    expect((await (await c.ops("set:name=ada")).json()).isNew).toBe(true);
    expect((await (await c.ops("")).json()).isNew).toBe(false);
  });

  it("is false for a session that holds only a flash, or was cleared", async () => {
    const c = client(server.url);
    await c.ops("flash:notice=hi");
    expect((await c.peek()).isNew).toBe(false);
    const d = client(server.url);
    await d.ops("set:name=ada");
    await d.ops("clear");
    expect((await d.peek()).isNew).toBe(false);
  });

  it("is true for a garbage or foreign cookie", async () => {
    const r = await fetch(server.url + "/peek", { headers: { cookie: "yerd_session=garbage" } });
    expect((await r.json()).isNew).toBe(true);
  });
});

describe("Session objects directly", () => {
  const fresh = () => new Session<Record<string, unknown>>(undefined, undefined) as unknown as Session & Record<string, unknown>;

  it("doesn't find Object.prototype members as values", () => {
    const s = fresh();
    for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf", "isPrototypeOf"]) {
      expect(s.get(key as "name"), key).toBeUndefined();
    }
    expect(s.flash("constructor")).toBeUndefined();
    expect(s.flash("toString")).toBeUndefined();
  });

  it("deleting or reading a key it never had isn't a change", () => {
    const s = fresh();
    s.delete("toString" as "name");
    s.flash("hasOwnProperty");
    expect(s.state.dirty).toBe(false);
  });

  it("stores a __proto__ key as data instead of swapping the prototype", () => {
    const s = fresh();
    s.set("__proto__" as "name", { admin: true } as never);
    expect(s.get("admin" as "name")).toBeUndefined();
    expect(JSON.parse(JSON.stringify(s.state.record.data))).toEqual(JSON.parse('{"__proto__":{"admin":true}}'));
  });

  it("loads a record carrying a __proto__ key as plain data", () => {
    const record = JSON.parse('{"data":{"__proto__":{"admin":true},"name":"ada"},"flash":{},"createdAt":1}');
    const s = new Session(record, undefined) as unknown as Session & Record<string, unknown>;
    expect(s.get("name")).toBe("ada");
    expect(s.get("admin" as "name")).toBeUndefined();
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it("assigning undefined deletes; `in` and delete work as for data", () => {
    const s = fresh();
    s.name = "ada";
    expect("name" in s).toBe(true);
    s.name = undefined;
    expect("name" in s).toBe(false);
    expect(Object.keys(s.state.record.data)).toEqual([]);
    s.n = 0;
    expect("n" in s).toBe(true); // falsy but present
    delete s.n;
    expect(s.get("n")).toBeUndefined();
  });

  it("null and other falsy values are kept", () => {
    const s = fresh();
    s.set("a" as "name", null as never);
    s.set("b" as "name", false as never);
    s.set("c" as "name", "" as never);
    expect(JSON.parse(JSON.stringify(s.state.record.data))).toEqual({ a: null, b: false, c: "" });
  });

  it("symbol-keyed properties never reach the saved data", () => {
    const s = fresh();
    const key = Symbol("x");
    (s as unknown as Record<symbol, unknown>)[key] = 1;
    expect((s as unknown as Record<symbol, unknown>)[key]).toBe(1);
    expect(s.state.record.data).toEqual({});
    expect(key in s).toBe(true);
    expect(Symbol("other") in s).toBe(false);
  });

  it("Session members aren't data: writing createdAt or isNew throws, get('id') is data", () => {
    const s = fresh();
    expect(() => {
      (s as unknown as { createdAt: number }).createdAt = 1;
    }).toThrow(TypeError);
    expect(() => {
      (s as unknown as { isNew: boolean }).isNew = false;
    }).toThrow(TypeError);
    s.set("id" as "name", "data-id");
    expect(s.id).toBeUndefined();
    expect(s.get("id" as "name")).toBe("data-id");
  });

  it("notices changes made in place, and their undoing", () => {
    const s = new Session({ data: { list: [1, 2] }, flash: {}, createdAt: 1 }, undefined) as unknown as Session & { list: number[] };
    s.list.push(3);
    expect(s.state.dirty).toBe(true);
    s.list.pop();
    expect(s.state.dirty).toBe(false);
  });

  it("isNew depends on whether a record arrived, not on what it holds", () => {
    expect(new Session(undefined, undefined).isNew).toBe(true);
    expect(new Session({ data: {}, flash: {}, createdAt: 1 }, undefined).isNew).toBe(false);
    expect(new Session({ data: {}, flash: { n: 1 }, createdAt: 1 }, undefined).isNew).toBe(false);
  });

  it("writing after destroy() starts a new session with a new createdAt", () => {
    const s = new Session({ data: { name: "ada" }, flash: {}, createdAt: 1 }, "old") as unknown as Session;
    s.destroy();
    s.set("name", "bob");
    expect(s.createdAt).toBeGreaterThan(1);
    expect(s.state).toMatchObject({ destroyed: false, replaced: true, regenerated: true });
  });
});

describe("shapes", () => {
  class Cart {
    items: string[] = [];
    coupon?: string;
    get count() {
      return this.items.length;
    }
    set code(value: string) {
      this.coupon = value.toUpperCase();
    }
    add(item: string) {
      this.items.push(item);
    }
  }

  @route("/shape")
  class ShapePage {
    @session(Cart) accessor cart!: Session<Cart>;
    @get show() {
      return { items: this.cart.items, count: this.cart.count, coupon: this.cart.coupon ?? null, has: "items" in this.cart };
    }
    @post add() {
      this.cart.add("socks");
      return { items: this.cart.items };
    }
  }

  let server: RunningServer;
  beforeAll(async () => {
    server = await yerd({ routes: [ShapePage], services: [], handleSignals: false, secret: SECRET }).sessions().listen(0, "127.0.0.1");
  });
  afterAll(() => server.close());

  it("reading defaults sends no cookie", async () => {
    const c = client(server.url);
    const r = await c.fetch("/shape");
    expect(await r.json()).toEqual({ items: [], count: 0, coupon: null, has: true });
    expect(r.headers.getSetCookie()).toEqual([]);
  });

  it("a change through a method is saved; defaults never leak between visitors", async () => {
    const a = client(server.url);
    expect(await (await a.fetch("/shape", { method: "POST" })).json()).toEqual({ items: ["socks"] });
    expect(await (await a.fetch("/shape", { method: "POST" })).json()).toEqual({ items: ["socks", "socks"] });
    const b = client(server.url);
    expect((await (await b.fetch("/shape")).json()).items).toEqual([]);
  });

  it("setters run with the session as this", async () => {
    @route("/shape2")
    class ShapeCode {
      @session(Cart) accessor cart!: Session<Cart>;
      @post set() {
        this.cart.code = "half";
        return { coupon: this.cart.coupon };
      }
    }
    const app = await yerd({ routes: [ShapeCode], services: [], handleSignals: false, secret: SECRET }).sessions().listen(0, "127.0.0.1");
    try {
      const r = await fetch(app.url + "/shape2", { method: "POST" });
      expect(await r.json()).toEqual({ coupon: "HALF" });
    } finally {
      await app.close();
    }
  });

  it("refuses a shape whose method shadows a Session member", () => {
    class Bad {
      items: string[] = [];
      clear() {
        this.items = [];
      }
    }
    class AlsoBad {
      flash() {}
    }
    class Inherited extends AlsoBad {}
    class ToStringShape {
      toString() {
        return "x";
      }
    }
    const s = new Session(undefined, undefined);
    expect(() => shapeSession(s, Bad)).toThrow(/"clear" is a Session member/);
    expect(() => shapeSession(s, Inherited)).toThrow(/"flash" is a Session member/);
    expect(() => shapeSession(s, ToStringShape)).toThrow(/"toString" is a Session member/);
  });

  it("allows a data field named like a member (only reachable with get/set)", () => {
    class WithId {
      id = "default";
    }
    const view = shapeSession(new Session(undefined, undefined), WithId) as unknown as Session & { id: unknown };
    expect(view.id).toBeUndefined();
  });

  it("one view per session and shape, and a fresh one per request", () => {
    const s1 = new Session(undefined, undefined);
    const s2 = new Session(undefined, undefined);
    expect(shapeSession(s1, Cart)).toBe(shapeSession(s1, Cart));
    expect(shapeSession(s1, Cart)).not.toBe(shapeSession(s2, Cart));
    const v1 = shapeSession(s1, Cart) as unknown as Cart;
    v1.items.push("x");
    expect((shapeSession(s2, Cart) as unknown as Cart).items).toEqual([]);
  });
});

describe("Cache-Control for pages with a session", () => {
  @route("/page")
  class Page {
    @session accessor session!: Session;
    @get show() {
      return <p>{this.session.name ?? "anon"}</p>;
    }
  }
  @route("/page-json")
  class PageJson {
    @session accessor session!: Session;
    @get show() {
      return { name: this.session.name ?? null };
    }
  }
  @route("/page-cached")
  class PageCached {
    @session accessor session!: Session;
    @get @setHeader("cache-control", "public, max-age=60") show() {
      return <p>{this.session.name ?? "anon"}</p>;
    }
  }

  let server: RunningServer;
  beforeAll(async () => {
    server = await yerd({ routes: [Page, PageJson, PageCached, Ops], services: [], handleSignals: false, secret: SECRET })
      .sessions()
      .errorPage(({ status }) => <p>error {status}</p>)
      .listen(0, "127.0.0.1");
  });
  afterAll(() => server.close());

  it("anonymous HTML gets none", async () => {
    const r = await fetch(server.url + "/page");
    expect(r.headers.get("cache-control")).toBeNull();
    expect(r.headers.getSetCookie()).toEqual([]);
  });

  it("HTML for a visitor with a session is private, no-cache", async () => {
    const c = client(server.url);
    await c.ops("set:name=ada");
    const r = await c.fetch("/page");
    expect(await r.text()).toContain("ada");
    expect(r.headers.get("cache-control")).toBe("private, no-cache");
  });

  it("a garbage session cookie is anonymous: no private header", async () => {
    const r = await fetch(server.url + "/page", { headers: { cookie: "yerd_session=junk" } });
    expect(r.headers.get("cache-control")).toBeNull();
  });

  it("the handler's own Cache-Control wins", async () => {
    const c = client(server.url);
    await c.ops("set:name=ada");
    expect((await c.fetch("/page-cached")).headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("JSON responses are left alone (only HTML pages are marked)", async () => {
    const c = client(server.url);
    await c.ops("set:name=ada");
    expect((await c.fetch("/page-json")).headers.get("cache-control")).toBeNull();
  });

  it("an error page for an unknown path, shown to a signed-in visitor, is private too", async () => {
    const c = client(server.url);
    await c.ops("set:name=ada");
    const r = await c.fetch("/nope", { headers: { accept: "text/html" } });
    expect(r.status).toBe(404);
    expect(r.headers.get("cache-control")).toBe("private, no-cache");
  });
});
