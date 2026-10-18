// createAuth end to end: fixation, switching users, hooks that fail, guards for every kind of client, deleted users.
import { scrypt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore, get, post, query, route, seal, session, unseal, yerd, type RunningServer, type Session, type SessionStore } from "@toyz/yerd";
import { createAuth, hashPassword, verifyPassword } from "@toyz/yerd/auth";

interface User {
  id: string;
  name: string;
  roles: string[];
}

const users = new Map<string, User | null>([
  ["1", { id: "1", name: "ada", roles: ["admin"] }],
  ["2", { id: "2", name: "bob", roles: ["editor"] }],
  ["3", { id: "3", name: "cy", roles: [] }],
]);

/** What the hooks do this request. */
const hooks = { login: "ok" as "ok" | "throw" | "reject" | "async", logout: "ok" as "ok" | "throw" | "reject", seen: [] as string[] };
let loadThrows = false;

const auth = createAuth<User>({
  load: (id) => {
    if (loadThrows) throw new Error("db down");
    return users.get(id) as User | undefined;
  },
  roles: (u) => u.roles,
  loginPath: "/login",
  onLogin(user, s) {
    hooks.seen.push(`login:${user.name}:${String(s.get("guest" as never) ?? "")}`);
    if (hooks.login === "throw") throw new Error("onLogin failed");
    if (hooks.login === "reject") return Promise.reject(new Error("onLogin rejected"));
    if (hooks.login === "async") return Promise.resolve().then(() => s.set("welcomed" as never, true as never));
  },
  onLogout(user) {
    hooks.seen.push(`logout:${user?.name ?? "nobody"}`);
    if (hooks.logout === "throw") throw new Error("onLogout failed");
    if (hooks.logout === "reject") return Promise.reject(new Error("onLogout rejected"));
  },
});

const admins = createAuth<User>({ load: (id) => users.get(id) ?? undefined, sessionKey: "admin_uid", loginPath: "/admin/login?from=guard" });

@route("/login")
class Login {
  @query("as") accessor as: string | undefined;
  @post go() {
    const done = auth.login(users.get(this.as!)!);
    return done ? done.then(() => 204) : 204;
  }
}

@route("/admin-login")
class AdminLogin {
  @query("as") accessor as: string | undefined;
  @post go() {
    admins.login(users.get(this.as!)!);
    return 204;
  }
}

@route("/logout")
class Logout {
  @post go() {
    const done = auth.logout();
    return done ? done.then(() => 204) : 204;
  }
}

@route("/set")
class SetValue {
  @session accessor session!: Session;
  @query("k") accessor k: string | undefined;
  @query("v") accessor v: string | undefined;
  @post go() {
    this.session.set(this.k as never, this.v as never);
    return 204;
  }
}

@route("/me")
class Me {
  @session accessor session!: Session;
  @auth.maybeUser accessor me: User | undefined;
  @admins.maybeUser accessor admin: User | undefined;
  @get show() {
    const s = this.session as unknown as { get(k: string): unknown };
    return {
      user: this.me?.name ?? null,
      admin: this.admin?.name ?? null,
      guest: s.get("guest") ?? null,
      mfa: s.get("mfa") ?? null,
      welcomed: s.get("welcomed") ?? null,
      uid: s.get("__yerd_uid") ?? null,
    };
  }
}

@route("/account", { guards: [auth.required] })
class Account {
  @auth.user accessor me!: User;
  @get show() {
    return { hello: this.me.name };
  }
}

@route("/strict")
class Strict {
  @auth.user accessor me!: User;
  @get show() {
    return { hello: this.me.name };
  }
}

@route("/editors", { guards: [auth.role("editor", "admin")] })
class Editors {
  @get show() {
    return "editors";
  }
}

@route("/no-role", { guards: [auth.role("nobody-has-this")] })
class NoRole {
  @get show() {
    return "never";
  }
}

@route("/console", { guards: [admins.required] })
class Console {
  @get show() {
    return "console";
  }
}

