// Cross-site checks and action tokens: forged origins, replayed tokens, other sessions, expiry, rotation.
import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { action, get, post, put, route, session, yerd, type RunningServer, type Session } from "@toyz/yerd";
import { crossSiteReason } from "../../src/server/app.js";
import { csrfTag, signAction, verifyAction } from "../../src/actions/action.js";

const SECRET = "c".repeat(32);
const OLD = "o".repeat(32);

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("crossSiteReason", () => {
  const host = "app.example";
  const trusted = new Set(["https://admin.example"]);
  const table: Array<[string, Record<string, string>, string | undefined]> = [
    ["no browser headers at all (curl)", { host }, undefined],
    ["Sec-Fetch-Site same-origin", { host, "sec-fetch-site": "same-origin" }, undefined],
    ["Sec-Fetch-Site none (typed in the address bar)", { host, "sec-fetch-site": "none" }, undefined],
    ["Sec-Fetch-Site cross-site", { host, "sec-fetch-site": "cross-site" }, "Cross-site requests are refused"],
    ["Sec-Fetch-Site same-site (a sibling subdomain)", { host, "sec-fetch-site": "same-site" }, "Cross-site requests are refused"],
    ["cross-site even with a matching Origin", { host, "sec-fetch-site": "cross-site", origin: "https://app.example" }, "Cross-site requests are refused"],
    ["same-origin wins over a foreign Origin", { host, "sec-fetch-site": "same-origin", origin: "https://evil.example" }, undefined],
    ["a trusted Origin wins over cross-site", { host, "sec-fetch-site": "cross-site", origin: "https://admin.example" }, undefined],
    ["a trusted Origin with a trailing slash isn't trusted", { host, "sec-fetch-site": "cross-site", origin: "https://admin.example/" }, "Cross-site requests are refused"],
    ["an unknown Sec-Fetch-Site falls back to Origin", { host, "sec-fetch-site": "weird", origin: "https://evil.example" }, "Cross-origin requests are refused"],
    ["Origin matching Host", { host, origin: "https://app.example" }, undefined],
    ["Origin matching Host, http", { host, origin: "http://app.example" }, undefined],
    ["Origin with the default port spelled out", { host, origin: "https://app.example:443" }, undefined],
    ["Origin on another port", { host, origin: "https://app.example:8443" }, "Cross-origin requests are refused"],
    ["Origin with upper case host", { host, origin: "https://APP.EXAMPLE" }, undefined],
    ["Origin of a subdomain", { host, origin: "https://evil.app.example" }, "Cross-origin requests are refused"],
    ["Origin that only ends with the host", { host, origin: "https://notapp.example" }, "Cross-origin requests are refused"],
    ["Origin with credentials in it", { host, origin: "https://app.example@evil.example" }, "Cross-origin requests are refused"],
    ["Origin null (sandboxed frame)", { host, origin: "null" }, "Requests from an opaque origin are refused"],
    ["Origin garbage", { host, origin: "not a url" }, "Malformed Origin header"],
    ["two Origins joined", { host, origin: "https://evil.example, https://app.example" }, "Malformed Origin header"],
    ["Referer only, same host", { host, referer: "https://app.example/page?x=1" }, undefined],
    ["Referer only, foreign", { host, referer: "https://evil.example/app.example" }, "Cross-origin requests are refused"],
    ["Referer only, trusted origin", { host, referer: "https://admin.example/tools" }, undefined],
    ["Origin wins over Referer", { host, origin: "https://evil.example", referer: "https://app.example/" }, "Cross-origin requests are refused"],
    ["a trusted Origin without Sec-Fetch-Site", { host, origin: "https://admin.example" }, undefined],
    ["IPv6 host", { host: "[::1]:3000", origin: "http://[::1]:3000" }, undefined],
    ["X-Forwarded-Host ignored without trustProxy", { host, origin: "https://evil.example", "x-forwarded-host": "evil.example" }, "Cross-origin requests are refused"],
  ];

  it.each(table)("%s", (_label, headers, expected) => {
    expect(crossSiteReason(req(headers), trusted, false)).toBe(expected);
  });

  it("believes the first X-Forwarded-Host only with trustProxy", () => {
    const headers = { host: "internal:8080", origin: "https://app.example", "x-forwarded-host": "app.example, internal:8080" };
    expect(crossSiteReason(req(headers), new Set(), true)).toBeUndefined();
    expect(crossSiteReason(req(headers), new Set(), false)).toBe("Cross-origin requests are refused");
  });

  it("refuses a malformed Host rather than throwing", () => {
    expect(crossSiteReason(req({ host: "a b", origin: "https://a" }), new Set(), false)).toBe("Malformed Host header");
  });

  it("with no Host, an Origin is cross-origin", () => {
    expect(crossSiteReason(req({ origin: "https://app.example" }), new Set(), false)).not.toBeUndefined();
  });
});

