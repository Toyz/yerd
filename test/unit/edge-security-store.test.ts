// MemoryStore and SessionManager driven directly: clocks, sizes, cookie names and attributes.
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, seal, unseal, yerd, type SessionRecord, type SessionStore } from "@toyz/yerd";
import { SessionManager, checkSessionOptions, type LoadedSession } from "../../src/session/manager.js";
import { DAY, sealFor, unsealFor, type SessionOptions } from "../../src/session/session.js";
import type { Outgoing } from "../../src/respond/coerce.js";

const SECRET = "m".repeat(32);
const T0 = 1_800_000_000_000;

afterEach(() => vi.restoreAllMocks());

function clock(start = T0) {
  let now = start;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  return {
    get now() {
      return now;
    },
    set(t: number) {
      now = t;
    },
    tick(ms: number) {
      now += ms;
    },
  };
}

const record = (data: Record<string, unknown> = {}, createdAt = Date.now()): SessionRecord => ({ data, flash: {}, createdAt });

function req(headers: Record<string, string | string[]> = {}, encrypted = false): IncomingMessage {
  return { headers, socket: { encrypted } } as unknown as IncomingMessage;
}

const out = (): Outgoing => ({ status: 200, headers: {}, body: null });

/** Seal/open the way the session cookie is: its own key, not seal()'s. */
const sealSession = (secrets: readonly string[], value: unknown) => sealFor("session-cookie", secrets, value);
const unsealSession = (secrets: readonly string[], value: string) => unsealFor("session-cookie", secrets, value);

/** Name, value and attributes of a Set-Cookie line. */
function parseSet(line: string) {
  const [pair, ...attrs] = line.split("; ");
  const eq = pair!.indexOf("=");
  return { name: pair!.slice(0, eq), value: decodeURIComponent(pair!.slice(eq + 1)), attrs };
}

/** One request against a manager: load with `cookie`, run `fn`, commit; returns the cookie line (if any). */
async function roundTrip(
  manager: SessionManager,
  cookie: Record<string, string>,
  fn: (s: LoadedSession["session"]) => void | Promise<void>,
  request: IncomingMessage = req(),
) {
  const loaded = await manager.load(request, cookie);
  await fn(loaded.session);
  const o = out();
  await manager.commit(loaded, o);
  return { loaded, cookies: o.cookies ?? [], line: o.cookies?.[0] };
}

function jarOf(line: string | undefined): Record<string, string> {
  if (!line) return {};
  const { name, value, attrs } = parseSet(line);
  return attrs.includes("Max-Age=0") ? {} : { [name]: value };
}

