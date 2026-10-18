import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BootError, ConsoleLogger, ILogger, LogFilter, Logger, get, instrument, log, logger, route, service, teeLogger, yerd,
  type LogRecord,
} from "@toyz/yerd";
import { parameterNames } from "../../src/log/instrument.js";
import { errorInfo, safeFields, safeValue } from "../../src/log/serialize.js";

/** Run `fn` inside an app whose sink collects records, at `filter`. */
async function capture(fn: () => unknown, filter = "trace"): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  const app = yerd({ routes: [], services: [] })
    .services((s) => s.value(ILogger, { write: (r) => records.push(r) }))
    .logging({ filter });
  await app.scope(fn);
  return records;
}

const savedEnv = { YERD_LOG: process.env.YERD_LOG, YERD_LOG_FORMAT: process.env.YERD_LOG_FORMAT };
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

describe("LogFilter directives", () => {
  it.each([
    ["", "info", "app", true],
    ["", "debug", "app", false],
    ["warn", "info", "app", false],
    ["WARN", "warn", "app", true],
    ["  debug  ", "debug", "app", true],
    ["off", "error", "app", false],
    ["trace", "trace", "anything::deep", true],
    ["info,warn", "info", "app", false],
    ["warn,info", "info", "app", true],
    ["warn,Repo=debug", "debug", "Repo", true],
    ["warn,Repo=debug", "debug", "Repo::sub", true],
    ["warn,Repo=debug", "debug", "RepoX", false],
    ["warn,Repo=debug", "debug", "MyRepo", false],
    ["warn , Repo = debug ", "debug", "Repo", true],
    ["info,yerd=warn", "info", "yerd::request", false],
    ["info,yerd=warn,yerd::request=info", "info", "yerd::request", true],
    ["info,yerd::request=info,yerd=warn", "info", "yerd::request", true],
    ["info,yerd::request=info,yerd=warn", "info", "yerd::boot", false],
    ["info,a::b=off", "error", "a::b::c", false],
    ["info,a::b=off", "error", "a", true],
    ["trace,Repo=off", "error", "Repo", false],
  ])("%j: %s for %s is %s", (source, level, target, expected) => {
    expect(new LogFilter(source).enabled(level as never, target)).toBe(expected);
  });

  it("lets a later directive for the same target override an earlier one, like the bare level", () => {
    // Appending to a default is how a deploy turns one class up: `$DEFAULTS,Repo=trace`.
    expect(new LogFilter("info,Repo=error,Repo=trace").enabled("trace", "Repo")).toBe(true);
    expect(new LogFilter("info,Repo=trace,Repo=error").enabled("warn", "Repo")).toBe(false);
    expect(new LogFilter("info,[s]=error,[s]=trace").enabled("trace", "x", ["s"])).toBe(true);
  });

  it.each([
    ["chatty"],
    ["info,Repo=chatty"],
    ["info,Repo="],
    ["info,[span]=nope"],
    ["verbose"],
  ])("refuses %j", (source) => {
    expect(() => new LogFilter(source)).toThrow(/Unknown log level/);
  });

  it("names the bad level in the error", () => {
    expect(() => new LogFilter("info,x=LOUD")).toThrow('Unknown log level "LOUD" in YERD_LOG');
  });

  it.each([
    ["info,[charge]=trace", "trace", ["request", "charge"], true],
    ["info,[charge]=trace", "trace", ["request"], false],
    ["info,[charge]=trace", "trace", [], false],
    ["debug,[noisy]=warn", "info", ["noisy"], false],
    ["debug,[noisy]=warn", "info", ["other"], true],
    ["warn,[outer]=trace,[inner]=error", "warn", ["outer", "inner"], false],
    ["warn,[outer]=error,[inner]=trace", "trace", ["outer", "inner"], true],
    ["warn,[outer]=error,[inner]=trace", "trace", ["inner", "outer"], false],
    ["warn,Repo=error,[s]=debug", "debug", ["s"], true],
    ["warn,[a=b]=debug", "debug", ["a=b"], true],
  ])("%j: %s inside %j is %s", (source, level, spans, expected) => {
    expect(new LogFilter(source).enabled(level as never, "Repo", spans)).toBe(expected);
  });

  it("reports whether span directives exist", () => {
    expect(new LogFilter("info,Repo=debug").hasSpanDirectives).toBe(false);
    expect(new LogFilter("info,[x]=debug").hasSpanDirectives).toBe(true);
  });

  it("keeps deciding correctly for more targets than its cache holds", () => {
    const filter = new LogFilter("warn,t500=debug");
    for (let i = 0; i < 2000; i++) expect(filter.enabled("debug", `t${i}`)).toBe(i === 500);
  });
});

