// Open redirects: safeBack / safeNext tables, and the places that use them (login next=, the no-JS action redirect).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionForm, action, get, query, redirect, route, yerd, type RunningServer } from "@toyz/yerd";
import { createAuth, safeNext } from "@toyz/yerd/auth";
import { safeBack } from "../../src/actions/action.js";

/** How a browser resolves a Location header against the page: the origin it lands on. */
function landsOn(location: string): string {
  return new URL(location, "https://app.example/page").origin;
}

const evil: string[] = [
  "//evil.com",
  "///evil.com",
  "////evil.com",
  "/\\evil.com",
  "\\\\evil.com",
  "\\/evil.com",
  "/\t/evil.com",
  "/\n/evil.com",
  "/\r/evil.com",
  "/\r\n/evil.com",
  "/\u0000/evil.com",
  "/\u007f/evil.com",
  "\t//evil.com",
  " //evil.com",
  "https://evil.com",
  "http:evil.com",
  "HTTPS://evil.com",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
  "evil.com",
  "?next=//evil.com",
  "#//evil.com",
  "",
  // Dot segments: the URL parser removes them, which can leave "//" at the front.
  "/.//evil.com",
  "/..//evil.com",
  "/x/..//evil.com",
  "/x/../..//evil.com",
  "/%2e//evil.com",
  "/%2E//evil.com",
  "/%2e%2e//evil.com",
  "/.%2e//evil.com",
  "/x/%2e%2e//evil.com",
  "/././/evil.com",
  "/.///evil.com",
];

const safe: Array<[string, string]> = [
  ["/", "/"],
  ["/todos", "/todos"],
  ["/todos?x=1&y=2", "/todos?x=1&y=2"],
  ["/todos#top", "/todos#top"],
  ["/a/../b", "/b"],
  ["/a/./b", "/a/b"],
  ["/%2F%2Fevil.com", "/%2F%2Fevil.com"],
  ["/%5Cevil.com", "/%5Cevil.com"],
  ["/%09/evil.com", "/%09/evil.com"],
  ["/path?u=//evil.com", "/path?u=//evil.com"],
  ["/path?u=https://evil.com", "/path?u=https://evil.com"],
  ["/café", "/caf%C3%A9"],
  ["/∕∕evil.com", "/%E2%88%95%E2%88%95evil.com"],
  ["/／／evil.com", "/%EF%BC%8F%EF%BC%8Fevil.com"],
  ["/ /evil.com", "/%20/evil.com"],
  ["/a//b", "/a//b"],
  ["/..", "/"],
  ["/../../etc/passwd", "/etc/passwd"],
];

describe("safeBack / safeNext tables", () => {
  it.each(evil)("refuses %j", (value) => {
    expect(safeBack(value, "/home")).toBe("/home");
    expect(safeNext(value)).toBe("/");
    expect(safeNext(value, "/fallback")).toBe("/fallback");
  });

  it.each(safe)("keeps %j as %j", (value, expected) => {
    expect(safeBack(value, "/home")).toBe(expected);
    expect(safeNext(value)).toBe(expected);
  });

  it("never returns anything a browser would take off-site", () => {
    const bits = ["/", "\\", ".", "%2e", "%2f", "%5c", "evil.com", "\t", "@", ":", "?", "#", "x"];
    // Every three-piece combination after a leading slash.
    for (const a of bits) for (const b of bits) for (const c of bits) {
      const value = `/${a}${b}${c}`;
      const out = safeBack(value, "/home");
      expect(landsOn(out), JSON.stringify(value)).toBe("https://app.example");
      expect(out.startsWith("//"), JSON.stringify(value)).toBe(false);
    }
  });

  it("treats null and undefined as missing", () => {
    expect(safeBack(undefined, "/f")).toBe("/f");
    expect(safeBack(null, "/f")).toBe("/f");
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext(null)).toBe("/");
  });
});

const auth = createAuth<{ id: string }>({ load: (id) => ({ id }), loginPath: "/login" });

@route("/login")
class Login {
  @query("next") accessor next: string | undefined;
  @get page() {
    return <form action={this.submit} />;
  }
  @action submit(_: {}, _form: ActionForm) {
    auth.login({ id: "ada" });
    return redirect(safeNext(this.next));
  }
}

@route("/private", { guards: [auth.required] })
class Private {
  @get show() {
    return "private";
  }
}

