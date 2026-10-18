import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryStore, get, post, route, seal, session, unseal, yerd, type RunningServer, type Session } from "@toyz/yerd";

declare module "@toyz/yerd" {
  interface SessionData {
    count?: number;
    name?: string;
  }
}

const SECRET = "s".repeat(32);

@route("/count")
class Count {
  @session accessor session!: Session;
  @get hit() {
    const count = (this.session.get("count") ?? 0) + 1;
    this.session.set("count", count);
    return { count };
  }
}

@route("/peek")
class Peek {
  @session accessor session!: Session;
  @get show() {
    return { count: this.session.get("count") ?? null, notice: this.session.flash("notice") ?? null };
  }
}

@route("/flash")
class Flash {
  @session accessor session!: Session;
  @post set() {
    this.session.flash("notice", "saved!");
    return 204;
  }
}

@route("/rotate")
class Rotate {
  @session accessor session!: Session;
  @post go() {
    this.session.regenerate();
    return 204;
  }
}

@route("/logout")
class Logout {
  @session accessor session!: Session;
  @post go() {
    this.session.destroy();
    return 204;
  }
}

@route("/relogin")
class Relogin {
  @session accessor session!: Session;
  @post go() {
    this.session.destroy();
    this.session.regenerate();
    this.session.set("name", "bob");
    return 204;
  }
}

@route("/bye")
class Bye {
  @session accessor session!: Session;
  @post go() {
    this.session.destroy();
    this.session.flash("notice", "signed out");
    return 204;
  }
}

/** A tiny cookie jar for fetch. */
function client(base: string) {
  let jar = "";
  const raw: string[] = [];
  return {
    raw,
    get jar() {
      return jar;
    },
    set jar(value: string) {
      jar = value;
    },
    async fetch(path: string, init: RequestInit = {}) {
      const r = await fetch(base + path, { ...init, headers: { ...(init.headers as object), cookie: jar } });
      for (const c of r.headers.getSetCookie()) {
        raw.push(c);
        const [pair] = c.split(";");
        jar = /Max-Age=0/.test(c) ? "" : pair!;
      }
      return r;
    },
  };
}

@route("/whoami")
class WhoAmI {
  @session accessor session!: Session;
  @get show() {
    return { name: this.session.get("name") ?? null, count: this.session.get("count") ?? null };
  }
}

function start(store?: MemoryStore, options: { trustProxy?: boolean } = {}) {
  return yerd({ routes: [Count, Peek, Flash, Rotate, Logout, Relogin, Bye, WhoAmI], services: [], handleSignals: false, secret: SECRET })
    .sessions(store ? { store, ...options } : options)
    .listen(0, "127.0.0.1");
}

describe("cookie sessions", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await start();
  });
  afterAll(() => server.close());

  it("round-trips data in a sealed, HttpOnly, SameSite cookie", async () => {
    const c = client(server.url);
    expect(await (await c.fetch("/count")).json()).toEqual({ count: 1 });
    expect(await (await c.fetch("/count")).json()).toEqual({ count: 2 });
    const cookie = c.raw[0]!;
    expect(cookie).toMatch(/^yerd_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/count/);
  });

  it("doesn't hand out a cookie when nothing was stored", async () => {
    const c = client(server.url);
    await c.fetch("/peek");
    expect(c.raw).toEqual([]);
  });

  it("ignores tampered cookies", async () => {
    const c = client(server.url);
    await c.fetch("/count");
    const [name, value] = c.jar.split("=");
    c.jar = `${name}=${value!.slice(0, -4)}AAAA`;
    expect(await (await c.fetch("/peek")).json()).toEqual({ count: null, notice: null });
  });

  it("delivers flash messages exactly once", async () => {
    const c = client(server.url);
    await c.fetch("/flash", { method: "POST" });
    expect((await (await c.fetch("/peek")).json()).notice).toBe("saved!");
    expect((await (await c.fetch("/peek")).json()).notice).toBe(null);
  });

  it("destroys the session and clears the cookie", async () => {
    const c = client(server.url);
    await c.fetch("/count");
    const r = await c.fetch("/logout", { method: "POST" });
    expect(r.headers.getSetCookie()[0]).toMatch(/Max-Age=0/);
    expect(await (await c.fetch("/peek")).json()).toEqual({ count: null, notice: null });
  });
});