describe("YERD_LOG and YERD_LOG_FORMAT", () => {
  it("YERD_LOG wins over app.logging()", async () => {
    process.env.YERD_LOG = "error";
    const records = await capture(() => {
      log.warn("hidden");
      log.error("shown");
    }, "trace");
    expect(records.map((r) => r.message)).toEqual(["shown"]);
  });

  it("a bad YERD_LOG is a boot error, listed with the other problems", async () => {
    process.env.YERD_LOG = "info,Repo=chatty";
    const error = await yerd({ routes: [], services: [] }).boot().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BootError);
    expect((error as BootError).problems).toContain('Unknown log level "chatty" in YERD_LOG (use trace, debug, info, warn, error or off)');
  });

  it.each([
    ["json", undefined, "json"],
    ["pretty", undefined, "pretty"],
    ["JSON", "pretty", "pretty"],
    ["xml", "json", "json"],
    [undefined, "pretty", "pretty"],
  ] as const)("YERD_LOG_FORMAT=%s with option %s gives %s (explicit option wins in the constructor)", (env, option, expected) => {
    if (env === undefined) delete process.env.YERD_LOG_FORMAT;
    else process.env.YERD_LOG_FORMAT = env;
    const sink = option ? new ConsoleLogger({ format: option }) : new ConsoleLogger();
    expect(sink.format).toBe(expected);
  });

  it("writes JSON lines: info batched to stdout, warn and error straight to stderr (flushing first)", () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (out.push(String(chunk)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (err.push(String(chunk)), true));
    const sink = new ConsoleLogger({ format: "json" });
    const base = { time: 0, target: "app", fields: {}, spans: [], kind: "event" as const };
    sink.write({ ...base, level: "info", message: "one" });
    sink.write({ ...base, level: "info", message: "two\nlines" });
    expect(out).toEqual([]);
    sink.write({ ...base, level: "error", message: "bad", traceId: "t" });
    expect(out).toHaveLength(1);
    const lines = out[0]!.trimEnd().split("\n");
    expect(lines.map((l) => JSON.parse(l).msg)).toEqual(["one", "two\nlines"]);
    expect(JSON.parse(err[0]!)).toEqual({ t: "1970-01-01T00:00:00.000Z", level: "error", target: "app", msg: "bad", trace: "t" });
  });

  it("flushes a full batch of 256 lines at once", () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (out.push(String(chunk)), true));
    const sink = new ConsoleLogger({ format: "json" });
    for (let i = 0; i < 256; i++) sink.write({ time: 0, level: "info", target: "a", message: `m${i}`, fields: {}, spans: [], kind: "event" });
    expect(out).toHaveLength(1);
    expect(out[0]!.trimEnd().split("\n")).toHaveLength(256);
  });

  it("quotes pretty field values with spaces, quotes, equals signs or newlines, so a value can't fake a field", () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (err.push(String(chunk)), true));
    const sink = new ConsoleLogger({ format: "pretty", color: false });
    sink.write({
      time: 0, level: "warn", target: "app", message: "m", spans: [], kind: "event",
      fields: { a: "plain", b: "x y", c: 'q"', d: "k=v", e: "line\nbreak", f: "", g: 3, h: null },
    });
    expect(err[0]).toContain(' a=plain b="x y" c="q\\"" d="k=v" e="line\\nbreak" f="" g=3 h=null (app)');
    expect(err[0]!.trimEnd().split("\n")).toHaveLength(1);
  });
});

