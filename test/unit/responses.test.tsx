import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  YerdError, catches, get, post, res, route, setHeader, signal, status, yerd,
  type LayoutProps, type RunningServer, type YerdContext,
} from "@toyz/yerd";
import { currentContext } from "../../src/server/context.js";

class NotFound extends Error {
  constructor(readonly what: string) {
    super(`${what} not found`);
  }
}
class Flaky extends Error {}

function Root({ children }: LayoutProps) {
  return <html><body>{children}</body></html>;
}

@route("/things")
class Things {
  @signal accessor stop!: AbortSignal;

  @post @status(201) @setHeader("cache-control", "no-store")
  create() {
    return { id: 1 };
  }

  @get show() {
    const ctx: YerdContext = currentContext();
    ctx.setHeader("x-trace", "abc");
    ctx.setCookie("seen", "yes", { maxAge: 60 });
    ctx.deleteCookie("old");
    ctx.status(202);
    return "accepted";
  }

  @catches(NotFound)
  missing(error: NotFound) {
    return <p>no {error.what} here</p>;
  }
}

@route("/explicit")
class Explicit {
  @get @status(201) show() {
    return res("made", { status: 200, cookies: [{ name: "theme", value: "dark", sameSite: "Strict" }] });
  }
}

@route("/lost/:what")
class Lost {
  @get find(): never {
    throw new NotFound("cat");
  }

  @catches(NotFound)
  missing(error: NotFound) {
    return <p>no {error.what} here</p>;
  }
}

@route("/recover")
class Recover {
  @get boom(): never {
    throw new Flaky("flaked");
  }

  // Handles everything, but only flaky errors become a 200 with a fallback.
  @catches()
  fallback(error: unknown) {
    if (error instanceof Flaky) return res("served from cache", { status: 200 });
    return undefined;
  }
}

@route("/nobody")
class Nobody {
  @get boom(): never {
    throw new YerdError(409, "conflict");
  }
}

@route("/cookie-then-401")
class CookieThen401 {
  @get show(): never {
    currentContext().setCookie("attempt", "1");
    throw new YerdError(401, "sign in");
  }
}

let server: RunningServer;
beforeAll(async () => {
  server = await yerd({ routes: [Things, Explicit, Lost, Recover, Nobody, CookieThen401], services: [], handleSignals: false })
    .layout(Root)
    .onError((error) => (error instanceof YerdError && error.status === 409 ? { error: "app-level", status: 409 } : undefined))
    .listen(0, "127.0.0.1");
});
afterAll(() => server.close());

describe("response defaults", () => {
  it("@status and @setHeader shape the coerced result", async () => {
    const r = await fetch(server.url + "/things", { method: "POST" });
    expect(r.status).toBe(201);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ id: 1 });
  });

  it("ctx.setHeader / setCookie / deleteCookie / status from inside a handler", async () => {
    const r = await fetch(server.url + "/things");
    expect(r.status).toBe(202);
    expect(r.headers.get("x-trace")).toBe("abc");
    const cookies = r.headers.getSetCookie();
    expect(cookies[0]).toBe("seen=yes; Max-Age=60; Path=/; HttpOnly; SameSite=Lax");
    expect(cookies[1]).toMatch(/^old=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=\//);
  });

  it("an explicit res() status wins over @status, and res() sets cookies", async () => {
    const r = await fetch(server.url + "/explicit");
    expect(r.status).toBe(200);
    expect(r.headers.getSetCookie()).toEqual(["theme=dark; Path=/; HttpOnly; SameSite=Strict"]);
  });

  it("cookies set before an error still go out", async () => {
    const r = await fetch(server.url + "/cookie-then-401");
    expect(r.status).toBe(401);
    expect(r.headers.getSetCookie()).toEqual(["attempt=1; Path=/; HttpOnly; SameSite=Lax"]);
  });
});

describe("@catches and onError", () => {
  it("renders the route's handler in its layouts, with the error's status", async () => {
    const r = await fetch(server.url + "/lost/cat");
    expect(r.status).toBe(500);
    expect(await r.text()).toBe("<!doctype html><html><body><p>no cat here</p></body></html>");
  });

  it("lets a handler choose the status, or pass the error on", async () => {
    const r = await fetch(server.url + "/recover");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("served from cache");
  });

  it("falls back to app.onError, which also sees 404s", async () => {
    const r = await fetch(server.url + "/nobody");
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "app-level", status: 409 });
    expect((await fetch(server.url + "/no-such-page")).status).toBe(404);
  });
});