describe("verifyAction", () => {
  const token = signAction(SECRET, { c: "C", a: "a", p: { id: 1 }, e: 2e9 });

  it.each([
    ["no dot", "abc"],
    ["leading dot", ".abc"],
    ["empty", ""],
  ])("a malformed token (%s) is a 400", (_label, value) => {
    expect(() => verifyAction([SECRET], value)).toThrow("Malformed action token");
  });

  it("a changed payload, signature, or secret is a 400", () => {
    const [data, sig] = token.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ c: "C", a: "a", p: { id: 2 }, e: 2e9 })).toString("base64url");
    expect(() => verifyAction([SECRET], `${forged}.${sig}`)).toThrow("Invalid action signature");
    expect(() => verifyAction([SECRET], `${data}.${sig.slice(0, -1)}`)).toThrow("Invalid action signature");
    expect(() => verifyAction([SECRET], `${data}.${sig}x`)).toThrow("Invalid action signature");
    expect(() => verifyAction([SECRET], `${data}.`)).toThrow("Invalid action signature");
    expect(() => verifyAction(["x".repeat(32)], token)).toThrow("Invalid action signature");
  });

  it("accepts any listed secret (rotation)", () => {
    const old = signAction(OLD, { c: "C", a: "a", p: {} });
    expect(verifyAction([SECRET, OLD], old)).toEqual({ c: "C", a: "a", p: {} });
    expect(() => verifyAction([SECRET], old)).toThrow("Invalid action signature");
  });

  it("a signature that is valid but over non-JSON data is a 400, not a crash", () => {
    const data = Buffer.from("not json").toString("base64url");
    const good = createHmac("sha256", SECRET).update(data).digest("base64url");
    expect(() => verifyAction([SECRET], `${data}.${good}`)).toThrow("Malformed action token");
  });
});

declare module "@toyz/yerd" {
  interface SessionData {
    hits?: number;
  }
}

const calls: string[] = [];

@route("/form")
class Form {
  @session accessor session!: Session;
  @get page() {
    return (
      <div>
        <form action={this.bump} />
      </div>
    );
  }
  @action bump() {
    this.session.hits = (this.session.hits ?? 0) + 1;
    calls.push("bump");
    return { hits: this.session.hits };
  }
  @action other() {
    calls.push("other");
    return "other";
  }
}

@route("/plain")
class Plain {
  @post save() {
    calls.push("plain");
    return 204;
  }
  @put replace() {
    return 204;
  }
}

@route("/reset")
class Reset {
  @session accessor session!: Session;
  @post go() {
    this.session.destroy();
    return 204;
  }
}

function client(base: string) {
  let jar = "";
  return {
    get jar() {
      return jar;
    },
    set jar(v: string) {
      jar = v;
    },
    async fetch(path: string, init: RequestInit = {}) {
      const r = await fetch(base + path, { redirect: "manual", ...init, headers: { cookie: jar, ...(init.headers as object) } });
      for (const c of r.headers.getSetCookie()) jar = /Max-Age=0/.test(c) ? "" : c.split(";")[0]!;
      return r;
    },
    async token(path = "/form") {
      const html = await (await this.fetch(path, { headers: { accept: "text/html" } })).text();
      return /name="_yx" value="([^"]+)"/.exec(html)![1]!;
    },
  };
}

const post_ = (token: string | string[], headers: Record<string, string> = {}, extra: Record<string, string> = {}): RequestInit => {
  const body = new URLSearchParams(extra);
  for (const t of [token].flat()) body.append("_yx", t);
  return { method: "POST", body, headers: { "sec-fetch-site": "same-origin", ...headers } };
};

