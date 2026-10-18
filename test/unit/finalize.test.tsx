// The last steps every answer takes, routed or not: what the context set, the session, caching, a failing error page.
import { describe, expect, it, vi } from "vitest";
import { currentContext, get, post, route, session, yerd, MemoryStore, type LayoutProps, type Session } from "@toyz/yerd";
import { SessionManager } from "../../src/session/manager.js";

const SECRET = "f".repeat(32);

declare module "@toyz/yerd" {
  interface SessionData {
    name?: string;
  }
}

@route("/only-get")
class OnlyGet {
  @get page() {
    return <p>here</p>;
  }
}

@route("/sign-in")
class SignIn {
  @session accessor session!: Session;
  @post in() {
    this.session.name = "ada";
    return 204;
  }
}

const cookies = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]);

describe("requests that never reach a handler", () => {
  it("apply what app.onError set on the context: headers and cookies, on a 404", async () => {
    const app = yerd({ routes: [OnlyGet], services: [], handleSignals: false, secret: SECRET }).onError((_error, ctx) => {
      ctx.setHeader("x-trace", "abc");
      ctx.setCookie("seen-404", "1");
      return undefined;
    });
    const r = await app.request("/nope");
    expect(r.status).toBe(404);
    expect(r.headers.get("x-trace")).toBe("abc");
    expect(cookies(r)).toEqual(["seen-404=1"]);
  });

  it("apply what an error page's layout set, on a 405, alongside Allow", async () => {
    function Root({ children }: LayoutProps) {
      currentContext().setHeader("x-layout", "root");
      return <html><body>{children}</body></html>;
    }
    const app = yerd({ routes: [OnlyGet], services: [], handleSignals: false, secret: SECRET })
      .layout(Root)
      .errorPage(({ status }) => <p>error {status}</p>);
    const r = await app.request("/only-get", { method: "DELETE", headers: { accept: "text/html" } });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET, HEAD");
    expect(r.headers.get("x-layout")).toBe("root");
    expect(await r.text()).toContain("error 405");
  });

  it("mark an HTML error page private when it sets a cookie, as routed pages are", async () => {
    const app = yerd({ routes: [OnlyGet], services: [], handleSignals: false, secret: SECRET })
      .sessions({ store: new MemoryStore() })
      .errorPage(({ status }) => <p>error {status}</p>)
      .onError((_error, ctx) => {
        ctx.setCookie("seen-404", "1");
        return undefined;
      });
    const r = await app.request("/nope", { headers: { accept: "text/html" } });
    expect(r.status).toBe(404);
    expect(r.headers.get("cache-control")).toBe("private, no-cache");
  });

  it("answer with the plain error when the error page itself fails, logging it once", async () => {
    function Broken(): never {
      throw new Error("the error page broke");
    }
    const app = yerd({ routes: [OnlyGet], services: [], handleSignals: false }).errorPage(Broken);
    const r = await app.request("/nope", { headers: { accept: "text/html" } });
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await r.json()).toEqual({ error: "Not Found", code: "not_found" });
  });

  it("leave a refused cross-site post's session alone, even with an error page to show", async () => {
    const app = yerd({ routes: [SignIn], services: [], handleSignals: false, secret: SECRET })
      .sessions()
      .errorPage(({ status }) => <p>error {status}</p>);
    const client = app.client();
    await client.request("/sign-in", { method: "POST" });
    const jar = client.cookies.get("yerd_session")!;
    const r = await app.request("/sign-in", { method: "POST", headers: { cookie: `yerd_session=${jar}`, "sec-fetch-site": "cross-site", accept: "text/html" } });
    expect(r.status).toBe(403);
    expect(r.headers.getSetCookie()).toEqual([]);
  });
});

@route("/anon")
class Anon {
  @get page() {
    return { ok: true };
  }
}

describe("saving the session", () => {
  it("skips the commit whenever nothing opened the session, cookie or not", async () => {
    const commit = vi.spyOn(SessionManager.prototype, "commit");
    try {
      const app = yerd({ routes: [Anon, SignIn], services: [], handleSignals: false, secret: SECRET }).sessions();
      const r = await app.request("/anon");
      expect(r.headers.getSetCookie()).toEqual([]);
      expect(commit).not.toHaveBeenCalled();
      const client = app.client();
      await client.request("/sign-in", { method: "POST" });
      expect(commit).toHaveBeenCalledTimes(1);
      // A session cookie came in, but the handler never read the session.
      await client.request("/anon");
      expect(commit).toHaveBeenCalledTimes(1);
      await client.request("/sign-in", { method: "POST" });
      expect(commit).toHaveBeenCalledTimes(2);
    } finally {
      commit.mockRestore();
    }
  });
});