describe("serialization and redaction", () => {
  it.each([
    "password", "Password", "PASSWORD", "userPassword", "password_hash", "hashedPassword", "passwd", "pwd", "pass",
    "secret", "clientSecret", "client_secret", "AWS_SECRET_ACCESS_KEY", "token", "accessToken", "refresh_token",
    "x-csrf-token", "idToken", "authorization", "Authorization", "proxy-authorization", "auth", "authHeader",
    "cookie", "set-cookie", "Cookies", "session", "sessionId", "session.id", "apiKey", "api_key", "APIKey",
    "x-api-key", "X-API-KEY", "apikey", "privateKey", "private_key", "credentials", "signature", "otp", "passphrase",
    "password2", "password_confirm2", "pass1", "token0", "apiKeys", "api_keys", "privateKeys", "secret_2",
  ])("redacts %s", (key) => {
    expect(safeFields({ [key]: "s3cr3t" })).toEqual({ [key]: "[redacted]" });
    expect(safeValue({ nested: { [key]: "s3cr3t" } })).toEqual({ nested: { [key]: "[redacted]" } });
  });

  it.each([
    "passengers", "tokenizer", "authorName", "author", "id", "username", "email", "keyboard",
    "apiVersion", "passage", "compass", "secretary", "monkey", "turnkey", "privateer", "v2",
  ])("keeps %s", (key) => {
    // `authorName` splits into "author name"; "author" isn't "auth".
    expect(safeFields({ [key]: "value" })).toEqual({ [key]: "value" });
  });

  it("redacts at every depth, through arrays, Maps and class instances", () => {
    class Creds {
      user = "ada";
      password = "x";
    }
    const value = {
      list: [{ token: "a" }, [{ secret: "b" }]],
      map: new Map<string, unknown>([["apiKey", "c"], ["ok", { cookie: "d" }]]),
      creds: new Creds(),
    };
    expect(safeValue(value)).toEqual({
      list: [{ token: "[redacted]" }, [{ secret: "[redacted]" }]],
      map: { apiKey: "[redacted]", ok: { cookie: "[redacted]" } },
      creds: { Creds: { user: "ada", password: "[redacted]" } },
    });
  });

  it("redacts a whole secret-named object, not just its leaves", () => {
    expect(safeFields({ auth: { user: "ada", pass: "x" } })).toEqual({ auth: "[redacted]" });
  });

  it.each([
    ["bigint", 10n, "10n"],
    ["negative bigint", -1n, "-1n"],
    ["symbol", Symbol("s"), "Symbol(s)"],
    ["named function", function named() {}, "[Function named]"],
    ["anonymous function", (() => () => {})(), "[Function anonymous]"],
    ["invalid date", new Date(Number.NaN), "Invalid Date"],
    ["date", new Date(0), "1970-01-01T00:00:00.000Z"],
    ["url", new URL("https://a.test/p?q=1"), "https://a.test/p?q=1"],
    ["buffer", Buffer.from("abc"), "[Buffer 3 bytes]"],
    ["array buffer", new ArrayBuffer(8), "[ArrayBuffer 8 bytes]"],
    ["data view", new DataView(new ArrayBuffer(2)), "[DataView 2 bytes]"],
    ["NaN", Number.NaN, Number.NaN],
    ["null", null, null],
    ["undefined", undefined, undefined],
  ])("%s", (_label, value, expected) => {
    expect(safeValue(value)).toEqual(expected);
  });

  it("summarizes an Error as name and message only (no cause, no own properties that could hold secrets)", () => {
    const error = Object.assign(new Error("outer", { cause: new Error("inner token=abc") }), { config: { headers: { authorization: "x" } } });
    expect(safeValue({ error })).toEqual({ error: { name: "Error", message: "outer" } });
    expect(errorInfo(error)).toEqual({ name: "Error", message: "outer", stack: error.stack });
  });

  it("describes non-Error throws safely", () => {
    expect(errorInfo("plain")).toEqual({ name: "Error", message: "plain" });
    expect(errorInfo({ password: "x" })).toEqual({ name: "Error", message: "[object Object]" });
    expect(errorInfo(undefined)).toEqual({ name: "Error", message: "undefined" });
  });

  it("marks only real cycles as circular; a shared object seen twice is shown twice", () => {
    const shared = { n: 1 };
    expect(safeValue({ a: shared, b: shared })).toEqual({ a: { n: 1 }, b: { n: 1 } });
    const loop: unknown[] = [];
    loop.push(loop);
    expect(safeValue(loop)).toEqual(["[Circular]"]);
    const m = new Map<string, unknown>();
    m.set("self", m);
    expect(safeValue(m)).toEqual({ self: "[Circular]" });
  });

  it("bounds depth, arrays, keys and strings", () => {
    expect(safeValue({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({ a: { b: { c: { d: "[Object]" } } } });
    expect(safeValue([[[[[1, 2]]]]])).toEqual([[[["[Array(2)]"]]]]);
    const wide = Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`k${i}`, i]));
    const out = safeValue(wide) as Record<string, unknown>;
    expect(Object.keys(out)).toHaveLength(31);
    expect(out["..."]).toBe("5 more keys");
    expect(safeValue(Array.from({ length: 25 }, (_, i) => i))).toEqual([...Array.from({ length: 20 }, (_, i) => i), "... 5 more"]);
    expect(safeValue("x".repeat(256))).toBe("x".repeat(256));
    expect(safeValue("x".repeat(257))).toBe(`${"x".repeat(256)}... (257 chars)`);
    expect((safeValue(new Set(Array.from({ length: 1000 }, (_, i) => i))) as unknown[]).at(-1)).toBe("... 980 more");
  });

  it("never throws, even on a revoked proxy or an object whose prototype lookups throw", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error("no keys"); }, getPrototypeOf: () => { throw new Error("no proto"); } });
    expect(() => safeValue(proxy)).not.toThrow();
    expect(safeFields({ p: proxy, h: hostile, ok: 1 })).toEqual({ p: "[unserializable]", h: "[unserializable]", ok: 1 });
  });

  it("a log call with a hostile field still writes the record", async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const records = await capture(() => log.info("still logged", { proxy, n: 1 }));
    expect(records.map((r) => [r.message, r.fields])).toEqual([["still logged", { proxy: "[unserializable]", n: 1 }]]);
  });

  it("uses a plain object for null-prototype objects and odd constructors", () => {
    expect(safeValue(Object.assign(Object.create(null), { a: 1 }))).toEqual({ a: 1 });
    expect(safeValue({ constructor: "not a class", a: 1 })).toEqual({ constructor: "not a class", a: 1 });
  });
});

