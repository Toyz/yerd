// The CSRF nonce: minted when a session is first written, never by a form. Visitors without a
// session get unbound tokens and no cookie, however the page streams.
import { describe, expect, it } from "vitest";
import { MemoryStore, action, currentContext, get, post, route, session, yerd, type Child, type Session } from "@toyz/yerd";
import { createAuth } from "@toyz/yerd/auth";
import { csrfTag, verifyAction } from "../../src/actions/action.js";
import { sealFor, unsealFor, type SessionRecord } from "../../src/session/session.js";

const SECRET = "n".repeat(32);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hits: string[] = [];

const auth = createAuth<{ id: string }>({ load: (id) => ({ id }), sessionKey: "nonce_uid" });

async function Soon() {
  await Promise.resolve();
  return <p>soon</p>;
}

async function Slow({ children }: { children?: Child }) {
  await sleep(10);
  return <section>{children}</section>;
}

@route("/form")
class FormPage {
  @get page() {
    return <main><form action={this.go}><button>go</button></form></main>;
  }
  @action go() {
    hits.push("form");
  }
}

@route("/late-form")
class LateForm {
  @get page() {
    return <main><h1>top</h1><Slow><form action={this.go}><button>go</button></form></Slow></main>;
  }
  @action go() {
    hits.push("late-form");
  }
}

@route("/soon-form")
class SoonForm {
  @get page() {
    return <main><Soon /><button action={this.go}>go</button></main>;
  }
  @action go() {
    hits.push("soon-form");
  }
}

@route("/cart")
class Cart {
  @session accessor session!: Session<{ cart?: string[] }>;
  @get page() {
    return <main><p>{(this.session.cart ?? []).length} items</p><button action={this.add}>add</button></main>;
  }
  /** Writes the session, then answers with a form rendered in the same request. */
  @action add() {
    (this.session.cart ??= []).push("socks");
    return <button action={this.add}>add another</button>;
  }
}

@route("/login")
class Login {
  @get page() {
    return <form action={this.signIn}><button>sign in</button></form>;
  }
  @action signIn() {
    auth.login({ id: "ada" });
    return "signed in";
  }
}

@route("/whoami")
class WhoAmI {
  @get show() {
    return { user: auth.current()?.id ?? null, nonce: typeof currentContext().session.get("__yerd_csrf") };
  }
  @post touch() {
    return { name: currentContext().session.get("name" as never) ?? null };
  }
}

function app(store?: MemoryStore) {
  return yerd({ routes: [FormPage, LateForm, SoonForm, Cart, Login, WhoAmI], services: [], handleSignals: false, secret: SECRET })
    .sessions(store ? { store } : {})
    .use(auth)
    .errorPage(({ status }) => <p>error {status}</p>);
}

const html = { headers: { accept: "text/html" } };
const tokenIn = (page: string, index = 0) =>
  [...page.matchAll(/name="_yx" value="([^"]+)"|data-yx-token="([^"]+)"/g)].map((m) => (m[1] ?? m[2])!.replace(/&amp;/g, "&").replace(/&quot;/g, '"'))[index]!;
const payloadOf = (token: string) => verifyAction([SECRET], token);
const post_ = (token: string, extra: Record<string, string> = {}) => ({ method: "POST", body: new URLSearchParams({ _yx: token }), headers: { yx: "1", ...extra } });