describe("action posts in a running app with sessions", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await yerd({
      routes: [Form, Plain, Reset],
      services: [],
      handleSignals: false,
      secret: [SECRET, OLD],
      trustedOrigins: ["https://admin.example"],
      actionTtl: 60,
    })
      .sessions()
      .listen(0, "127.0.0.1");
  });
  afterAll(() => server.close());

  it("runs with its own session's token", async () => {
    const c = client(server.url);
    const r = await c.fetch("/form", post_(await c.token(), { yx: "1", accept: "application/json" }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ hits: 1 });
  });

  it.each([
    ["Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }],
    ["Sec-Fetch-Site same-site", { "sec-fetch-site": "same-site" }],
    ["a foreign Origin", { "sec-fetch-site": "", origin: "https://evil.example" }],
    ["Origin null", { "sec-fetch-site": "", origin: "null" }],
    ["a foreign Referer only", { "sec-fetch-site": "", referer: "https://evil.example/x" }],
  ])("refuses %s before the action runs, valid token or not", async (_label, headers) => {
    const c = client(server.url);
    const token = await c.token();
    calls.length = 0;
    const clean = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== ""));
    const r = await fetch(server.url + "/form", { method: "POST", body: new URLSearchParams({ _yx: token }), headers: { cookie: c.jar, ...clean } });
    expect(r.status).toBe(403);
    expect(calls).toEqual([]);
    // No session cookie is touched by a refused request.
    expect(r.headers.getSetCookie()).toEqual([]);
  });

  it("refuses cross-site plain POST, PUT and DELETE too, not just actions", async () => {
    calls.length = 0;
    // DELETE and PATCH have no handler here: still refused before the 405, so a probe learns nothing.
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const r = await fetch(server.url + "/plain", { method, headers: { "sec-fetch-site": "cross-site" } });
      expect(r.status, method).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  it("lets a trusted origin post", async () => {
    const c = client(server.url);
    const token = await c.token();
    const r = await c.fetch("/form", { method: "POST", body: new URLSearchParams({ _yx: token }), headers: { origin: "https://admin.example", "sec-fetch-site": "cross-site", yx: "1" } });
    expect(r.status).toBe(200);
  });

  it("refuses a token replayed from another session (403, yx-stale for the runtime)", async () => {
    const alice = client(server.url);
    const mallory = client(server.url);
    const token = await mallory.token();
    await alice.token(); // alice has her own session (and nonce)
    calls.length = 0;
    const plain = await alice.fetch("/form", post_(token));
    expect(plain.status).toBe(403);
    const scripted = await alice.fetch("/form", post_(token, { yx: "1" }));
    expect(scripted.status).toBe(403);
    expect(scripted.headers.get("yx-stale")).toBe("1");
    expect(await scripted.text()).toMatch(/different session/);
    expect(calls).toEqual([]);
  });

  it("refuses a session-bound token posted with no session at all", async () => {
    const mallory = client(server.url);
    const token = await mallory.token();
    const r = await fetch(server.url + "/form", { ...post_(token) });
    expect(r.status).toBe(403);
  });

  it("refuses a token once its session is destroyed (a new session gets a new nonce)", async () => {
    const c = client(server.url);
    const token = await c.token();
    await c.fetch("/reset", { method: "POST", headers: { "sec-fetch-site": "same-origin" } });
    await c.token(); // a fresh session, fresh nonce
    expect((await c.fetch("/form", post_(token))).status).toBe(403);
  });

  it("refuses an expired token and accepts it just before", async () => {
    const c = client(server.url);
    const now = Date.now();
    const token = await c.token();
    const spy = vi.spyOn(Date, "now");
    try {
      spy.mockReturnValue(now + 59_000);
      expect((await c.fetch("/form", post_(token, { yx: "1" }))).status).toBe(200);
      spy.mockReturnValue(now + 62_000);
      const r = await c.fetch("/form", post_(token, { yx: "1" }));
      expect(r.status).toBe(403);
      expect(await r.text()).toMatch(/expired/);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a token whose session tag is missing, or forged for a nonce it can't know", async () => {
    const c = client(server.url);
    await c.token();
    const noTag = signAction(SECRET, { c: "Form", a: "bump", p: {}, e: Math.floor(Date.now() / 1000) + 60 });
    expect((await c.fetch("/form", post_(noTag))).status).toBe(403);
    const guessed = signAction(SECRET, { c: "Form", a: "bump", p: {}, e: Math.floor(Date.now() / 1000) + 60, s: csrfTag("guess") });
    expect((await c.fetch("/form", post_(guessed))).status).toBe(403);
  });

  it("accepts a token signed with an old secret still listed", async () => {
    const c = client(server.url);
    // A token made with the current secret, re-signed with the old one: same payload.
    const payload = JSON.parse(Buffer.from((await c.token()).split(".")[0]!, "base64url").toString()) as Parameters<typeof signAction>[1];
    const r = await c.fetch("/form", post_(signAction(OLD, payload), { yx: "1" }));
    expect(r.status).toBe(200);
  });

  it("accepts a prerendered-style token (no expiry, no session) from anyone, subject to the cross-site check", async () => {
    const token = signAction(SECRET, { c: "Form", a: "bump", p: {} });
    const anyone = client(server.url);
    expect((await anyone.fetch("/form", post_(token, { yx: "1" }))).status).toBe(200);
    expect((await anyone.fetch("/form", post_(token, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
  });

  it("the last _yx wins: a forged first value doesn't matter, a forged last one does", async () => {
    const c = client(server.url);
    const good = await c.token();
    expect((await c.fetch("/form", post_(["garbage", good], { yx: "1" }))).status).toBe(200);
    expect((await c.fetch("/form", post_([good, "garbage.sig"], { yx: "1" }))).status).toBe(400);
  });

  it.each([
    ["a verb method that isn't an action", { c: "Form", a: "page" }],
    ["a class that isn't on this path", { c: "Plain", a: "save" }],
    ["a class that doesn't exist", { c: "Nope", a: "bump" }],
    ["an inherited Object method", { c: "Form", a: "constructor" }],
    ["a prototype key", { c: "Form", a: "__proto__" }],
  ])("refuses a validly signed token naming %s (400 Unknown action)", async (_label, target) => {
    // No expiry or session tag, so the token gets as far as finding the action.
    const token = signAction(SECRET, { ...target, p: {} });
    calls.length = 0;
    const r = await fetch(server.url + "/form", post_(token, { yx: "1" }));
    expect(r.status).toBe(400);
    expect(await r.text()).toBe("Unknown action");
    expect(calls).toEqual([]);
  });

  it("a token for one action can't be posted as another: the action name is signed", async () => {
    const c = client(server.url);
    const token = await c.token();
    const [data, sig] = token.split(".") as [string, string];
    const payload = JSON.parse(Buffer.from(data, "base64url").toString()) as { a: string };
    payload.a = "other";
    const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
    calls.length = 0;
    expect((await c.fetch("/form", post_(forged))).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("a form post without _yx goes to the route's @post handler, not an action", async () => {
    const r = await fetch(server.url + "/plain", { method: "POST", body: new URLSearchParams({ x: "1" }), headers: { "sec-fetch-site": "same-origin" } });
    expect(r.status).toBe(204);
  });
});

@route("/nosession")
class NoSession {
  @get page() {
    return <form action={this.go} />;
  }
  @action go() {
    return "went";
  }
}

describe("action tokens without sessions", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await yerd({ routes: [NoSession], services: [], handleSignals: false, secret: SECRET }).listen(0, "127.0.0.1");
  });
  afterAll(() => server.close());

  it("carry no session tag, still expire, and still need a same-site post", async () => {
    const html = await (await fetch(server.url + "/nosession", { headers: { accept: "text/html" } })).text();
    const token = /name="_yx" value="([^"]+)"/.exec(html)![1]!;
    const payload = verifyAction([SECRET], token);
    expect(payload.s).toBeUndefined();
    expect(typeof payload.e).toBe("number");
    const ok = await fetch(server.url + "/nosession", { method: "POST", body: new URLSearchParams({ _yx: token }), headers: { yx: "1" } });
    expect(await ok.text()).toBe("went");
    const cross = await fetch(server.url + "/nosession", { method: "POST", body: new URLSearchParams({ _yx: token }), headers: { "sec-fetch-site": "cross-site" } });
    expect(cross.status).toBe(403);
  });
});

describe("csrf: false", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await yerd({ routes: [NoSession], services: [], handleSignals: false, secret: SECRET, csrf: false }).listen(0, "127.0.0.1");
  });
  afterAll(() => server.close());

  it("turns off the origin check only: the token still has to be valid", async () => {
    const html = await (await fetch(server.url + "/nosession", { headers: { accept: "text/html" } })).text();
    const token = /name="_yx" value="([^"]+)"/.exec(html)![1]!;
    const cross = await fetch(server.url + "/nosession", { method: "POST", body: new URLSearchParams({ _yx: token }), headers: { "sec-fetch-site": "cross-site", yx: "1" } });
    expect(cross.status).toBe(200);
    const forged = await fetch(server.url + "/nosession", { method: "POST", body: new URLSearchParams({ _yx: "x.y" }), headers: { yx: "1" } });
    expect(forged.status).toBe(400);
  });
});
