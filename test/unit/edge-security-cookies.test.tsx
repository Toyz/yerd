// Session cookies through a real server: proxies, duplicate and planted cookies, tokens across sign-in.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { action, currentContext, get, parseCookies, post, query, route, session, yerd, type RunningServer, type Session } from "@toyz/yerd";
import { createAuth } from "@toyz/yerd/auth";

const SECRET = "k".repeat(32);

declare module "@toyz/yerd" {
  interface SessionData {
    name?: string;
  }
}

@route("/name")
class Name {
  @session accessor session!: Session;
  @query("v") accessor v: string | undefined;
  @get show() {
    return { name: this.session.name ?? null, url: currentContext().url.href };
  }
  @post set() {
    this.session.name = this.v;
    return 204;
  }
}

const cookieName = (line: string) => line.split("=")[0];

describe("proxies and the session cookie", () => {
  const servers: RunningServer[] = [];
  afterAll(async () => {
    for (const s of servers) await s.close();
  });
  const start = async (app: ReturnType<typeof yerd>) => {
    const s = await app.listen(0, "127.0.0.1");
    servers.push(s);
    return s;
  };

  it("inherits the app's trustProxy: X-Forwarded-Proto https gives a __Host- Secure cookie", async () => {
    const server = await start(yerd({ routes: [Name], services: [], handleSignals: false, secret: SECRET, trustProxy: true }).sessions());
    const r = await fetch(server.url + "/name?v=ada", { method: "POST", headers: { "x-forwarded-proto": "https" } });
    const [line] = r.headers.getSetCookie();
    expect(cookieName(line!)).toBe("__Host-yerd_session");
    expect(line).toMatch(/; Secure;/);
    // ctx.url follows the same headers.
    const page = await fetch(server.url + "/name", { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "app.example, internal", cookie: line!.split(";")[0]! } });
    expect(await page.json()).toEqual({ name: "ada", url: "https://app.example/name" });
  });

  it("a sessions({ trustProxy: false }) override ignores the header even when the app trusts it", async () => {
    const server = await start(yerd({ routes: [Name], services: [], handleSignals: false, secret: SECRET, trustProxy: true }).sessions({ trustProxy: false }));
    const r = await fetch(server.url + "/name?v=ada", { method: "POST", headers: { "x-forwarded-proto": "https" } });
    expect(cookieName(r.headers.getSetCookie()[0]!)).toBe("yerd_session");
  });

  it("without trustProxy a client can't talk its way into https (cookie or ctx.url)", async () => {
    const server = await start(yerd({ routes: [Name], services: [], handleSignals: false, secret: SECRET }).sessions());
    const r = await fetch(server.url + "/name?v=ada", { method: "POST", headers: { "x-forwarded-proto": "https", "x-forwarded-host": "evil.example" } });
    const line = r.headers.getSetCookie()[0]!;
    expect(cookieName(line)).toBe("yerd_session");
    expect(line).not.toMatch(/Secure/);
    const page = await fetch(server.url + "/name", { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "evil.example" } });
    expect((await page.json()).url).toBe(`${server.url}/name`);
  });
});