describe("Logger facade", () => {
  it("writes the level, target, bound and call fields; the call wins over bound ones", async () => {
    const records = await capture(() => {
      const base = new Logger("Billing", { region: "eu" });
      base.child({ orderId: 1 }).info("charging", { orderId: 2, total: 5 });
      base.for("Other").debug("moved");
    });
    expect(records.map((r) => [r.level, r.target, r.message, r.fields])).toEqual([
      ["info", "Billing", "charging", { region: "eu", orderId: 2, total: 5 }],
      ["debug", "Other", "moved", { region: "eu" }],
    ]);
  });

  it.each([
    ["an Error", () => log.error(new Error("boom")), "boom", {}, "boom"],
    ["a string", () => log.error("failed"), "failed", {}, undefined],
    ["a message and an error field", () => log.error("failed", { id: 1, error: new Error("why") }), "failed", { id: 1 }, "why"],
    ["a non-Error error field", () => log.error("failed", { error: "text" }), "failed", { error: "text" }, undefined],
    ["a thrown string", () => log.error(42), "42", {}, "42"],
  ])("log.error with %s", async (_label, call, message, fields, errorMessage) => {
    const records = await capture(call);
    expect(records).toHaveLength(1);
    expect([records[0]!.message, records[0]!.fields, records[0]!.error?.message]).toEqual([message, fields, errorMessage]);
  });

  it("enabled() follows the filter and the current span", async () => {
    const seen: boolean[] = [];
    await capture(() => {
      const l = new Logger("Quiet");
      seen.push(l.enabled("debug"));
      l.span("loud", {}, () => seen.push(l.enabled("debug")), "error");
    }, "info,[loud]=trace");
    expect(seen).toEqual([false, true]);
  });

  it("span() nests across await and records the duration; a throw is logged and rethrown", async () => {
    const records = await capture(async () => {
      await log.span("outer", { a: 1 }, async () => {
        await new Promise((r) => setTimeout(r, 2));
        await log.span("inner", {}, async () => log.info("deep"));
      });
      await expect(log.span("failing", {}, async () => { throw new Error("x"); })).rejects.toThrow("x");
    });
    const deep = records.find((r) => r.message === "deep")!;
    expect(deep.spans.map((s) => s.name)).toEqual(["outer", "inner"]);
    expect(deep.spans[0]!.fields).toEqual({ a: 1 });
    const outerExit = records.find((r) => r.kind === "span-exit" && r.message === "outer")!;
    expect(outerExit.durationMs).toBeGreaterThan(0);
    const failed = records.find((r) => r.kind === "span-exit" && r.message === "failing")!;
    expect([failed.level, failed.error?.message]).toEqual(["error", "x"]);
    // Every record shares one trace id per root span.
    expect(new Set(records.filter((r) => r.spans[0]?.name === "outer").map((r) => r.traceId)).size).toBe(1);
  });

  it("@logger uses the class name, an explicit name, and refuses assignment", () => {
    class Billing {
      @logger accessor log!: Logger;
      @logger("payments") accessor named!: Logger;
    }
    const b = new Billing();
    expect(b.log.target).toBe("Billing");
    expect(b.log).toBe(b.log);
    expect(b.named.target).toBe("payments");
    expect(() => {
      (b as { log: Logger }).log = new Logger();
    }).toThrow("@logger fields are read-only");
  });

  it("@logger strips a bundler's $N suffix from the class name", () => {
    const Renamed = class {
      @logger accessor log!: Logger;
    };
    Object.defineProperty(Renamed, "name", { value: "TodoList$1" });
    expect(new Renamed().log.target).toBe("TodoList");
  });
});