@route("/current")
class Current {
  @get show() {
    return { current: auth.current()?.name ?? null };
  }
}

function client(base: string) {
  let jar = "";
  const sets: string[] = [];
  const c = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(base + path, { redirect: "manual", ...init, headers: { cookie: jar, ...(init.headers as object) } });
    for (const line of r.headers.getSetCookie()) {
      sets.push(line);
      jar = /Max-Age=0/.test(line) ? "" : line.split(";")[0]!;
    }
    return r;
  };
  // defineProperty, not Object.assign: assign would copy the getter's value once.
  Object.defineProperty(c, "jar", { get: () => jar, set: (v: string) => void (jar = v) });
  return Object.assign(c as typeof c & { jar: string }, {
    sets,
    login: (as: string) => c(`/login?as=${as}`, { method: "POST" }),
    logout: () => c("/logout", { method: "POST" }),
    set: (k: string, v: string) => c(`/set?k=${k}&v=${v}`, { method: "POST" }),
    me: async () => (await c("/me")).json() as Promise<Record<string, unknown>>,
  });
}

function resetHooks() {
  hooks.login = "ok";
  hooks.logout = "ok";
  hooks.seen.length = 0;
  loadThrows = false;
}

const routes = [Login, AdminLogin, Logout, SetValue, Me, Account, Strict, Editors, NoRole, Console, Current];

