import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore, Session, get, post, route, session, yerd, type RunningServer, type SessionRecord } from "@toyz/yerd";
import { shapeSession } from "../../src/session/session.js";

interface Cart {
  items?: string[];
  coupon?: string;
  /** Clashes with Session.id: only reachable through get()/set(). */
  id?: string;
}

const SECRET = "f".repeat(32);

@route("/cart")
class Show {
  @session accessor session!: Session<Cart>;
  @get show() {
    return { items: this.session.items ?? [], coupon: this.session.coupon ?? null, has: "coupon" in this.session };
  }
}

@route("/cart/add")
class Add {
  @session accessor session!: Session<Cart>;
  @post add() {
    // In place, never set() again: still saved.
    this.session.items ??= [];
    this.session.items.push(`item${this.session.items.length}`);
    return 204;
  }
}

@route("/cart/coupon")
class Coupon {
  @session accessor session!: Session<Cart>;
  @post add() {
    this.session.coupon = "HALF";
    return 204;
  }
}

@route("/cart/uncoupon")
class Uncoupon {
  @session accessor session!: Session<Cart>;
  @post remove() {
    this.session.coupon = undefined;
    return 204;
  }
}

@route("/cart/peek")
class Peek {
  @session accessor session!: Session<Cart>;
  @get peek() {
    // Reading (even an object) changes nothing, so no cookie is sent.
    return { n: this.session.items?.length ?? 0 };
  }
}

function client(base: string) {
  let jar = "";
  let sets = 0;
  return {
    get sets() {
      return sets;
    },
    async fetch(path: string, init: RequestInit = {}) {
      const r = await fetch(base + path, { ...init, headers: { cookie: jar, origin: base } });
      for (const c of r.headers.getSetCookie()) {
        sets++;
        jar = c.split(";")[0]!;
      }
      return r;
    },
  };
}

describe("session values as properties", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await yerd({ routes: [Show, Add, Coupon, Uncoupon, Peek], services: [], handleSignals: false, secret: SECRET }).sessions().listen(0, "127.0.0.1");
  });
  afterAll(() => server.close());

  it("reads, writes and deletes through properties, saving in-place changes", async () => {
    const c = client(server.url);
    await c.fetch("/cart/add", { method: "POST" });
    await c.fetch("/cart/add", { method: "POST" });
    await c.fetch("/cart/coupon", { method: "POST" });
    expect(await (await c.fetch("/cart")).json()).toEqual({ items: ["item0", "item1"], coupon: "HALF", has: true });
    await c.fetch("/cart/uncoupon", { method: "POST" });
    expect(await (await c.fetch("/cart")).json()).toEqual({ items: ["item0", "item1"], coupon: null, has: false });
  });

  it("sends no cookie when a request only read", async () => {
    const c = client(server.url);
    await c.fetch("/cart/add", { method: "POST" });
    const before = c.sets;
    expect(await (await c.fetch("/cart/peek")).json()).toEqual({ n: 1 });
    expect(c.sets).toBe(before);
  });
});

describe("Session object", () => {
  it("keeps members over fields, and binds methods to the real instance", () => {
    const s = new Session<Cart>(undefined, undefined);
    s.set("id", "data-id");
    expect(s.id).toBeUndefined();
    expect(s.get("id")).toBe("data-id");
    const { get: read } = s;
    expect(read("id")).toBe("data-id");
    expect(s instanceof Session).toBe(true);
    s.items = ["a"];
    expect(s.state.record.data).toEqual({ id: "data-id", items: ["a"] });
    delete s.items;
    expect(s.get("items")).toBeUndefined();
  });
});

@route("/login")
class Login {
  @session accessor session!: Session<Cart>;
  @post go() {
    this.session.regenerate();
    this.session.coupon = "WELCOME";
    return 204;
  }
}

describe("sessions({ generateId })", () => {
  class Recording extends MemoryStore {
    ids: string[] = [];
    override set(id: string, record: SessionRecord, ttl: number) {
      this.ids.push(id);
      super.set(id, record, ttl);
    }
  }
  let server: RunningServer;
  const store = new Recording();
  let n = 0;
  beforeAll(async () => {
    server = await yerd({ routes: [Add, Show, Login], services: [], handleSignals: false, secret: SECRET })
      .sessions({ store, generateId: async () => `sess_${++n}` })
      .listen(0, "127.0.0.1");
  });
  afterAll(() => server.close());

  it("names new and regenerated sessions with it", async () => {
    const c = client(server.url);
    await c.fetch("/cart/add", { method: "POST" });
    await c.fetch("/cart/add", { method: "POST" });
    await c.fetch("/login", { method: "POST" });
    expect(store.ids).toEqual(["sess_1", "sess_1", "sess_2"]);
    expect(store.get("sess_1")).toBeUndefined();
    expect(await (await c.fetch("/cart")).json()).toEqual({ items: ["item0", "item1"], coupon: "WELCOME", has: true });
  });

  it("is refused with a CookieStore, which has no ids", () => {
    expect(() => yerd({ routes: [], services: [], handleSignals: false, secret: SECRET }).sessions({ generateId: () => "x" })).toThrow(/kind: "id"/);
  });
});

