import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConsoleLogger, YerdError, ILogger, LogFilter, Logger, get, inject, instrument, log, logger, route, service, yerd,
  type LogRecord, type RunningServer,
} from "@toyz/yerd";
import { parameterNames } from "../../src/log/instrument.js";
import { safeFields, safeValue } from "../../src/log/serialize.js";

const records: LogRecord[] = [];
const sink: ILogger = { write: (r) => records.push(r) };

@service
class UserRepo {
  @logger accessor log!: Logger;

  @instrument()
  async find(id: number, opts: { password: string; deep: { token: string } }) {
    await new Promise((r) => setTimeout(r, 1));
    this.log.warn("user missing", { id, opts });
    return id === 7 ? { id, name: "ada" } : null;
  }

  @instrument({ skip: ["secretish"], ret: false, fields: (_self, [a]) => ({ doubled: (a as number) * 2 }) })
  sum(a: number, secretish: number) {
    return a + secretish;
  }

  @instrument()
  explode(): never {
    throw new Error("kaput");
  }
}

@route("/users/:id")
class UserPage {
  @inject(UserRepo) accessor repo!: UserRepo;
  @get async show() {
    return (await this.repo.find(7, { password: "hunter2", deep: { token: "abc" } })) ?? 404;
  }
}

@route("/boom")
class Boom {
  @get fail(): never {
    throw new Error("internal detail");
  }
}

@route("/teapot")
class Teapot {
  @get brew(): never {
    throw new YerdError(418, "short and stout");
  }
}