describe("a visitor with no session", () => {
  it.each(["/form", "/soon-form", "/late-form"])("gets no cookie, no store entry and no Cache-Control from %s", async (path) => {
    const store = new MemoryStore();
    const r = await app(store).request(path, html);
    expect(tokenIn(await r.text())).toBeDefined();
    expect(r.headers.getSetCookie()).toEqual([]);
    expect(r.headers.get("cache-control")).toBeNull();
    expect(store.size).toBe(0);
  });

  it("gets no cookie when the form renders after the headers went out (an async component still pending)", async () => {
    const store = new MemoryStore();
    const r = await app(store).request("/late-form", html);
    // The headers are in hand before the slow part of the page has rendered.
    expect(r.headers.getSetCookie()).toEqual([]);
    const body = await r.text();
    expect(payloadOf(tokenIn(body)).s).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it.each(["/form", "/soon-form", "/late-form"])("can use the unbound token from %s, still without a cookie", async (path) => {
    const store = new MemoryStore();
    const client = app(store).client();
    hits.length = 0;
    const r = await client.action(path);
    expect(r.status).toBe(204);
    expect(hits).toEqual([path.slice(1)]);
    expect(r.headers.getSetCookie()).toEqual([]);
    expect(store.size).toBe(0);
    // Plain form posts (no script) too.
    expect((await client.action(path, {}, { script: false })).status).toBe(303);
  });

  it("is refused for a token bound to someone's session", async () => {
    const yerdApp = app();
    const owner = yerdApp.client();
    await owner.action("/cart");
    const bound = tokenIn(await owner.page("/cart"));
    expect(payloadOf(bound).s).toBeDefined();
    const r = await yerdApp.request("/cart", post_(bound));
    expect(r.status).toBe(403);
    expect(r.headers.get("yx-stale")).toBe("1");
  });

  it("whose action writes the session gets a nonce at once: a form in the answer is bound and works", async () => {
    const store = new MemoryStore();
    const client = app(store).client();
    const first = await client.action("/cart");
    expect(first.status).toBe(200);
    expect(first.headers.getSetCookie()).toHaveLength(1);
    const again = tokenIn(await first.text());
    expect(payloadOf(again).s).toBeDefined();
    const second = await client.request("/cart", post_(again));
    expect(second.status).toBe(200);
    expect(await client.page("/cart")).toContain("2 items");
  });
});

describe("a visitor with a session", () => {
  it("gets bound tokens, and an unbound token from before the session is refused (stale)", async () => {
    const client = app(new MemoryStore()).client();
    const unbound = tokenIn(await client.page("/cart"));
    expect(payloadOf(unbound).s).toBeUndefined();
    await client.request("/cart", post_(unbound)); // starts the session
    const page = await client.request("/cart", html);
    expect(page.headers.get("cache-control")).toBe("private, no-cache");
    const bound = tokenIn(await page.text());
    expect(payloadOf(bound).s).toMatch(/^[\w-]{22}$/);
    const stale = await client.request("/cart", post_(unbound));
    expect(stale.status).toBe(403);
    expect(stale.headers.get("yx-stale")).toBe("1");
    expect((await client.request("/cart", post_(bound))).status).toBe(200);
  });

  it("is refused a token bound to another session", async () => {
    const yerdApp = app();
    const alice = yerdApp.client();
    const mallory = yerdApp.client();
    await alice.action("/cart");
    await mallory.action("/cart");
    const stolen = tokenIn(await mallory.page("/cart"));
    const r = await alice.request("/cart", post_(stolen));
    expect(r.status).toBe(403);
    expect(r.headers.get("yx-stale")).toBe("1");
    expect(await r.text()).toMatch(/different session/);
  });

  it("is refused a token tagged for a nonce it can't know", async () => {
    const yerdApp = app();
    const client = yerdApp.client();
    await client.action("/cart");
    const payload = payloadOf(tokenIn(await client.page("/cart")));
    const { signAction } = await import("../../src/actions/action.js");
    const forged = signAction(SECRET, { ...payload, s: csrfTag("guess") });
    expect((await client.request("/cart", post_(forged))).status).toBe(403);
  });
});

describe("signing in", () => {
  it("works from an unbound token, and the new session has a nonce", async () => {
    const store = new MemoryStore();
    const client = app(store).client();
    const loginToken = tokenIn(await client.page("/login"));
    expect(payloadOf(loginToken).s).toBeUndefined();
    const r = await client.request("/login", post_(loginToken));
    expect(await r.text()).toBe("signed in");
    expect(r.headers.getSetCookie()).toHaveLength(1);
    expect(store.size).toBe(1);
    expect(await (await client.request("/whoami")).json()).toEqual({ user: "ada", nonce: "string" });
    // Pages from before signing in go stale; new ones are bound and work.
    const old = await client.request("/login", post_(loginToken));
    expect(old.status).toBe(403);
    expect(old.headers.get("yx-stale")).toBe("1");
    const fresh = tokenIn(await client.page("/login"));
    expect(payloadOf(fresh).s).toBeDefined();
    expect(await (await client.request("/login", post_(fresh))).text()).toBe("signed in");
  });

  it("gives a guest who had a session a new nonce: the guest's forms go stale", async () => {
    const client = app(new MemoryStore()).client();
    await client.action("/cart");
    const guest = tokenIn(await client.page("/cart"));
    const loginToken = tokenIn(await client.page("/login"));
    expect(await (await client.request("/login", post_(loginToken))).text()).toBe("signed in");
    const r = await client.request("/cart", post_(guest));
    expect(r.status).toBe(403);
    expect(r.headers.get("yx-stale")).toBe("1");
    // The guest's cart carried over.
    expect(await client.page("/cart")).toContain("1 items");
  });
});

describe("a session saved without a nonce (older yerd)", () => {
  const now = () => Date.now();
  const legacyRecord = (): SessionRecord => ({ data: { name: "ada" }, flash: {}, createdAt: now() });
  const legacyPayload = (extra: Record<string, unknown>) => ({ e: now() + 60_000, s: now(), ...extra });

  it("gets one the next time it's used and saved (cookie store)", async () => {
    const yerdApp = app();
    const cookie = `yerd_session=${sealFor("session-cookie", [SECRET], legacyPayload({ r: legacyRecord() }))}`;
    // Until then the visitor counts as having no session for tokens: an unbound one works.
    const unbound = tokenIn(await (await yerdApp.request("/form", { headers: { ...html.headers, cookie } })).text());
    expect(payloadOf(unbound).s).toBeUndefined();
    const r = await yerdApp.request("/whoami", { method: "POST", headers: { cookie } });
    expect(await r.json()).toEqual({ name: "ada" });
    const [line] = r.headers.getSetCookie();
    expect(line).toBeDefined();
    const reissued = unsealFor<{ r: SessionRecord }>("session-cookie", [SECRET], decodeURIComponent(line!.split(";")[0]!.split("=")[1]!))!;
    expect(reissued.r.data).toEqual({ name: "ada", __yerd_csrf: expect.any(String) });
  });

  it("gets one the next time it's used and saved (memory store)", async () => {
    const store = new MemoryStore();
    store.set("legacy-id", legacyRecord(), 60_000);
    const cookie = `yerd_session=${sealFor("session-cookie", [SECRET], legacyPayload({ i: "legacy-id" }))}`;
    const r = await app(store).request("/whoami", { method: "POST", headers: { cookie } });
    expect(await r.json()).toEqual({ name: "ada" });
    expect(r.headers.getSetCookie()).toHaveLength(1);
    expect(store.get("legacy-id")!.data.__yerd_csrf).toEqual(expect.any(String));
  });
});

describe("HEAD and error pages", () => {
  it("never set a cookie for a visitor without a session", async () => {
    const store = new MemoryStore();
    const head = await app(store).request("/late-form", { method: "HEAD", ...html });
    expect(head.headers.getSetCookie()).toEqual([]);
    const missing = await app(store).request("/nope", html);
    expect(missing.status).toBe(404);
    expect(missing.headers.getSetCookie()).toEqual([]);
    expect(store.size).toBe(0);
  });
});

describe("yx-rebind: the page's other tokens after an action starts or rotates the session", () => {
  it("is sent when a scripted action starts the session", async () => {
    const client = app().client();
    const r = await client.action("/cart");
    expect(r.status).toBe(200);
    expect(r.headers.getSetCookie().length).toBe(1);
    expect(r.headers.get("yx-rebind")).toBe("1");
  });

  it("isn't sent once the session exists and its nonce stays", async () => {
    const client = app().client();
    await client.action("/cart");
    const again = await client.action("/cart");
    expect(again.status).toBe(200);
    expect(again.headers.get("yx-rebind")).toBeNull();
  });

  it("is sent when signing in rotates the nonce", async () => {
    const client = app().client();
    await client.action("/cart");
    const r = await client.action("/login");
    expect(r.headers.get("yx-rebind")).toBe("1");
  });

  it("isn't sent to a plain form post (it gets a whole new page anyway) or an action that changes nothing", async () => {
    const client = app().client();
    expect((await client.action("/cart", {}, { script: false })).headers.get("yx-rebind")).toBeNull();
    expect((await app().client().action("/form")).headers.get("yx-rebind")).toBeNull();
  });
});