describe.each<[string, () => SessionStore | undefined]>([
  ["cookie store", () => undefined],
  ["memory store", () => new MemoryStore()],
])("sign-in and sign-out (%s)", (_label, makeStore) => {
  let server: RunningServer;
  beforeAll(async () => {
    const store = makeStore();
    server = await yerd({ routes, services: [], handleSignals: false, secret: "u".repeat(32) })
      .sessions(store ? { store } : {})
      .use(auth)
      .use(admins)
      .listen(0, "127.0.0.1");
  });
  afterAll(() => server.close());

  // An app that seal()s something the client chose must not be minting
  // session cookies: seal() and the session cookie use different keys.
  it("a seal() value shaped like a session cookie doesn't sign anyone in", async () => {
    const now = Date.now();
    const forged = seal(["u".repeat(32)], { e: 9e15, s: now, r: { data: { __yerd_uid: "1" }, flash: {}, createdAt: now }, i: "x" });
    const r = await fetch(server.url + "/account", { headers: { cookie: `yerd_session=${forged}`, accept: "application/json" } });
    expect(r.status).toBe(401);
  });

  it("a session cookie doesn't open with unseal()", async () => {
    const c = client(server.url);
    await c.login("1");
    expect((await c.me()).user).toBe("ada");
    expect(unseal(["u".repeat(32)], decodeURIComponent(c.jar.split("=")[1]!))).toBeUndefined();
  });

  it("a session planted before login doesn't become the user's (fixation)", async () => {
    resetHooks();
    const attacker = client(server.url);
    await attacker.set("guest", "planted");
    const planted = attacker.jar;
    // The victim's browser carries the attacker's cookie, then signs in.
    const victim = client(server.url);
    victim.jar = planted;
    await victim.login("1");
    expect(victim.jar).not.toBe(planted);
    expect((await victim.me()).user).toBe("ada");
    // The attacker's copy is still anonymous.
    expect((await attacker.me()).user).toBeNull();
  });

  it("carries a guest's data into the sign-in, and onLogin sees it", async () => {
    resetHooks();
    const c = client(server.url);
    await c.set("guest", "cart");
    await c.login("1");
    expect(await c.me()).toMatchObject({ user: "ada", guest: "cart" });
    expect(hooks.seen).toEqual(["login:ada:cart"]);
  });

  it("signing in as someone else starts over: nothing of the previous user's carries over", async () => {
    resetHooks();
    const c = client(server.url);
    await c.login("1");
    await c.set("mfa", "verified-for-ada");
    await c.set("guest", "ada-cart");
    await c.login("2");
    expect(await c.me()).toMatchObject({ user: "bob", mfa: null, guest: null });
    expect(hooks.seen).toEqual(["login:ada:", "login:bob:"]);
  });

  it("signing in again as the same user keeps the session's data", async () => {
    resetHooks();
    const c = client(server.url);
    await c.login("1");
    await c.set("mfa", "yes");
    await c.login("1");
    expect(await c.me()).toMatchObject({ user: "ada", mfa: "yes" });
  });

  it("an admin sign-in alongside a user sign-in keeps both (distinct keys)", async () => {
    resetHooks();
    const c = client(server.url);
    await c.login("2");
    await c("/admin-login?as=1", { method: "POST" });
    expect(await c.me()).toMatchObject({ user: "bob", admin: "ada" });
    expect(await (await c("/console")).text()).toBe("console");
    // Signing in on one auth doesn't count for the other.
    const d = client(server.url);
    await d.login("1");
    const r = await d("/console", { headers: { accept: "text/html" } });
    expect(r.status).toBe(303);
  });

  it("logout destroys the session (both sign-ins) and clears the cookie", async () => {
    resetHooks();
    const c = client(server.url);
    await c.login("2");
    await c("/admin-login?as=1", { method: "POST" });
    c.sets.length = 0;
    await c.logout();
    expect(c.sets).toHaveLength(1);
    expect(c.sets[0]).toMatch(/Max-Age=0/);
    expect(await c.me()).toMatchObject({ user: null, admin: null });
    expect(hooks.seen).toEqual(["login:bob:", "logout:bob"]);
  });

  it("logout with nobody signed in tells onLogout so, and sends no cookie to a visitor without one", async () => {
    resetHooks();
    const c = client(server.url);
    await c.logout();
    expect(hooks.seen).toEqual(["logout:nobody"]);
    expect(c.sets).toEqual([]);
  });

  it("an onLogin that throws or rejects leaves nobody signed in", async () => {
    for (const mode of ["throw", "reject"] as const) {
      resetHooks();
      hooks.login = mode;
      const c = client(server.url);
      await c.set("guest", "keep");
      const r = await c.login("1");
      expect(r.status).toBe(500);
      expect(await c.me()).toMatchObject({ user: null, guest: "keep" });
    }
  });

  it("an async onLogin's changes are saved when awaited", async () => {
    resetHooks();
    hooks.login = "async";
    const c = client(server.url);
    await c.login("1");
    expect(await c.me()).toMatchObject({ user: "ada", welcomed: true });
  });

  it("an onLogout that throws or rejects is a 500 and the user stays signed in (nothing commits)", async () => {
    for (const mode of ["throw", "reject"] as const) {
      resetHooks();
      const c = client(server.url);
      await c.login("1");
      hooks.logout = mode;
      expect((await c.logout()).status).toBe(500);
      hooks.logout = "ok";
      expect((await c.me()).user).toBe("ada");
    }
  });

  it("a deleted user is signed out, and the stale id is dropped from the session", async () => {
    resetHooks();
    users.set("9", { id: "9", name: "temp", roles: [] });
    const c = client(server.url);
    await c.login("9");
    expect((await c.me()).user).toBe("temp");
    users.delete("9");
    const first = await c.me();
    expect(first).toMatchObject({ user: null, uid: null });
    // Dropped for good: back again, the id is no longer in the session.
    users.set("9", { id: "9", name: "temp", roles: [] });
    expect((await c.me()).user).toBeNull();
    users.delete("9");
  });

  it("a load() that returns null counts as a deleted user", async () => {
    resetHooks();
    users.set("8", { id: "8", name: "nul", roles: [] });
    const c = client(server.url);
    await c.login("8");
    users.set("8", null);
    expect((await c.me()).user).toBeNull();
    users.delete("8");
  });

  it("a load() that throws is a 500 and changes nothing", async () => {
    resetHooks();
    const c = client(server.url);
    await c.login("1");
    const jar = c.jar;
    loadThrows = true;
    expect((await c("/me")).status).toBe(500);
    loadThrows = false;
    expect(c.jar).toBe(jar);
    expect((await c.me()).user).toBe("ada");
  });
});