describe("MemoryStore", () => {
  it("returns undefined for unknown ids and forgets destroyed ones", () => {
    const store = new MemoryStore();
    expect(store.get("nope")).toBeUndefined();
    store.set("a", record({ x: 1 }), 1000);
    store.destroy("a");
    store.destroy("never-there");
    expect(store.get("a")).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("copies on the way in and on the way out", () => {
    const store = new MemoryStore();
    const r = record({ list: [1] });
    store.set("a", r, 1000);
    (r.data.list as number[]).push(2);
    const first = store.get("a")!;
    expect(first.data).toEqual({ list: [1] });
    (first.data.list as number[]).push(3);
    expect(store.get("a")!.data).toEqual({ list: [1] });
  });

  it("refuses values structuredClone can't copy", () => {
    const store = new MemoryStore();
    expect(() => store.set("a", record({ fn: () => 1 }), 1000)).toThrow();
  });

  it("keeps a record until its expiry, inclusive, then drops it on read", () => {
    const c = clock();
    const store = new MemoryStore();
    store.set("a", record(), 1000);
    c.tick(1000);
    expect(store.get("a")).toBeDefined();
    c.tick(1);
    expect(store.get("a")).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("evicts the least recently saved past maxSize; reads don't count as use", () => {
    const store = new MemoryStore({ maxSize: 2 });
    store.set("a", record(), 1000);
    store.set("b", record(), 1000);
    expect(store.get("a")).toBeDefined();
    store.set("c", record(), 1000);
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")).toBeDefined();
    // Saving again moves a record to the back of the line.
    store.set("b", record(), 1000);
    store.set("d", record(), 1000);
    expect(store.get("c")).toBeUndefined();
    expect([store.get("b"), store.get("d")].every(Boolean)).toBe(true);
    expect(store.size).toBe(2);
  });

  it("keeps nothing with maxSize 0, one with maxSize 1", () => {
    const none = new MemoryStore({ maxSize: 0 });
    none.set("a", record(), 1000);
    expect(none.size).toBe(0);
    const one = new MemoryStore({ maxSize: 1 });
    one.set("a", record(), 1000);
    one.set("b", record(), 1000);
    expect(one.get("a")).toBeUndefined();
    expect(one.get("b")).toBeDefined();
  });

  it("sweeps expired records on a save once the interval has passed, not before", () => {
    const c = clock();
    const store = new MemoryStore({ sweepInterval: 10_000 });
    store.set("old", record(), 100);
    c.tick(5_000);
    store.set("x", record(), 100_000);
    expect(store.size).toBe(2); // expired but not swept yet
    c.tick(5_000);
    store.set("y", record(), 100_000);
    expect(store.size).toBe(2); // "old" swept
    expect(store.get("old")).toBeUndefined();
  });

  it("sweeps on every save with sweepInterval 0", () => {
    const c = clock();
    const store = new MemoryStore({ sweepInterval: 0 });
    store.set("a", record(), 10);
    store.set("b", record(), 10);
    c.tick(11);
    store.set("c", record(), 10);
    expect(store.size).toBe(1);
  });

  it("keys records by a hash of the id, never the id itself", () => {
    const dev = Symbol.for("yerd.devAssets");
    const globals = globalThis as Record<symbol, unknown>;
    const key = Symbol.for("yerd.memoryStore:edge-hash");
    globals[dev] = {};
    try {
      const store = new MemoryStore({ name: "edge-hash" });
      store.set("secret-session-id", record({ x: 1 }), 1000);
      const shared = globals[key] as Map<string, unknown>;
      expect([...shared.keys()]).toEqual([createHash("sha256").update("secret-session-id").digest("base64url")]);
      expect(JSON.stringify([...shared.keys()])).not.toContain("secret-session-id");
    } finally {
      delete globals[dev];
      delete globals[key];
    }
  });

  it("shares records by name under the dev server only", () => {
    const dev = Symbol.for("yerd.devAssets");
    const globals = globalThis as Record<symbol, unknown>;
    const plain1 = new MemoryStore({ name: "edge-share" });
    plain1.set("a", record({ v: 1 }), 1000);
    expect(new MemoryStore({ name: "edge-share" }).get("a")).toBeUndefined();
    globals[dev] = {};
    try {
      const first = new MemoryStore({ name: "edge-share" });
      first.set("a", record({ v: 2 }), 1000);
      expect(new MemoryStore({ name: "edge-share" }).get("a")?.data).toEqual({ v: 2 });
      expect(new MemoryStore({ name: "edge-other" }).get("a")).toBeUndefined();
    } finally {
      delete globals[dev];
      delete globals[Symbol.for("yerd.memoryStore:edge-share")];
      delete globals[Symbol.for("yerd.memoryStore:edge-other")];
    }
  });
});

describe("SessionManager: Secure and the __Host- prefix", () => {
  const cases: Array<[string, SessionOptions, Record<string, string | string[]>, boolean, boolean]> = [
    ["plain http", {}, {}, false, false],
    ["TLS socket", {}, {}, true, true],
    ["X-Forwarded-Proto without trustProxy", {}, { "x-forwarded-proto": "https" }, false, false],
    ["X-Forwarded-Proto with trustProxy", { trustProxy: true }, { "x-forwarded-proto": "https" }, false, true],
    ["upper-case HTTPS", { trustProxy: true }, { "x-forwarded-proto": "HTTPS" }, false, true],
    ["padded value", { trustProxy: true }, { "x-forwarded-proto": "  https  " }, false, true],
    ["chained, client first https", { trustProxy: true }, { "x-forwarded-proto": "https, http" }, false, true],
    ["chained, client first http", { trustProxy: true }, { "x-forwarded-proto": "http, https" }, false, false],
    ["array value", { trustProxy: true }, { "x-forwarded-proto": ["https", "http"] }, false, true],
    ["empty value", { trustProxy: true }, { "x-forwarded-proto": "" }, false, false],
    ["unrelated value", { trustProxy: true }, { "x-forwarded-proto": "wss" }, false, false],
    ["https-ish prefix", { trustProxy: true }, { "x-forwarded-proto": "httpsx" }, false, false],
    ["trustProxy but header says http over TLS", { trustProxy: true }, { "x-forwarded-proto": "http" }, true, true],
    ["secure: false wins over TLS", { secure: false }, {}, true, false],
    ["secure: true wins over plain http", { secure: true }, {}, false, true],
    ["secure: false wins over trusted https", { secure: false, trustProxy: true }, { "x-forwarded-proto": "https" }, false, false],
  ];

  it.each(cases)("%s", async (_label, options, headers, encrypted, secure) => {
    const manager = new SessionManager(options, [SECRET]);
    const { line } = await roundTrip(manager, {}, (s) => s.set("name" as never, "ada" as never), req(headers, encrypted));
    const { name, attrs } = parseSet(line!);
    expect(name).toBe(secure ? "__Host-yerd_session" : "yerd_session");
    expect(attrs.includes("Secure")).toBe(secure);
  });

  it("reads only the cookie name that matches the connection", async () => {
    const manager = new SessionManager({ trustProxy: true }, [SECRET]);
    const https = req({ "x-forwarded-proto": "https" });
    const { line } = await roundTrip(manager, {}, (s) => s.set("name" as never, "ada" as never), https);
    const value = parseSet(line!).value;
    expect((await manager.load(https, { "__Host-yerd_session": value })).session.get("name" as never)).toBe("ada");
    // Over HTTPS a plain-named cookie (one a sibling subdomain could plant) is never read.
    expect((await manager.load(https, { yerd_session: value })).session.get("name" as never)).toBeUndefined();
    // Over http only the plain name is looked at.
    expect((await manager.load(req(), { "__Host-yerd_session": value })).session.get("name" as never)).toBeUndefined();
  });

  it("writes the attributes a session cookie needs, and no Domain", async () => {
    clock();
    const manager = new SessionManager({ maxAge: 90_500 }, [SECRET]);
    const { line } = await roundTrip(manager, {}, (s) => s.set("name" as never, "ada" as never), req({}, true));
    const { attrs } = parseSet(line!);
    expect(attrs).toEqual(["Max-Age=90", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"]);
  });

  it("uses a custom cookie name, prefixed over HTTPS", async () => {
    const manager = new SessionManager({ cookieName: "sid" }, [SECRET]);
    const plain = await roundTrip(manager, {}, (s) => s.set("name" as never, "x" as never));
    const tls = await roundTrip(manager, {}, (s) => s.set("name" as never, "x" as never), req({}, true));
    expect(parseSet(plain.line!).name).toBe("sid");
    expect(parseSet(tls.line!).name).toBe("__Host-sid");
  });

  it("clears the cookie under the same name and Secure flag it was read with", async () => {
    const manager = new SessionManager({}, [SECRET]);
    const tls = req({}, true);
    const first = await roundTrip(manager, {}, (s) => s.set("name" as never, "x" as never), tls);
    const second = await roundTrip(manager, jarOf(first.line), (s) => s.destroy(), tls);
    const { name, value, attrs } = parseSet(second.line!);
    expect({ name, value }).toEqual({ name: "__Host-yerd_session", value: "" });
    expect(attrs).toContain("Max-Age=0");
    expect(attrs).toContain("Secure");
  });
});

describe("SessionManager: corrupted and foreign cookies", () => {
  const manager = new SessionManager({}, [SECRET]);

  it.each([
    ["garbage", "not-a-session"],
    ["empty", ""],
    ["sealed with another secret", sealSession(["z".repeat(32)], { r: record({ name: "eve" }), e: T0 * 2, s: T0 })],
    ["sealed null", sealSession([SECRET], null)],
    ["sealed number", sealSession([SECRET], 42)],
    ["sealed string", sealSession([SECRET], "hello")],
    ["sealed array", sealSession([SECRET], [1, 2])],
    ["no expiry", sealSession([SECRET], { r: record({ name: "eve" }), s: T0 })],
    ["record missing", sealSession([SECRET], { e: Date.now() + DAY, s: Date.now() })],
    ["an id-store payload under a cookie store", sealSession([SECRET], { i: "some-id", e: Date.now() + DAY, s: Date.now() })],
    ["a non-numeric expiry", sealSession([SECRET], { r: record({ name: "eve" }), e: "soon", s: T0 })],
    ["a record without createdAt", sealSession([SECRET], { r: { data: { name: "eve" }, flash: {} }, e: Date.now() + DAY, s: Date.now() })],
  ])("%s: a fresh session, no crash", async (_label, value) => {
    const loaded = await manager.load(req(), { yerd_session: value });
    expect(loaded.payload).toBeUndefined();
    expect(loaded.session.get("name" as never)).toBeUndefined();
    expect(loaded.session.isNew).toBe(true);
  });

  it("a custom store's record without createdAt counts as expired, not immortal", async () => {
    const store: SessionStore = { kind: "id", get: () => ({ data: { name: "eve" }, flash: {} }) as unknown as SessionRecord, set() {}, destroy() {} };
    const ids = new SessionManager({ store }, [SECRET]);
    const value = sealSession([SECRET], { i: "x", e: Date.now() + DAY, s: Date.now() });
    expect((await ids.load(req(), { yerd_session: value })).payload).toBeUndefined();
  });

  it("a cookie payload under an id store is a fresh session", async () => {
    const ids = new SessionManager({ store: new MemoryStore() }, [SECRET]);
    const value = sealSession([SECRET], { r: record({ name: "eve" }), e: Date.now() + DAY, s: Date.now() });
    const loaded = await ids.load(req(), { yerd_session: value });
    expect(loaded.payload).toBeUndefined();
    expect(loaded.session.get("name" as never)).toBeUndefined();
  });

  it("an id the store doesn't know is a fresh session", async () => {
    const ids = new SessionManager({ store: new MemoryStore() }, [SECRET]);
    const value = sealSession([SECRET], { i: "forgotten", e: Date.now() + DAY, s: Date.now() });
    expect((await ids.load(req(), { yerd_session: value })).payload).toBeUndefined();
  });

  it("opens cookies sealed with a rotated-out secret still listed, and reseals with the new one", async () => {
    const c = clock();
    const old = new SessionManager({}, [SECRET]);
    const first = await roundTrip(old, {}, (s) => s.set("name" as never, "ada" as never));
    const rotated = new SessionManager({}, ["n".repeat(32), SECRET]);
    c.tick(2 * DAY); // past the refresh point: a rolling session is reissued
    const second = await roundTrip(rotated, jarOf(first.line), (s) => expect(s.get("name" as never)).toBe("ada"));
    const value = parseSet(second.line!).value;
    expect(unsealSession(["n".repeat(32)], value)).toBeDefined();
    expect(unsealSession([SECRET], value)).toBeUndefined();
  });

  // The app seals something a client chose (a "remember me" value, a link
  // token) with seal(): that must never pass for a session cookie.
  it("a seal() value shaped like a session cookie is a fresh session, not a sign-in", async () => {
    const forged = seal([SECRET], { e: 9e15, r: { data: { __yerd_uid: "1" }, flash: {}, createdAt: Date.now() }, s: Date.now() });
    const loaded = await manager.load(req(), { yerd_session: forged });
    expect(loaded.payload).toBeUndefined();
    expect(loaded.session.get("__yerd_uid" as never)).toBeUndefined();
    const ids = new SessionManager({ store: new MemoryStore() }, [SECRET]);
    expect((await ids.load(req(), { yerd_session: seal([SECRET], { i: "x", e: 9e15, s: Date.now() }) })).payload).toBeUndefined();
  });

  it("a session cookie doesn't open with unseal()", async () => {
    const { line } = await roundTrip(manager, {}, (s) => s.set("name" as never, "ada" as never));
    const value = parseSet(line!).value;
    expect(unsealSession([SECRET], value)).toBeDefined();
    expect(unseal([SECRET], value)).toBeUndefined();
  });
});

describe("SessionManager: expiry and clocks", () => {
  it("idle expiry: valid at exactly e, gone 1ms later", async () => {
    const c = clock();
    const manager = new SessionManager({ maxAge: 10_000, rolling: false }, [SECRET]);
    const { line } = await roundTrip(manager, {}, (s) => s.set("name" as never, "ada" as never));
    c.tick(10_000);
    expect((await manager.load(req(), jarOf(line))).session.get("name" as never)).toBe("ada");
    c.tick(1);
    expect((await manager.load(req(), jarOf(line))).session.get("name" as never)).toBeUndefined();
  });

  it("absolute expiry wins over rolling refreshes", async () => {
    const c = clock();
    const manager = new SessionManager({ maxAge: 10_000, absoluteMaxAge: 25_000 }, [SECRET]);
    let jar = jarOf((await roundTrip(manager, {}, (s) => s.set("name" as never, "ada" as never))).line);
    const maxAges: string[] = [];
    for (let i = 0; i < 4; i++) {
      c.tick(6_000);
      const { line, loaded } = await roundTrip(manager, jar, () => {});
      if (i < 4 && loaded.payload) expect(loaded.session.get("name" as never)).toBe("ada");
      if (line) {
        jar = jarOf(line);
        maxAges.push(parseSet(line).attrs[0]!);
      }
    }
    // Refreshed at 6s, 12s, 18s, 24s; the last can only run to 25s.
    expect(maxAges).toEqual(["Max-Age=10", "Max-Age=10", "Max-Age=7", "Max-Age=1"]);
    c.tick(1_001);
    expect((await manager.load(req(), jar)).payload).toBeUndefined();
  });

  it("absolute expiry is checked against createdAt in the record, even with a fresh idle expiry", async () => {
    clock();
    const manager = new SessionManager({ absoluteMaxAge: 1000 }, [SECRET]);
    const forged = sealSession([SECRET], { r: record({ name: "ada" }, Date.now() - 1001), e: Date.now() + DAY, s: Date.now() });
    expect((await manager.load(req(), { yerd_session: forged })).payload).toBeUndefined();
    const edge = sealSession([SECRET], { r: record({ name: "ada" }, Date.now() - 1000), e: Date.now() + DAY, s: Date.now() });
    expect((await manager.load(req(), { yerd_session: edge })).session.get("name" as never)).toBe("ada");
  });

  it("rolling refresh happens only after a tenth of maxAge has passed", async () => {
    const c = clock();
    const manager = new SessionManager({ maxAge: 100_000 }, [SECRET]);
    const jar = jarOf((await roundTrip(manager, {}, (s) => s.set("name" as never, "ada" as never))).line);
    c.tick(10_000);
    expect((await roundTrip(manager, jar, () => {})).line).toBeUndefined();
    c.tick(1);
    expect((await roundTrip(manager, jar, () => {})).line).toBeDefined();
  });

  it("rolling: false never reissues an untouched session", async () => {
    const c = clock();
    const manager = new SessionManager({ maxAge: 100_000, rolling: false }, [SECRET]);
    const jar = jarOf((await roundTrip(manager, {}, (s) => s.set("name" as never, "ada" as never))).line);
    c.tick(90_000);
    expect((await roundTrip(manager, jar, () => {})).line).toBeUndefined();
  });

  it("a clock that went backwards doesn't lose the session", async () => {
    const c = clock();
    const manager = new SessionManager({ maxAge: 100_000 }, [SECRET]);
    const jar = jarOf((await roundTrip(manager, {}, (s) => s.set("name" as never, "ada" as never))).line);
    c.tick(-50_000);
    expect((await manager.load(req(), jar)).session.get("name" as never)).toBe("ada");
  });

  it("an id store's record expires with the cookie", async () => {
    const c = clock();
    const store = new MemoryStore();
    const manager = new SessionManager({ store, maxAge: 1000, rolling: false }, [SECRET]);
    const { line, loaded } = await roundTrip(manager, {}, (s) => s.set("name" as never, "ada" as never));
    c.tick(1001);
    expect(store.get(loaded.session.id!)).toBeUndefined();
    expect((await manager.load(req(), jarOf(line))).payload).toBeUndefined();
  });
});

describe("SessionManager: the cookie size limit", () => {
  // Fixed clock, so the payload's timestamps (and so its length) are the same every run.
  async function sealedLength(n: number) {
    clock();
    const manager = new SessionManager({}, [SECRET]);
    try {
      const { line } = await roundTrip(manager, {}, (s) => s.set("name" as never, "x".repeat(n) as never));
      return parseSet(line!).value.length;
    } catch (error) {
      return error as Error;
    }
  }

  it("allows exactly 4000 sealed characters and refuses 4001+", async () => {
    // Find the largest value that still fits.
    let lo = 0;
    let hi = 4000;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (typeof (await sealedLength(mid)) === "number") lo = mid;
      else hi = mid - 1;
    }
    expect(await sealedLength(lo)).toBe(4000);
    const over = await sealedLength(lo + 1);
    expect(over).toBeInstanceOf(Error);
    expect((over as Error).message).toMatch(/too big for a cookie \(4002 bytes\); use MemoryStore/);
  });

  // Question: the 4000 limit counts only the value. Browsers cap name + value
  // at 4096, so a long cookieName (100+ characters) lets a value pass the
  // check that the browser then silently drops.
  it.todo("counts the cookie name toward the size limit");

  it("a big session is fine in a MemoryStore: the cookie only holds an id", async () => {
    const manager = new SessionManager({ store: new MemoryStore() }, [SECRET]);
    const { line } = await roundTrip(manager, {}, (s) => s.set("name" as never, "x".repeat(100_000) as never));
    expect(parseSet(line!).value.length).toBeLessThan(400);
  });

  it("multi-byte characters count by what they seal to", async () => {
    clock();
    const manager = new SessionManager({}, [SECRET]);
    // 1000 emoji: 4 bytes each in UTF-8, but JSON keeps them as is.
    await expect(roundTrip(manager, {}, (s) => s.set("name" as never, "\u{1f600}".repeat(1000) as never))).rejects.toThrow(/too big/);
    await expect(roundTrip(manager, {}, (s) => s.set("name" as never, "\u{1f600}".repeat(500) as never))).resolves.toBeDefined();
  });
});

describe("SessionManager: ids and generateId", () => {
  it("refuses generateId with a cookie store, at the sessions() call", () => {
    expect(() => yerd({ handleSignals: false }).sessions({ generateId: () => "x" })).toThrow(/needs a store that keeps ids/);
    expect(() => checkSessionOptions({ generateId: () => "x" })).toThrow(TypeError);
    expect(() => checkSessionOptions({ generateId: () => "x", store: new MemoryStore() })).not.toThrow();
  });

  it.each(["bad name", "semi;colon", "", "eq=ual", "café"])("refuses cookieName %j up front, not on the first write", (cookieName) => {
    expect(() => checkSessionOptions({ cookieName })).toThrow(/Invalid cookie name/);
    expect(() => yerd({ handleSignals: false }).sessions({ cookieName })).toThrow(/Invalid cookie name/);
  });

  // Question: a generateId that repeats another live session's id makes the
  // two visitors share one record (set() overwrites it). The docs say ids must
  // be unique; checking would cost a store read per new session.
  it.todo("refuses (or retries) a generated id that already names another live session");

  it("uses an async generateId", async () => {
    const store = new MemoryStore();
    const manager = new SessionManager({ store, generateId: async () => "sess_1" }, [SECRET]);
    const { loaded } = await roundTrip(manager, {}, (s) => s.set("name" as never, "ada" as never));
    expect(loaded.session.id).toBe("sess_1");
    expect(store.get("sess_1")?.data).toEqual({ name: "ada" });
  });

  it.each<[string, () => unknown]>([
    ["an empty string", () => ""],
    ["a number", () => 42],
    ["undefined", () => undefined],
    ["a promise of null", async () => null],
  ])("refuses an id that is %s", async (_label, generateId) => {
    const manager = new SessionManager({ store: new MemoryStore(), generateId: generateId as () => string }, [SECRET]);
    await expect(roundTrip(manager, {}, (s) => s.set("name" as never, "ada" as never))).rejects.toThrow(/must return a non-empty string/);
  });

  it("refuses the old id on regenerate, and lets a throwing generateId's error through", async () => {
    const store = new MemoryStore();
    const manager = new SessionManager({ store, generateId: () => "same" }, [SECRET]);
    const first = await roundTrip(manager, {}, (s) => s.set("name" as never, "ada" as never));
    await expect(roundTrip(manager, jarOf(first.line), (s) => s.regenerate())).rejects.toThrow(/old id on regenerate/);
    const broken = new SessionManager({ store, generateId: () => { throw new Error("db down"); } }, [SECRET]);
    await expect(roundTrip(broken, {}, (s) => s.set("name" as never, "ada" as never))).rejects.toThrow("db down");
  });

  it("calls generateId only for new and regenerated sessions", async () => {
    let n = 0;
    const manager = new SessionManager({ store: new MemoryStore(), generateId: () => `id${++n}` }, [SECRET]);
    const first = await roundTrip(manager, {}, (s) => s.set("name" as never, "a" as never));
    await roundTrip(manager, jarOf(first.line), (s) => s.set("name" as never, "b" as never));
    expect(n).toBe(1);
    const third = await roundTrip(manager, jarOf(first.line), (s) => s.regenerate());
    expect(n).toBe(2);
    expect(third.loaded.session.id).toBe("id2");
  });

  it("regenerate drops the old record from the store; the old cookie no longer loads", async () => {
    const store = new MemoryStore();
    const manager = new SessionManager({ store }, [SECRET]);
    const first = await roundTrip(manager, {}, (s) => s.set("name" as never, "ada" as never));
    const oldId = first.loaded.session.id!;
    const second = await roundTrip(manager, jarOf(first.line), (s) => s.regenerate());
    expect(second.loaded.session.id).not.toBe(oldId);
    expect(store.get(oldId)).toBeUndefined();
    expect((await manager.load(req(), jarOf(first.line))).payload).toBeUndefined();
    expect((await manager.load(req(), jarOf(second.line))).session.get("name" as never)).toBe("ada");
  });

  it("destroy drops the record and clears the cookie; a request without a cookie sends none", async () => {
    const store = new MemoryStore();
    const manager = new SessionManager({ store }, [SECRET]);
    const first = await roundTrip(manager, {}, (s) => s.set("name" as never, "ada" as never));
    const id = first.loaded.session.id!;
    const second = await roundTrip(manager, jarOf(first.line), (s) => s.destroy());
    expect(store.get(id)).toBeUndefined();
    expect(parseSet(second.line!).attrs).toContain("Max-Age=0");
    expect((await roundTrip(manager, {}, (s) => s.destroy())).cookies).toEqual([]);
  });

  it("works with an async custom store", async () => {
    const records = new Map<string, SessionRecord>();
    const store: SessionStore = {
      kind: "id",
      get: async (id) => records.get(id),
      set: async (id, r) => void records.set(id, structuredClone(r)),
      destroy: async (id) => void records.delete(id),
    };
    const manager = new SessionManager({ store }, [SECRET]);
    const first = await roundTrip(manager, {}, (s) => s.set("name" as never, "ada" as never));
    const second = await roundTrip(manager, jarOf(first.line), (s) => expect(s.get("name" as never)).toBe("ada"));
    expect(second.line).toBeUndefined();
    expect(records.size).toBe(1);
  });
});