describe("duplicate and planted cookies", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await yerd({ routes: [Name], services: [], handleSignals: false, secret: SECRET }).sessions().listen(0, "127.0.0.1");
  });
  afterAll(() => server.close());

  const sessionFor = async (name: string) => {
    const r = await fetch(server.url + `/name?v=${name}`, { method: "POST" });
    return r.headers.getSetCookie()[0]!.split(";")[0]!;
  };

  it("reads the first of two session cookies (the browser sends the more specific one first)", async () => {
    const ada = await sessionFor("ada");
    const bob = await sessionFor("bob");
    const r = await fetch(server.url + "/name", { headers: { cookie: `${ada}; ${bob}` } });
    expect((await r.json()).name).toBe("ada");
    const swapped = await fetch(server.url + "/name", { headers: { cookie: `${bob}; ${ada}` } });
    expect((await swapped.json()).name).toBe("bob");
  });

  it("a broken first cookie means no session, even with a good one after it", async () => {
    const ada = await sessionFor("ada");
    const r = await fetch(server.url + "/name", { headers: { cookie: `yerd_session=junk; ${ada}` } });
    expect((await r.json()).name).toBeNull();
  });

  it("over plain http, a __Host- cookie is ignored", async () => {
    const ada = await sessionFor("ada");
    const r = await fetch(server.url + "/name", { headers: { cookie: `__Host-${ada}` } });
    expect((await r.json()).name).toBeNull();
  });

  it("a quoted cookie value still opens", async () => {
    const [k, v] = (await sessionFor("ada")).split("=") as [string, string];
    const r = await fetch(server.url + "/name", { headers: { cookie: `${k}="${v}"` } });
    expect((await r.json()).name).toBe("ada");
  });

  it("an enormous cookie header is refused by the HTTP parser, not by us crashing", async () => {
    const r = await fetch(server.url + "/name", { headers: { cookie: `yerd_session=${"A".repeat(20_000)}` } });
    expect(r.status).toBe(431);
    // Just under Node's header limit: read, refused as a session, answered normally.
    const big = await fetch(server.url + "/name", { headers: { cookie: `yerd_session=${"A".repeat(12_000)}` } });
    expect(await big.json()).toMatchObject({ name: null });
  });

  it("parseCookies keeps the first of duplicate names and survives bad percent-encoding", () => {
    expect(parseCookies("a=1; a=2")).toEqual({ a: "1" });
    expect(parseCookies("a=%E0%A4%A; b=%41")).toEqual({ a: "%E0%A4%A", b: "A" });
    expect(parseCookies("=x; ; noeq; __proto__=1")["__proto__"]).toBe("1");
    expect(Object.getPrototypeOf(parseCookies("a=1"))).toBeNull();
  });
});

const auth = createAuth<{ id: string }>({ load: (id) => ({ id }), sessionKey: "cookie_uid" });

@route("/act")
class Act {
  @get page() {
    return <form action={this.go} />;
  }
  @action go() {
    return `ok ${auth.current()?.id ?? "anon"}`;
  }
}

@route("/signin")
class SignIn {
  @query("as") accessor as: string | undefined;
  @post go() {
    auth.login({ id: this.as! });
    return 204;
  }
}

describe("action tokens across sign-in", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await yerd({ routes: [Act, SignIn], services: [], handleSignals: false, secret: SECRET }).sessions().use(auth).listen(0, "127.0.0.1");
  });
  afterAll(() => server.close());

  function client() {
    let jar = "";
    return async (path: string, init: RequestInit = {}) => {
      const r = await fetch(server.url + path, { ...init, headers: { cookie: jar, ...(init.headers as object) } });
      for (const c of r.headers.getSetCookie()) jar = /Max-Age=0/.test(c) ? "" : c.split(";")[0]!;
      return r;
    };
  }
  const tokenFrom = async (c: ReturnType<typeof client>) =>
    /name="_yx" value="([^"]+)"/.exec(await (await c("/act", { headers: { accept: "text/html" } })).text())![1]!;
  const submit = (c: ReturnType<typeof client>, token: string) => c("/act", { method: "POST", body: new URLSearchParams({ _yx: token }), headers: { yx: "1" } });

  it("a form rendered for a guest still works after that guest signs in (the session carries on)", async () => {
    const c = client();
    const token = await tokenFrom(c);
    await c("/signin?as=ada", { method: "POST" });
    const r = await submit(c, token);
    expect(await r.text()).toBe("ok ada");
  });

  it("a form rendered for one user stops working once someone else signs in on that browser", async () => {
    const c = client();
    await c("/signin?as=ada", { method: "POST" });
    const token = await tokenFrom(c);
    await c("/signin?as=bob", { method: "POST" });
    const r = await submit(c, token);
    expect(r.status).toBe(403);
    expect(r.headers.get("yx-stale")).toBe("1");
    expect(await submit(c, await tokenFrom(c)).then((x) => x.text())).toBe("ok bob");
  });
});