describe("guards for every kind of client", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await yerd({ routes, services: [], handleSignals: false, secret: "u".repeat(32) })
      .sessions()
      .use(auth)
      .use(admins)
      .listen(0, "127.0.0.1");
  });
  afterAll(() => server.close());

  it.each<[string, Record<string, string>, number, string | null]>([
    ["a browser", { accept: "text/html,application/xhtml+xml,*/*;q=0.8" }, 303, "/login?next=%2Faccount%3Fx%3D1"],
    ["the runtime (yx, accepts HTML)", { accept: "text/html", yx: "1" }, 200, null],
    ["a JSON API client", { accept: "application/json" }, 401, null],
    ["no Accept at all (curl)", {}, 401, null],
    ["*/* only", { accept: "*/*" }, 401, null],
  ])("signed out, %s", async (_label, headers, status, location) => {
    const r = await fetch(server.url + "/account?x=1", { redirect: "manual", headers });
    expect(r.status).toBe(status);
    expect(r.headers.get("location")).toBe(location);
    if (headers.yx) expect(r.headers.get("yx-location")).toBe("/login?next=%2Faccount%3Fx%3D1");
  });

  it("a loginPath with its own query string gets next= appended with &", async () => {
    const r = await fetch(server.url + "/console", { redirect: "manual", headers: { accept: "text/html" } });
    expect(r.headers.get("location")).toBe("/admin/login?from=guard&next=%2Fconsole");
  });

  it("encodes everything in next=, so the path can't break out of the parameter", async () => {
    const r = await fetch(server.url + "/account?a=1&next=//evil.com#frag", { redirect: "manual", headers: { accept: "text/html" } });
    const location = r.headers.get("location")!;
    const url = new URL(location, "http://x");
    expect([...url.searchParams.keys()]).toEqual(["next"]);
    expect(url.searchParams.get("next")).toBe("/account?a=1&next=//evil.com");
  });

  it("@auth.user without a guard is a 401 for anyone signed out", async () => {
    expect((await fetch(server.url + "/strict", { headers: { accept: "text/html" } })).status).toBe(401);
  });

  it.each<[string, string | null, number]>([
    ["signed out (as required: login)", null, 303],
    ["a user without the role", "3", 403],
    ["a user with one of the roles", "2", 200],
    ["a user with the other role", "1", 200],
  ])("auth.role: %s", async (_label, who, status) => {
    const c = client(server.url);
    if (who) await c.login(who);
    const r = await c("/editors", { headers: { accept: "text/html" } });
    expect(r.status).toBe(status);
  });

  it("auth.role for a role nobody has is a 403 even for an admin", async () => {
    const c = client(server.url);
    await c.login("1");
    expect((await c("/no-role")).status).toBe(403);
  });

  it("auth.current() works in a handler and is undefined outside a request", async () => {
    const c = client(server.url);
    await c.login("2");
    expect(await (await c("/current")).json()).toEqual({ current: "bob" });
    expect(auth.current()).toBeUndefined();
  });

  it("a tampered session cookie is just signed out", async () => {
    const c = client(server.url);
    await c.login("1");
    const [name, value] = c.jar.split("=") as [string, string];
    const flipped = value.slice(0, 10) + (value[10] === "A" ? "B" : "A") + value.slice(11);
    const r = await fetch(server.url + "/account", { redirect: "manual", headers: { cookie: `${name}=${flipped}`, accept: "application/json" } });
    expect(r.status).toBe(401);
  });
});