@route("/back")
class Back {
  @get page() {
    return <form action={this.go} />;
  }
  @action go() {
    // Nothing returned: post/redirect/get back to the page.
  }
}

describe("redirects in a running app", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await yerd({ routes: [Login, Private, Back], services: [], handleSignals: false, secret: "r".repeat(32) })
      .sessions()
      .use(auth)
      .listen(0, "127.0.0.1");
  });
  afterAll(() => server.close());

  function client() {
    let jar = "";
    return async (path: string, init: RequestInit = {}) => {
      const r = await fetch(server.url + path, { redirect: "manual", ...init, headers: { cookie: jar, ...(init.headers as object) } });
      for (const c of r.headers.getSetCookie()) jar = /Max-Age=0/.test(c) ? "" : c.split(";")[0]!;
      return r;
    };
  }

  async function tokenFrom(path: string, c: ReturnType<typeof client>) {
    return /name="_yx" value="([^"]+)"/.exec(await (await c(path, { headers: { accept: "text/html" } })).text())![1]!;
  }

  it.each(["//evil.com", "/.//evil.com", "/%2e//evil.com", "/x/..//evil.com", "https://evil.com", "/\\evil.com"])(
    "a login with next=%j lands on this site",
    async (next) => {
      const c = client();
      const token = await tokenFrom("/login", c);
      const r = await c(`/login?next=${encodeURIComponent(next)}`, { method: "POST", body: new URLSearchParams({ _yx: token }) });
      expect(r.status).toBe(303);
      expect(r.headers.get("location")).toBe("/");
    },
  );

  it("a login with a same-site next= goes there", async () => {
    const c = client();
    const token = await tokenFrom("/login", c);
    const r = await c(`/login?next=${encodeURIComponent("/private?tab=1")}`, { method: "POST", body: new URLSearchParams({ _yx: token }) });
    expect(r.headers.get("location")).toBe("/private?tab=1");
    expect(await (await c("/private")).text()).toBe("private");
  });

  it("the guard's next= round-trips through safeNext unchanged", async () => {
    const r = await fetch(server.url + "/private?a=1&b=%2F%2F", { redirect: "manual", headers: { accept: "text/html" } });
    const location = r.headers.get("location")!;
    expect(location).toBe("/login?next=%2Fprivate%3Fa%3D1%26b%3D%252F%252F");
    const next = new URL(location, server.url).searchParams.get("next");
    expect(safeNext(next)).toBe("/private?a=1&b=%2F%2F");
  });

  it("the guard encodes a path that would be off-site, and safeNext refuses it later", async () => {
    // A raw request path a browser wouldn't send, but a crafted link might.
    const r = await fetch(server.url + "/private/..//evil.com", { redirect: "manual", headers: { accept: "text/html" } });
    expect(r.status).toBe(404);
  });

  it.each([
    ["a same-host Referer", (base: string) => `${base}/back?x=1`, "/back?x=1"],
    ["a foreign Referer", () => "https://evil.com/back", "/back"],
    ["a same-host Referer with a dot-segment path", (base: string) => `${base}/.//evil.com`, "/back"],
    ["a malformed Referer", () => "::::", "/back"],
  ])("the no-JS action redirect with %s stays on site", async (_label, referer, expected) => {
    const c = client();
    const token = await tokenFrom("/back", c);
    const r = await c("/back", {
      method: "POST",
      body: new URLSearchParams({ _yx: token }),
      headers: { referer: referer(server.url), "sec-fetch-site": "same-origin" },
    });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(expected);
  });

  it("behind a proxy, the no-JS action redirect compares the Referer with the forwarded host", async () => {
    await using proxied = await yerd({ routes: [Back], services: [], handleSignals: false, secret: "r".repeat(32), trustProxy: true })
      .listen(0, "127.0.0.1");
    // The proxy rewrites Host to the internal address and says what the client asked for.
    const via = { "x-forwarded-host": "shop.example", "x-forwarded-proto": "https" };
    const html = await (await fetch(proxied.url + "/back", { headers: { accept: "text/html", ...via } })).text();
    const token = /name="_yx" value="([^"]+)"/.exec(html)![1]!;
    const r = await fetch(proxied.url + "/back", {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ _yx: token }),
      headers: { ...via, referer: "https://shop.example/back?x=1", "sec-fetch-site": "same-origin" },
    });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/back?x=1");
  });
});