describe("sinks", () => {
  it("a throwing sink never breaks the caller; it's reported on console.error", async () => {
    const reported: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => void reported.push(a));
    const app = yerd({ routes: [], services: [] })
      .services((s) => s.value(ILogger, { write: () => { throw new Error("disk full"); } }))
      .logging({ filter: "trace" });
    await app.scope(() => log.info("x"));
    expect(reported).toHaveLength(1);
    expect(String((reported[0] as unknown[])[0])).toContain("the logger failed");
  });

  it("a request still succeeds when the sink throws on every record", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    @route("/ok")
    class Ok {
      @get show() {
        log.info("inside");
        return "fine";
      }
    }
    const server = await yerd({ routes: [Ok], services: [], handleSignals: false })
      .services((s) => s.value(ILogger, { write: () => { throw new Error("broken"); } }))
      .logging({ filter: "trace" })
      .listen(0, "127.0.0.1");
    try {
      const r = await fetch(server.url + "/ok");
      expect([r.status, await r.text()]).toEqual([200, "fine"]);
    } finally {
      await server.close();
    }
  });

  it("teeLogger delivers to every sink even when one throws, then reports the failure", () => {
    const a: string[] = [];
    const c: string[] = [];
    const tee = teeLogger(
      { write: (r) => void a.push(r.message) },
      { write: () => { throw new Error("b down"); } },
      { write: (r) => void c.push(r.message) },
    );
    const record: LogRecord = { time: 0, level: "info", target: "t", message: "m", fields: {}, spans: [], kind: "event" };
    expect(() => tee.write(record)).toThrow("b down");
    expect([a, c]).toEqual([["m"], ["m"]]);
  });

  it("teeLogger flushes every sink, even if one throws synchronously or rejects", async () => {
    const flushed: string[] = [];
    const tee = teeLogger(
      { write() {}, flush: () => { throw new Error("sync"); } },
      { write() {}, flush: async () => { flushed.push("b"); } },
      { write() {}, flush: async () => { throw new Error("async"); } },
      { write() {}, flush: () => void flushed.push("d") },
      { write() {} },
    );
    await expect(tee.flush!()).rejects.toThrow("sync");
    expect(flushed.sort()).toEqual(["b", "d"]);
  });

  it("flushes the sink when the app stops", async () => {
    let flushed = 0;
    const app = yerd({ routes: [], services: [] }).services((s) => s.value(ILogger, { write() {}, flush: () => void flushed++ }));
    await app.start();
    await app.stop();
    expect(flushed).toBe(1);
  });

  it("refuses a non-singleton ILogger", async () => {
    @service({ lifetime: "scoped", provides: ILogger })
    class ScopedSink implements ILogger {
      write() {}
    }
    await expect(yerd({ routes: [], services: [ScopedSink] }).boot()).rejects.toThrow("ILogger must be a singleton service");
  });
});