describe("destroy, then write again", () => {
  for (const kind of ["cookie", "memory"] as const) {
    it(`starts a fresh session on login after logout (${kind} store)`, async () => {
      const store = kind === "memory" ? new MemoryStore() : undefined;
      const server = await start(store);
      try {
        const c = client(server.url);
        await c.fetch("/count");
        const before = c.jar;
        const r = await c.fetch("/relogin", { method: "POST" });
        expect(r.headers.getSetCookie()[0]).not.toMatch(/Max-Age=0/);
        expect(c.jar).not.toBe(before);
        expect(await (await c.fetch("/whoami")).json()).toEqual({ name: "bob", count: null });
        if (store) {
          // The old record is gone; only the new session is kept.
          expect(store.size).toBe(1);
          const stale = client(server.url);
          stale.jar = before;
          expect(await (await stale.fetch("/whoami")).json()).toEqual({ name: null, count: null });
        }
      } finally {
        await server.close();
      }
    });
  }

  it("keeps a flash set after destroy()", async () => {
    const server = await start();
    try {
      const c = client(server.url);
      await c.fetch("/count");
      await c.fetch("/bye", { method: "POST" });
      expect(await (await c.fetch("/peek")).json()).toEqual({ count: null, notice: "signed out" });
    } finally {
      await server.close();
    }
  });
});

describe("Secure cookies", () => {
  it("ignores X-Forwarded-Proto unless trustProxy is on", async () => {
    for (const trustProxy of [false, true]) {
      const server = await start(undefined, { trustProxy });
      try {
        const r = await fetch(server.url + "/count", { headers: { "x-forwarded-proto": "https" } });
        const cookie = r.headers.getSetCookie()[0]!;
        expect(cookie).toMatch(trustProxy ? /^__Host-yerd_session=.*Secure/ : /^yerd_session=/);
        if (!trustProxy) expect(cookie).not.toMatch(/Secure/);
      } finally {
        await server.close();
      }
    }
  });
});

describe("MemoryStore housekeeping", () => {
  const record = { data: {}, flash: {}, createdAt: 0 };

  it("sweeps expired sessions lazily on save, at most once per interval", () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryStore({ sweepInterval: 1000 });
      store.set("a", record, 100);
      store.set("b", record, 100);
      vi.advanceTimersByTime(500);
      store.set("c", record, 60_000);
      // Expired or not, nothing is swept before the interval passes.
      expect(store.size).toBe(3);
      vi.advanceTimersByTime(500);
      store.set("d", record, 60_000);
      expect(store.size).toBe(2);
      expect(store.get("c")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps its size, evicting the least recently saved", () => {
    const store = new MemoryStore({ maxSize: 2 });
    store.set("a", record, 60_000);
    store.set("b", record, 60_000);
    store.set("a", record, 60_000);
    store.set("c", record, 60_000);
    expect(store.size).toBe(2);
    expect(store.get("b")).toBeUndefined();
    expect(store.get("a")).toBeDefined();
    expect(store.get("c")).toBeDefined();
  });
});

describe("memory store sessions", () => {
  const store = new MemoryStore();
  let server: RunningServer;
  beforeAll(async () => {
    server = await start(store);
  });
  afterAll(() => server.close());

  it("keeps data server-side and issues a new id on regenerate, dropping the old one", async () => {
    const c = client(server.url);
    await c.fetch("/count");
    await c.fetch("/count");
    expect(store.size).toBe(1);
    const before = c.jar;
    await c.fetch("/rotate", { method: "POST" });
    expect(c.jar).not.toBe(before);
    expect(store.size).toBe(1);
    expect(await (await c.fetch("/peek")).json()).toMatchObject({ count: 2 });
    // The pre-rotation cookie no longer works.
    const stale = client(server.url);
    stale.jar = before;
    expect(await (await stale.fetch("/peek")).json()).toMatchObject({ count: null });
  });
});

describe("sealing", () => {
  it("opens with any secret in the list (rotation) and rejects others", () => {
    const sealed = seal(["old".repeat(11)], { a: 1 });
    expect(unseal(["new".repeat(11), "old".repeat(11)], sealed)).toEqual({ a: 1 });
    expect(unseal(["other".repeat(7)], sealed)).toBeUndefined();
    expect(unseal(["old".repeat(11)], "garbage")).toBeUndefined();
  });
});