let server: RunningServer;
beforeAll(async () => {
  server = await yerd({ routes: [UserPage, Boom, Teapot], services: [UserRepo], handleSignals: false })
    .services((s) => s.value(ILogger, sink))
    .logging({ filter: "info,UserRepo=debug" })
    .listen(0, "127.0.0.1");
});
afterAll(() => server.close());

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("request logging", () => {
  it("writes one access record per request, with an id echoed as x-request-id", async () => {
    records.length = 0;
    const r = await fetch(server.url + "/users/7");
    await settle();
    const id = r.headers.get("x-request-id")!;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    const access = records.find((x) => x.target === "yerd::request" && x.kind === "span-exit")!;
    expect(access.level).toBe("info");
    expect(access.fields).toEqual({ status: 200 });
    expect(access.spans[0]).toEqual({ name: "request", id, fields: { method: "GET", path: "/users/7" } });
    expect(access.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps a well-formed incoming request id and continues traceparent", async () => {
    records.length = 0;
    const trace = "4bf92f3577b34da6a3ce929d0e0e4736";
    const r = await fetch(server.url + "/users/7", { headers: { "x-request-id": "req-123", traceparent: `00-${trace}-00f067aa0ba902b7-01` } });
    await settle();
    expect(r.headers.get("x-request-id")).toBe("req-123");
    expect(records.every((x) => x.traceId === trace)).toBe(true);
    const bad = await fetch(server.url + "/users/7", { headers: { "x-request-id": "no spaces or <script>" } });
    expect(bad.headers.get("x-request-id")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("nests a service's spans and events under the request span, across await", async () => {
    records.length = 0;
    await fetch(server.url + "/users/7");
    await settle();
    const enter = records.find((x) => x.kind === "span-enter" && x.message === "UserRepo::find")!;
    const event = records.find((x) => x.message === "user missing")!;
    const exit = records.find((x) => x.kind === "span-exit" && x.message === "UserRepo::find")!;
    expect(enter.spans.map((s) => s.name)).toEqual(["request", "UserRepo::find"]);
    expect(enter.spans[1]!.fields).toEqual({ id: 7, opts: { password: "[redacted]", deep: { token: "[redacted]" } } });
    expect(event.target).toBe("UserRepo");
    expect(event.spans.map((s) => s.name)).toEqual(["request", "UserRepo::find"]);
    expect(event.fields).toEqual({ id: 7, opts: { password: "[redacted]", deep: { token: "[redacted]" } } });
    expect(exit.fields).toEqual({ ret: { id: 7, name: "ada" } });
    expect(exit.durationMs).toBeGreaterThan(0);
  });

  it("logs crashes at error with the stack, 4xx at warn, and never the message to the client", async () => {
    records.length = 0;
    const r = await fetch(server.url + "/boom");
    expect(await r.text()).toBe("Internal Server Error");
    await fetch(server.url + "/teapot");
    await settle();
    const crash = records.find((x) => x.level === "error" && x.kind === "event")!;
    expect(crash.error?.message).toBe("internal detail");
    expect(crash.error?.stack).toContain("Boom.fail");
    expect(crash.spans[0]!.fields).toEqual({ method: "GET", path: "/boom" });
    const accesses = records.filter((x) => x.target === "yerd::request" && x.kind === "span-exit");
    expect(accesses.map((a) => [a.fields.status, a.level])).toEqual([[500, "error"], [418, "warn"]]);
  });
});

describe("@instrument", () => {
  it("skips, adds fields, leaves out the return value, and keeps sync methods sync", () => {
    records.length = 0;
    const repo = new UserRepo();
    // Outside a request the last booted app's sink and filter apply.
    const result = repo.sum(2, 40);
    expect(result).toBe(42);
    const enter = records.find((x) => x.kind === "span-enter" && x.message === "UserRepo::sum")!;
    expect(enter.spans.at(-1)!.fields).toEqual({ a: 2, doubled: 4 });
    const exit = records.find((x) => x.kind === "span-exit" && x.message === "UserRepo::sum")!;
    expect(exit.fields).toEqual({});
  });

  it("logs a throw at error and rethrows the original", () => {
    records.length = 0;
    const repo = new UserRepo();
    expect(() => repo.explode()).toThrow("kaput");
    const exit = records.find((x) => x.kind === "span-exit")!;
    expect(exit.level).toBe("error");
    expect(exit.error?.message).toBe("kaput");
  });

  it("doesn't capture anything when its level is off", async () => {
    let captured = 0;
    class Quiet {
      @instrument({ fields: () => ((captured++), {}) })
      run() {
        return "ran";
      }
    }
    // Quiet's target isn't in the filter, so debug is off for it.
    expect(new Quiet().run()).toBe("ran");
    expect(captured).toBe(0);
  });
});

describe("filters", () => {
  it("pick the most specific target, and span directives open everything inside", () => {
    const filter = new LogFilter("warn,UserRepo=debug,yerd=error,[charge]=trace");
    expect(filter.enabled("info", "app")).toBe(false);
    expect(filter.enabled("warn", "app")).toBe(true);
    expect(filter.enabled("debug", "UserRepo")).toBe(true);
    expect(filter.enabled("warn", "yerd::request")).toBe(false);
    expect(filter.enabled("trace", "Billing", ["request", "charge"])).toBe(true);
    expect(filter.enabled("trace", "Billing", ["request"])).toBe(false);
    expect(() => new LogFilter("loud")).toThrow(/Unknown log level/);
  });

  it("refuse to boot on a bad directive", async () => {
    await expect(yerd({ routes: [], services: [] }).logging({ filter: "info,x=chatty" }).boot()).rejects.toThrow(/Unknown log level "chatty"/);
  });
});

describe("serialization", () => {
  it("never throws and stays bounded on circular, huge and binary values", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(safeValue(circular)).toEqual({ a: 1, self: "[Circular]" });
    expect(String(safeValue("x".repeat(1000)))).toMatch(/\.\.\. \(1000 chars\)$/);
    expect(safeValue(new Uint8Array(4096))).toBe("[Uint8Array 4096 bytes]");
    expect((safeValue(Array.from({ length: 100 }, (_, i) => i)) as unknown[]).length).toBe(21);
    const throwing = { get boom() { throw new Error("no"); } };
    expect(safeValue(throwing)).toEqual({ boom: "[getter threw]" });
    expect(safeValue({ headers: { Authorization: "Bearer x", "x-api-key": "k", cookie: "c" } })).toEqual({
      headers: { Authorization: "[redacted]", "x-api-key": "[redacted]", cookie: "[redacted]" },
    });
  });

  it("redacts by key the same way before and after its key cache fills", () => {
    const keys = { password: "p", passengers: 2, apiKey: "k", tokenizer: "t", sessionId: "s" };
    const expected = { password: "[redacted]", passengers: 2, apiKey: "[redacted]", tokenizer: "t", sessionId: "[redacted]" };
    expect(safeFields(keys)).toEqual(expected);
    expect(safeFields(keys)).toEqual(expected);
    for (let i = 0; i < 1100; i++) safeFields({ [`field${i}x`]: i, [`secret${i}x`]: i });
    expect(safeFields({ ...keys, privateKeys: "pk", passengerCount: 3 })).toEqual({ ...expected, privateKeys: "[redacted]", passengerCount: 3 });
  });

  it("reads parameter names from compiled source", () => {
    expect(parameterNames(function find(id: number, opts = { a: [1, 2] }) { return [id, opts]; })).toEqual(["id", "opts"]);
    expect(parameterNames(({ a }: { a: number }, ...rest: number[]) => [a, rest])).toEqual(["arg0", "arg1"]);
    expect(parameterNames(async function load() {})).toEqual([]);
  });
});

describe("ConsoleLogger", () => {
  const record: LogRecord = {
    time: Date.UTC(2026, 9, 17, 12, 4, 1, 239),
    level: "warn",
    target: "UserRepo",
    message: "user missing",
    fields: { id: 7 },
    spans: [{ name: "request", id: "7f3a", fields: { method: "GET", path: "/users/7" } }],
    kind: "event",
    traceId: "4bf9",
  };

  it("writes one JSON object per line", () => {
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => (lines.push(chunk), true)) as typeof process.stderr.write;
    try {
      new ConsoleLogger({ format: "json" }).write(record);
    } finally {
      process.stderr.write = original;
    }
    expect(JSON.parse(lines[0]!)).toEqual({
      t: "2026-10-17T12:04:01.239Z", level: "warn", target: "UserRepo", msg: "user missing",
      fields: { id: 7 }, spans: record.spans, trace: "4bf9",
    });
  });

  it("writes pretty lines indented by span depth", () => {
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => (lines.push(chunk), true)) as typeof process.stderr.write;
    try {
      new ConsoleLogger({ format: "pretty", color: false }).write(record);
    } finally {
      process.stderr.write = original;
    }
    expect(lines[0]).toMatch(/^\d\d:\d\d:\d\d\.239  WARN   user missing id=7 \(UserRepo\)\n$/);
  });
});

describe("the root logger", () => {
  it("logs through the app's sink, with fields from child()", async () => {
    records.length = 0;
    log.child({ job: "nightly" }).info("started", { rows: 3 });
    expect(records.at(-1)).toMatchObject({ target: "app", message: "started", fields: { job: "nightly", rows: 3 } });
    const result = await log.span("batch", { size: 2 }, async () => "done");
    expect(result).toBe("done");
    expect(records.filter((r) => r.message === "batch").map((r) => r.kind)).toEqual(["span-enter", "span-exit"]);
  });
});