describe("request spans", () => {
  async function requestWith(headers: Record<string, string>, filter = "info") {
    const records: LogRecord[] = [];
    @route("/r")
    class R {
      @get show() {
        log.info("inside");
        return "ok";
      }
    }
    @route("/missing-thing")
    class Missing {
      @get show() {
        return 404;
      }
    }
    @route("/crash")
    class Crash {
      @get show(): never {
        throw new Error("x");
      }
    }
    const server = await yerd({ routes: [R, Missing, Crash], services: [], handleSignals: false })
      .services((s) => s.value(ILogger, { write: (r) => records.push(r) }))
      .logging({ filter })
      .listen(0, "127.0.0.1");
    try {
      const responses = [];
      for (const path of ["/r", "/missing-thing", "/crash"]) responses.push(await fetch(server.url + path, { headers }));
      await new Promise((r) => setTimeout(r, 5));
      return { responses, records };
    } finally {
      await server.close();
    }
  }

  it.each([
    ["req-1", "req-1"],
    ["a.b:c@d_e-f", "a.b:c@d_e-f"],
    ["x".repeat(128), "x".repeat(128)],
    ["x".repeat(129), undefined],
    ["has space", undefined],
    ["<script>", undefined],
    ["quote\"", undefined],
    ["", undefined],
  ])("x-request-id %j is reused only if well formed", async (given, expected) => {
    const { responses, records } = await requestWith({ "x-request-id": given });
    const id = responses[0]!.headers.get("x-request-id")!;
    if (expected) expect(id).toBe(expected);
    else expect(id).toMatch(/^[0-9a-f]{16}$/);
    const inside = records.find((r) => r.message === "inside")!;
    expect(inside.spans[0]!.id).toBe(id);
  });

  it.each([
    ["00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", "4bf92f3577b34da6a3ce929d0e0e4736"],
    ["00-00000000000000000000000000000000-00f067aa0ba902b7-01", undefined],
    ["00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01", undefined],
    ["01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", undefined],
    ["00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7", undefined],
    ["garbage", undefined],
  ])("traceparent %j continues the trace only if valid", async (traceparent, expected) => {
    const { records } = await requestWith({ traceparent });
    // Three requests: one continued trace, or three fresh ones.
    const traces = new Set(records.map((r) => r.traceId));
    expect(traces.size).toBe(expected ? 1 : 3);
    const first = records.find((r) => r.message === "inside")!.traceId!;
    if (expected) expect(first).toBe(expected);
    else expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toBe("0".repeat(32));
  });

  it("logs the access line at info, warn and error by status", async () => {
    const { records } = await requestWith({});
    const access = records.filter((r) => r.target === "yerd::request" && r.kind === "span-exit");
    expect(access.map((r) => [r.spans[0]!.fields.path, r.fields.status, r.level])).toEqual([
      ["/r", 200, "info"],
      ["/missing-thing", 404, "warn"],
      ["/crash", 500, "error"],
    ]);
  });

  it("creates no request span (and no x-request-id) when yerd::request is below info", async () => {
    const { responses, records } = await requestWith({}, "info,yerd::request=warn");
    expect(responses[0]!.headers.get("x-request-id")).toBeNull();
    const inside = records.find((r) => r.message === "inside")!;
    expect(inside.spans).toEqual([]);
    expect(inside.traceId).toBeUndefined();
  });

  it("logs the path without the query string (which may hold tokens)", async () => {
    const records: LogRecord[] = [];
    @route("/q")
    class Q {
      @get show() {
        return "ok";
      }
    }
    const server = await yerd({ routes: [Q], services: [], handleSignals: false })
      .services((s) => s.value(ILogger, { write: (r) => records.push(r) }))
      .logging({ filter: "info" })
      .listen(0, "127.0.0.1");
    try {
      await fetch(server.url + "/q?token=abc&reset=1");
      await new Promise((r) => setTimeout(r, 5));
    } finally {
      await server.close();
    }
    const access = records.find((r) => r.target === "yerd::request")!;
    expect(access.spans[0]!.fields).toEqual({ method: "GET", path: "/q" });
    expect(JSON.stringify(records)).not.toContain("abc");
  });
});