describe("hashPassword / verifyPassword", () => {
  let hash: string;
  beforeAll(async () => {
    hash = await hashPassword("correct horse");
  });

  it.each<[string, string, boolean]>([
    ["the right password", "correct horse", true],
    ["a different case", "Correct horse", false],
    ["a trailing space", "correct horse ", false],
    ["a leading space", " correct horse", false],
    ["a prefix", "correct hors", false],
    ["empty", "", false],
    ["with a NUL appended", "correct horse\u0000", false],
  ])("%s", async (_label, password, ok) => {
    expect(await verifyPassword(password, hash)).toBe(ok);
  });

  it("salts: the same password hashes differently each time", async () => {
    const again = await hashPassword("correct horse");
    expect(again).not.toBe(hash);
    expect(await verifyPassword("correct horse", again)).toBe(true);
  });

  it("an empty password can be hashed and checked", async () => {
    const empty = await hashPassword("");
    expect(await verifyPassword("", empty)).toBe(true);
    expect(await verifyPassword(" ", empty)).toBe(false);
  });

  it("unicode is compared byte for byte: composed and decomposed forms differ", async () => {
    const composed = await hashPassword("café \u{1f600}");
    expect(await verifyPassword("café \u{1f600}", composed)).toBe(true);
    expect(await verifyPassword("café \u{1f600}", composed)).toBe(false);
  });

  it("long passwords aren't truncated (no 72-byte limit)", async () => {
    const long = "x".repeat(10_000);
    const h = await hashPassword(long);
    expect(await verifyPassword(long, h)).toBe(true);
    expect(await verifyPassword(long.slice(0, -1), h)).toBe(false);
    expect(await verifyPassword(long + "x", h)).toBe(false);
    const at72 = "y".repeat(72);
    const h72 = await hashPassword(at72 + "A");
    expect(await verifyPassword(at72 + "B", h72)).toBe(false);
  });

  it("an unknown user is always false, even with the dummy password", async () => {
    expect(await verifyPassword("yerd-dummy-password", undefined)).toBe(false);
    expect(await verifyPassword("", undefined)).toBe(false);
  });

  it("a changed salt or hash part fails", async () => {
    const parts = hash.split("$");
    const salt = parts[4]!;
    const otherSalt = (salt[0] === "A" ? "B" : "A") + salt.slice(1);
    expect(await verifyPassword("correct horse", [...parts.slice(0, 4), otherSalt, parts[5]].join("$"))).toBe(false);
    const digest = parts[5]!;
    const otherDigest = digest.slice(0, -2) + (digest.at(-2) === "A" ? "B" : "A") + digest.at(-1);
    expect(await verifyPassword("correct horse", [...parts.slice(0, 5), otherDigest].join("$"))).toBe(false);
  });

  it("a truncated stored hash fails rather than matching a shorter tag", async () => {
    const parts = hash.split("$");
    const short = [...parts.slice(0, 5), parts[5]!.slice(0, 22)].join("$");
    expect(await verifyPassword("correct horse", short)).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["garbage", "not a hash"],
    ["argon2i, not argon2id", "$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g"],
    ["another version", "$argon2id$v=16$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g"],
    ["missing hash", "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ"],
    ["bcrypt", "$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234"],
    ["trailing newline", "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g\n"],
    ["plain text password", "correct horse"],
  ])("refuses a malformed stored hash (%s) with an error, never true", async (_label, stored) => {
    await expect(verifyPassword("correct horse", stored)).rejects.toThrow(/Unrecognized password hash format/);
  });

  it("verifies scrypt hashes (the fallback format)", async () => {
    const salt = Buffer.from("0123456789abcdef");
    const key = await new Promise<Buffer>((resolve, reject) =>
      scrypt("pw", salt, 32, { N: 1024, r: 8, p: 1 }, (error, k) => (error ? reject(error) : resolve(k))),
    );
    const stored = `scrypt$1024$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
    expect(await verifyPassword("pw", stored)).toBe(true);
    expect(await verifyPassword("pW", stored)).toBe(false);
  });

  it("takes about as long for an unknown user as for a wrong password", async () => {
    await verifyPassword("warm", undefined);
    const time = async (fn: () => Promise<unknown>) => {
      const t = performance.now();
      await fn();
      return performance.now() - t;
    };
    const known = await time(() => verifyPassword("wrong", hash));
    const unknown = await time(() => verifyPassword("wrong", undefined));
    expect(unknown).toBeGreaterThan(known / 4);
  });
});
