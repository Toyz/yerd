import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HttpError, ILogger, LogFilter, get, log, route, toNumber, yerd, type LogRecord } from "@toyz/yerd";
import { safeFields } from "../../src/log/serialize.js";
import { createAuth } from "@toyz/yerd/auth";

describe("log filters", () => {
  it("let a span directive quiet a span, not only open it up", () => {
    const filter = new LogFilter("debug,[noisy]=warn");
    expect(filter.enabled("debug", "Repo")).toBe(true);
    expect(filter.enabled("debug", "Repo", ["request", "noisy"])).toBe(false);
    expect(filter.enabled("warn", "Repo", ["request", "noisy"])).toBe(true);
  });

  it("only accept real level names", () => {
    expect(() => new LogFilter("constructor")).toThrow(/Unknown log level/);
    expect(() => new LogFilter("x=toString")).toThrow(/Unknown log level/);
  });
});

describe("toNumber", () => {
  it("takes decimal numbers only", () => {
    expect(toNumber("1.5")).toBe(1.5);
    expect(toNumber("-2e3")).toBe(-2000);
    for (const bad of ["Infinity", "0x10", "1e999", "", " ", "12abc"]) expect(() => toNumber(bad), bad).toThrow(HttpError);
  });
});

describe("listen()", () => {
  it("brackets an IPv6 host in the URL", async () => {
    @route("/fixes-ping")
    class Ping {
      @get ping() {
        return "pong";
      }
    }
    const server = await yerd({ routes: [Ping], services: [], handleSignals: false }).listen(0, "::1");
    try {
      expect(server.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
      expect(await (await fetch(server.url + "/fixes-ping")).text()).toBe("pong");
    } finally {
      await server.close();
    }
  });
});

describe("createAuth", () => {
  it("treats a load() that returns null as signed out", async () => {
    interface User {
      id: string;
    }
    const auth = createAuth<User>({ load: () => null as unknown as User, sessionKey: "fixes_uid" });
    @route("/fixes-private", { guards: [auth.required] })
    class Private {
      @get show() {
        return "secret";
      }
    }
    @route("/fixes-login")
    class Login {
      @get in() {
        auth.login({ id: "gone" });
        return "ok";
      }
    }
    const server = await yerd({ routes: [Private, Login], services: [], handleSignals: false })
      .sessions()
      .use(auth)
      .listen(0, "127.0.0.1");
    try {
      const login = await fetch(server.url + "/fixes-login");
      const cookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
      const r = await fetch(server.url + "/fixes-private", { headers: { cookie, accept: "application/json" } });
      expect(r.status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

describe("app.services", () => {
  it("constructs an old-style constructor function rather than calling it as a factory", async () => {
    function Clock(this: { now(): number }) {}
    Clock.prototype.now = () => 42;
    const app = yerd({ routes: [], services: [] }).services((s) => s.singleton(Clock as unknown as new () => { now(): number }));
    await app.boot();
    const clock = app.container.get(Clock as unknown as new () => { now(): number });
    expect(clock.now()).toBe(42);
  });
});

describe("redaction", () => {
  it("matches whole words of a key, not substrings", () => {
    expect(
      safeFields({ password: 1, csrfToken: 2, "x-api-key": 3, sessionId: 4, api_key: 5, passengers: 6, tokenizer: 7, author: 8 }),
    ).toEqual({
      password: "[redacted]", csrfToken: "[redacted]", "x-api-key": "[redacted]", sessionId: "[redacted]", api_key: "[redacted]",
      passengers: 6, tokenizer: 7, author: 8,
    });
  });
});

describe("app.static", () => {
  it("serves index.html for a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yerd-index-"));
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "index.html"), "<p>home</p>");
    writeFileSync(join(dir, "docs", "index.html"), "<p>docs</p>");
    const server = await yerd({ routes: [], services: [], handleSignals: false }).static("/", dir).listen(0, "127.0.0.1");
    try {
      expect(await (await fetch(server.url + "/")).text()).toBe("<p>home</p>");
      expect(await (await fetch(server.url + "/docs/")).text()).toBe("<p>docs</p>");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("YERD_LOG", () => {
  it("wins over app.logging({ filter }), so a deploy can change it", async () => {
    const before = process.env.YERD_LOG;
    process.env.YERD_LOG = "debug";
    try {
      const records: LogRecord[] = [];
      const app = yerd({ routes: [], services: [] })
        .logging({ filter: "error" })
        .services((s) => s.value(ILogger, { write: (r) => records.push(r) }));
      await app.scope(() => log.debug("visible"));
      expect(records.map((r) => r.message)).toEqual(["visible"]);
    } finally {
      if (before === undefined) delete process.env.YERD_LOG;
      else process.env.YERD_LOG = before;
    }
  });
});