describe("@instrument edge cases", () => {
  it("records arguments, nested skips, positional skips and array paths, without touching the arguments", async () => {
    class Accounts {
      @instrument({ skip: ["input.billing.cvc", "1.headers.x", "input.items.0.code", "2"] })
      create(input: { email: string; billing: { cvc: string; zip: string }; items: { code: string }[] }, req: { headers: { x: string; y: string } }, _drop: string) {
        return input.email;
      }

      @instrument({ skip: ["list.1"] })
      many(list: string[]) {
        return list.length;
      }
    }
    // Names unlike the parameters', or esbuild renames the parameters (`input2`).
    const signup = { email: "a@b.c", billing: { cvc: "123", zip: "9" }, items: [{ code: "c1" }, { code: "c2" }] };
    const incoming = { headers: { x: "1", y: "2" } };
    const names = ["a", "b", "c"];
    const records = await capture(() => {
      new Accounts().create(signup, incoming, "gone");
      new Accounts().many(names);
    });
    const enters = records.filter((r) => r.kind === "span-enter");
    expect(enters.map((r) => r.spans.at(-1)!.fields)).toEqual([
      {
        input: { email: "a@b.c", billing: { zip: "9" }, items: [{}, { code: "c2" }] },
        req: { headers: { y: "2" } },
      },
      { list: ["a", "[skipped]", "c"] },
    ]);
    expect(signup.billing.cvc).toBe("123");
    expect(signup.items[0]).toEqual({ code: "c1" });
    expect(incoming.headers.x).toBe("1");
    expect(names).toEqual(["a", "b", "c"]);
  });

  it("a whole-argument skip wins over nested skips of the same argument, in either order", async () => {
    class A {
      @instrument({ skip: ["opts.a", "opts"] }) one(opts: { a: number; b: number }) { return opts.b; }
      @instrument({ skip: ["opts", "opts.a"] }) two(opts: { a: number; b: number }) { return opts.b; }
    }
    const records = await capture(() => {
      new A().one({ a: 1, b: 2 });
      new A().two({ a: 1, b: 2 });
    });
    const enters = records.filter((r) => r.kind === "span-enter");
    expect(enters.map((r) => r.spans.at(-1)!.fields)).toEqual([{}, {}]);
  });

  it("skipping a path through a missing or primitive value is harmless", async () => {
    class A {
      @instrument({ skip: ["opts.deep.secretish"] }) run(opts: { deep?: { secretish: string } | number }) { return 1; }
    }
    const records = await capture(() => {
      new A().run({});
      new A().run({ deep: 5 });
      new A().run(undefined as never);
    });
    expect(records.filter((r) => r.kind === "span-enter").map((r) => r.spans.at(-1)!.fields)).toEqual([
      { opts: {} },
      { opts: { deep: 5 } },
      { opts: undefined },
    ]);
  });

  it("redacts secret-named parameters even without skip", async () => {
    class Auth {
      @instrument() login(user: string, password: string, apiKey: string) { return user; }
    }
    const records = await capture(() => new Auth().login("ada", "hunter2", "k"));
    expect(records[0]!.spans.at(-1)!.fields).toEqual({ user: "ada", password: "[redacted]", apiKey: "[redacted]" });
  });

  it("maps names to the right positions when a default value holds commas, brackets or quotes", async () => {
    class Csv {
      @instrument({ skip: ["password"] })
      run(sep = ",", quote = "'(", password = "", tail = `a,b)`) {
        return [sep, quote, password, tail].length;
      }
    }
    const records = await capture(() => new Csv().run(";", "q", "hunter2", "t"));
    const fields = records[0]!.spans.at(-1)!.fields;
    expect(fields).toEqual({ sep: ";", quote: "q", tail: "t" });
    expect(JSON.stringify(records)).not.toContain("hunter2");
  });

  it.each([
    [function f(a = "x,y", b = 1) { return [a, b]; }, ["a", "b"]],
    [function f(a = 'it\'s, ok', b = 2) { return [a, b]; }, ["a", "b"]],
    [function f(a = "(", b = ")") { return [a, b]; }, ["a", "b"]],
    [function f(a = `${1},${2}`, b = 3) { return [a, b]; }, ["a", "b"]],
    [function f(a = [1, 2], { c } = { c: 1 }, ...rest: number[]) { return [a, c, rest]; }, ["a", "arg1", "arg2"]],
    [function f(a = (() => 1)(), b = 2) { return [a, b]; }, ["a", "b"]],
    [async function f(id: number) { return id; }, ["id"]],
    [(x: number, y: number) => x + y, ["x", "y"]],
  ])("parameterNames(%s)", (fn, names) => {
    expect(parameterNames(fn as Function)).toEqual(names);
  });

  it("matches a skip name a compiler renamed with a number suffix, but not an ambiguous one", () => {
    expect(() => {
      class A {
        @instrument({ skip: ["input"] as never }) run(..._a: unknown[]) {}
      }
      void A;
    }).toThrow(/has no parameter "input"/);
    // parameterNames reads `input2` as a parameter; `input` then finds it.
    const fn = { run(input2: string) { return input2; } }.run;
    expect(parameterNames(fn)).toEqual(["input2"]);
  });

  it.each([
    [["nope"], /has no parameter "nope"/],
    [["5"], /has no parameter "5"/],
    [["nope.deep"], /has no parameter "nope"/],
  ])("refuses skip %j when the class loads", (skip, message) => {
    expect(() => {
      class A {
        @instrument({ skip: skip as never }) run(a: number, b: number) { return a + b; }
      }
      void A;
    }).toThrow(message);
  });

  it("keeps sync methods sync, async methods async, and this intact", async () => {
    class S {
      factor = 3;
      @instrument() sync(n: number) { return n * this.factor; }
      @instrument() async later(n: number) { await new Promise((r) => setTimeout(r, 1)); return n * this.factor; }
    }
    const records = await capture(async () => {
      const s = new S();
      const value = s.sync(2);
      expect(value).toBe(6);
      const promise = s.later(2);
      expect(promise).toBeInstanceOf(Promise);
      expect(await promise).toBe(6);
    });
    const exits = records.filter((r) => r.kind === "span-exit");
    expect(exits.map((r) => [r.message, r.fields])).toEqual([
      ["S::sync", { ret: 6 }],
      ["S::later", { ret: 6 }],
    ]);
  });

  it("logs sync and async throws at error and rethrows the same error object", async () => {
    const boom = new Error("boom");
    class T {
      @instrument() sync(): never { throw boom; }
      @instrument() async later(): Promise<never> { throw boom; }
      @instrument({ err: false }) quiet(): never { throw boom; }
    }
    const records = await capture(async () => {
      const t = new T();
      let caught: unknown;
      try { t.sync(); } catch (e) { caught = e; }
      expect(caught).toBe(boom);
      await expect(t.later()).rejects.toBe(boom);
      expect(() => t.quiet()).toThrow(boom);
    });
    const exits = records.filter((r) => r.kind === "span-exit");
    expect(exits.map((r) => [r.message, r.level, r.error?.message])).toEqual([
      ["T::sync", "error", "boom"],
      ["T::later", "error", "boom"],
      ["T::quiet", "debug", undefined],
    ]);
  });

  it("honours name, target, level, skipAll, ret and fields", async () => {
    class O {
      @instrument({ name: "custom", target: "billing", level: "info", skipAll: true, ret: false, fields: (self: O, [n]) => ({ doubled: (n as number) * 2, who: self.who }) })
      run(n: number, password: string) { return n + password.length; }
      who = "o";
    }
    const records = await capture(() => new O().run(2, "secret"), "warn,billing=info");
    expect(records.map((r) => [r.kind, r.message, r.target, r.level, r.fields])).toEqual([
      ["span-enter", "custom", "billing", "info", {}],
      ["span-exit", "custom", "billing", "info", {}],
    ]);
    expect(records[0]!.spans.at(-1)!.fields).toEqual({ doubled: 4, who: "o" });
  });

  it("captures nothing and calls the method directly when its level is off", async () => {
    let read = 0;
    class Q {
      @instrument({ fields: () => (read++, {}) }) run() { return "ran"; }
    }
    const records = await capture(() => expect(new Q().run()).toBe("ran"), "info");
    expect(records).toEqual([]);
    expect(read).toBe(0);
  });

  it("an undefined return adds no ret field; a returned secret-keyed object is redacted", async () => {
    class R {
      @instrument() none() {}
      @instrument() creds() { return { user: "ada", token: "t" }; }
    }
    const records = await capture(() => {
      new R().none();
      new R().creds();
    });
    const exits = records.filter((r) => r.kind === "span-exit");
    expect(exits.map((r) => r.fields)).toEqual([{}, { ret: { user: "ada", token: "[redacted]" } }]);
  });
});
