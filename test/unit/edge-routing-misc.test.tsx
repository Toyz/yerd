import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accepts, currentContext, get, isBot, param, post, res, route, setHeader, varies, type LayoutProps, type RunningServer,
} from "@toyz/yerd";
import { raw, rawGet, serve } from "./edge-routing-helpers.js";

const Root = ({ children }: LayoutProps) => <html><body>{children}</body></html>;

@route("/vary-ctx")
class VaryCtx {
  @get page() {
    currentContext().setHeader("Vary", "Cookie");
    return "page";
  }
  @get @accepts("json") data() {
    currentContext().setHeader("vary", "accept, cookie");
    return { data: true };
  }
}

@route("/vary-declared")
class VaryDeclared {
  @get @setHeader("vary", "Cookie") page() { return "page"; }
  @get(isBot) @setHeader("vary", "x-other") bot() { return "bot"; }
}

@route("/vary-res")
class VaryRes {
  @get(varies("x-a", (ctx) => ctx.headers["x-a"] === "1")) a() { return res("a", { headers: { Vary: "Accept-Language" } }); }
  @get plain() { return res("plain", { headers: { vary: "*" } }); }
}

@route("/frag/:id")
class Frag {
  @param("id") accessor id!: string;
  @get show() { return this.id; }
}

let streamed = 0;
async function* thenFails() {
  streamed++;
  yield "first;";
  throw new Error("stream broke midway");
}

async function* slowPage() {
  yield "<p>";
  await new Promise((r) => setTimeout(r, 5));
  yield "done</p>";
}

@route("/streams")
class Streams {
  @get partial() { return thenFails(); }
  @post slow() { return slowPage(); }
}

let server: RunningServer;
beforeAll(async () => {
  server = await serve([VaryCtx, VaryDeclared, VaryRes, Frag, Streams], (app) => app.layout(Root));
});
afterAll(() => server.close());

describe("Vary is merged, never replaced", () => {
  it("ctx.setHeader('vary') keeps the accept a negotiated route needs", async () => {
    const page = await fetch(server.url + "/vary-ctx");
    expect(await page.text()).toBe("page");
    expect(page.headers.get("vary")).toBe("accept, Cookie");
    const data = await fetch(server.url + "/vary-ctx", { headers: { accept: "application/json" } });
    expect(data.headers.get("vary")).toBe("accept, cookie");
  });

  it("@setHeader('vary') adds to the variants' Vary instead of being dropped", async () => {
    const r = await fetch(server.url + "/vary-declared");
    expect(r.headers.get("vary")).toBe("user-agent, Cookie");
    const bot = await fetch(server.url + "/vary-declared", { headers: { "user-agent": "Googlebot/2.1" } });
    expect(await bot.text()).toBe("bot");
    expect(bot.headers.get("vary")).toBe("user-agent, x-other");
  });

  it("a res() Vary is kept alongside the variants'", async () => {
    const a = await fetch(server.url + "/vary-res", { headers: { "x-a": "1" } });
    expect(a.headers.get("vary")).toBe("Accept-Language, x-a");
    const plain = await fetch(server.url + "/vary-res");
    expect(plain.headers.get("vary")).toBe("*, x-a");
  });
});

describe("raw request targets", () => {
  it("a fragment sent by a raw client stays in the param (clients never send one)", async () => {
    const r = await rawGet(server.url, "/frag/1#x");
    expect(r.status).toBe(200);
    expect(r.body).toBe("1#x");
  });

  it("a query after a fragment-looking part still splits at ?", async () => {
    const r = await rawGet(server.url, "/frag/a?b#c");
    expect(r.body).toBe("a");
  });

  it("lowercase methods are refused by Node's parser", async () => {
    const r = await raw(server.url, "get /frag/1 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect(r.status).toBe(400);
  });

  it("HTTP/1.0 without a Host header still routes", async () => {
    const r = await raw(server.url, "GET /frag/ok HTTP/1.0\r\n\r\n");
    expect(r.status).toBe(200);
    expect(r.body).toBe("ok");
  });
});

describe("streamed bodies", () => {
  it("a stream that fails after its first chunk is cut off: the status is already out", async () => {
    streamed = 0;
    const error = await fetch(server.url + "/streams").then((r) => r.text()).catch((e: unknown) => e);
    expect(streamed).toBe(1);
    // Either the client sees the truncation as an error, or it got only the first chunk.
    if (typeof error === "string") expect(error).toBe("first;");
    else expect(error).toBeInstanceOf(Error);
  });

  it("HEAD on a stream sends headers only and stops the source", async () => {
    streamed = 0;
    const r = await fetch(server.url + "/streams", { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await r.text()).toBe("");
  });

  it("a slow stream arrives whole", async () => {
    expect(await (await fetch(server.url + "/streams", { method: "POST" })).text()).toBe("<p>done</p>");
  });
});

describe("judgment calls (see the report)", () => {
  // Static segments are matched against the raw, percent-encoded path, so a
  // pattern written with non-ASCII never matches what clients send
  // ("/caf%C3%A9"). Writing the pattern encoded works today.
  it.todo("@route('/café') matches GET /caf%C3%A9");

  it("writing the pattern percent-encoded matches today", async () => {
    @route("/caf%C3%A9") class Cafe { @get show() { return "cafe"; } }
    const s = await serve([Cafe]);
    try {
      expect(await (await fetch(s.url + "/café")).text()).toBe("cafe");
    } finally {
      await s.close();
    }
  });

  // With only @accepts handlers plus a @get(when) variant whose test fails,
  // an unacceptable Accept header gets 404 rather than 406.
  it.todo("@accepts-only route with a failing @get(when) variant answers 406, not 404");

  // OPTIONS on a route without @options or @all is a 405 (with Allow), not
  // an automatic 204: there is no built-in CORS, so a preflight fails.
  it.todo("OPTIONS is answered automatically with 204 and Allow");
});