class Basket {
  items: string[] = [];
  coupon?: string;
  visits = 0;
  get count() {
    return this.items.length;
  }
  get discounted() {
    return this.coupon !== undefined;
  }
  set promo(code: string) {
    this.coupon = code.toUpperCase();
  }
  add(item: string) {
    this.items.push(item);
    return this.count;
  }
}

@route("/basket")
class BasketShow {
  @session(Basket) accessor basket!: Session<Basket>;
  @get show() {
    // Reads defaults only: nothing saved.
    return { items: this.basket.items, count: this.basket.count, visits: this.basket.visits, discounted: this.basket.discounted };
  }
}

@route("/basket/add")
class BasketAdd {
  @session(Basket) accessor basket!: Session<Basket>;
  @post add() {
    this.basket.add(`item${this.basket.count}`);
    return { count: this.basket.count };
  }
}

@route("/basket/promo")
class BasketPromo {
  @session(Basket) accessor basket!: Session<Basket>;
  @session accessor raw!: Session<{ coupon?: string }>;
  @post go() {
    this.basket.promo = "half";
    // Same session underneath: the plain view sees it.
    return { coupon: this.raw.coupon ?? null };
  }
}

describe("@session(Shape)", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await yerd({ routes: [BasketShow, BasketAdd, BasketPromo], services: [], handleSignals: false, secret: SECRET })
      .sessions()
      .listen(0, "127.0.0.1");
  });
  afterAll(() => server.close());

  it("runs the class's methods, getters and setters on the session", async () => {
    const c = client(server.url);
    expect(await (await c.fetch("/basket/add", { method: "POST" })).json()).toEqual({ count: 1 });
    expect(await (await c.fetch("/basket/add", { method: "POST" })).json()).toEqual({ count: 2 });
    expect(await (await c.fetch("/basket/promo", { method: "POST" })).json()).toEqual({ coupon: "HALF" });
    expect(await (await c.fetch("/basket")).json()).toEqual({ items: ["item0", "item1"], count: 2, visits: 0, discounted: true });
  });

  it("fills in defaults without saving them until they change", async () => {
    const c = client(server.url);
    expect(await (await c.fetch("/basket")).json()).toEqual({ items: [], count: 0, visits: 0, discounted: false });
    expect(c.sets).toBe(0);
  });

  it("gives each request fresh defaults", () => {
    const one = new Session(undefined, undefined);
    const two = new Session(undefined, undefined);
    const a = shapeSession(one, Basket);
    a.add("x");
    expect(shapeSession(two, Basket).items).toEqual([]);
    expect(shapeSession(one, Basket)).toBe(a);
    expect(one.state.dirty).toBe(true);
    expect(two.state.dirty).toBe(false);
  });

  it("refuses a shape whose method a Session member would shadow", () => {
    // session.clear() would win and wipe the whole session (sign-in included), not just the items.
    class Clashing {
      items: string[] = [];
      clear() {
        this.items = [];
      }
    }
    class Base {
      flash() {}
    }
    class Inherited extends Base {}
    expect(() => shapeSession(new Session(undefined, undefined), Clashing)).toThrow(/"clear" is a Session member/);
    expect(() => shapeSession(new Session(undefined, undefined), Inherited)).toThrow(/"flash" is a Session member/);
    // Members that don't clash are fine, getters included.
    expect(shapeSession(new Session(undefined, undefined), Basket).count).toBe(0);
  });
});

describe("MemoryStore under the dev server", () => {
  const DEV = Symbol.for("yerd.devAssets");
  const record = { data: { a: 1 }, flash: {}, createdAt: Date.now() };

  it("keeps sessions across app reloads (a new store with the same name)", () => {
    (globalThis as Record<symbol, unknown>)[DEV] = { root: "/", publicDir: false, client: [] };
    try {
      new MemoryStore({ name: "reload-test" }).set("id1", record, 60_000);
      expect(new MemoryStore({ name: "reload-test" }).get("id1")?.data).toEqual({ a: 1 });
      expect(new MemoryStore({ name: "other" }).get("id1")).toBeUndefined();
    } finally {
      delete (globalThis as Record<symbol, unknown>)[DEV];
    }
  });

  it("gives every store its own records otherwise", () => {
    new MemoryStore({ name: "prod-test" }).set("id1", record, 60_000);
    expect(new MemoryStore({ name: "prod-test" }).get("id1")).toBeUndefined();
  });
});

@route("/whoami-page")
class WhoAmIPage {
  @session accessor session!: Session<{ name?: string }>;
  @get page() {
    return <p>{this.session.name ?? "guest"}</p>;
  }
}

@route("/whoami-page/login")
class WhoAmILogin {
  @session accessor session!: Session<{ name?: string }>;
  @post go() {
    this.session.name = "ada";
    return 204;
  }
}

describe("pages for someone with a session", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await yerd({ routes: [WhoAmIPage, WhoAmILogin], services: [], handleSignals: false, secret: SECRET }).sessions().listen(0, "127.0.0.1");
  });
  afterAll(() => server.close());

  it("aren't cacheable by shared caches or Back", async () => {
    const c = client(server.url);
    const before = await c.fetch("/whoami-page");
    expect(before.headers.get("cache-control")).toBeNull();
    await c.fetch("/whoami-page/login", { method: "POST" });
    const after = await c.fetch("/whoami-page");
    expect(await after.text()).toContain("ada");
    expect(after.headers.get("cache-control")).toBe("private, no-cache");
  });
});
