import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import {
  BootError, ILogger, every, get, hosted, inject, onBoot, onShutdown, parseDuration, route, service, yerd,
  type LogRecord, type RunningServer,
} from "@toyz/yerd";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => vi.restoreAllMocks());

function collector() {
  const records: LogRecord[] = [];
  const sink: ILogger = { write: (r) => records.push(r) };
  return { records, sink };
}

describe("parseDuration and @every arguments", () => {
  it.each([
    ["500ms", 500],
    ["5s", 5000],
    ["1.5s", 1500],
    ["1m", 60_000],
    ["2h", 7_200_000],
    ["1d", 86_400_000],
    [" 3s ", 3000],
    ["10 ms", 10],
    [250, 250],
    [0, 0],
  ] as const)("%j is %d ms", (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });

  it.each(["", "5", "s", "5 sec", "-1s", "1w", "1.s", ".5s", "1e3ms", "5S", "1h30m"])("refuses %j", (input) => {
    expect(() => parseDuration(input)).toThrow(`Invalid duration: ${JSON.stringify(input)}`);
  });

  it.each([0, -5, "0ms", "0s"])("@every(%j) refuses a non-positive interval", (interval) => {
    expect(() => every(interval)).toThrow("@every interval must be positive");
  });

  it("refuses @every, @onBoot and @onShutdown on static or private methods", () => {
    expect(() => {
      class A {
        @every("1s") static tick() {}
      }
      void A;
    }).toThrow("@every must decorate a public instance method");
    expect(() => {
      class B {
        @onBoot static start() {}
      }
      void B;
    }).toThrow("@onBoot must decorate a public instance method");
    expect(() => {
      class C {
        @onShutdown #stop() {}
        use() {
          this.#stop();
        }
      }
      void C;
    }).toThrow("@onShutdown must decorate a public instance method");
  });
});

describe("@onBoot", () => {
  it("runs hooks in registration order, awaiting each, before listen() resolves", async () => {
    const log: string[] = [];
    @service class First {
      @onBoot async a() { await sleep(10); log.push("first.a"); }
      @onBoot b() { log.push("first.b"); }
    }
    @service class Second {
      @onBoot c() { log.push("second.c"); }
    }
    const server = await yerd({ routes: [], services: [First, Second], handleSignals: false }).listen(0, "127.0.0.1");
    expect(log).toEqual(["first.a", "first.b", "second.c"]);
    await server.close();
  });

  it("a failing hook fails start(): earlier services shut down, singletons are disposed, later hooks never run", async () => {
    const log: string[] = [];
    @service class Early {
      @onBoot up() { log.push("early:boot"); }
      @onShutdown down() { log.push("early:shutdown"); }
      [Symbol.dispose]() { log.push("early:dispose"); }
    }
    @service class Broken {
      @onBoot up() { throw new Error("db unreachable"); }
      @onShutdown down() { log.push("broken:shutdown"); }
    }
    @service class Late {
      @onBoot up() { log.push("late:boot"); }
    }
    @hosted class Worker {
      run() { log.push("worker:run"); }
    }
    const app = yerd({ routes: [], services: [Early, Broken, Late, Worker], handleSignals: false });
    await expect(app.start()).rejects.toThrow("db unreachable");
    expect(log).toEqual(["early:boot", "early:shutdown", "early:dispose"]);
    // It stays failed, with the same error, and doesn't run anything again.
    await expect(app.start()).rejects.toThrow("db unreachable");
    await expect(app.listen(0, "127.0.0.1")).rejects.toThrow("db unreachable");
    await expect(app.stop()).resolves.toBeUndefined();
    expect(log).toEqual(["early:boot", "early:shutdown", "early:dispose"]);
  });

  it("reports the boot failure, not a disposal failure during the cleanup", async () => {
    const { records, sink } = collector();
    @service class BadDispose {
      @onBoot up() {}
      [Symbol.dispose]() { throw new Error("dispose failed"); }
    }
    @service class Broken {
      @onBoot up() { throw new Error("the real problem"); }
    }
    const app = yerd({ routes: [], services: [BadDispose, Broken] }).services((s) => s.value(ILogger, sink));
    await expect(app.start()).rejects.toThrow("the real problem");
    const cleanup = records.find((r) => r.message === "cleaning up after a failed start failed")!;
    expect(cleanup.error?.message).toBe("dispose failed");
  });

  it("an HTTP request to an app whose start failed gets the error through next(), or a rejection", async () => {
    @service class Broken {
      @onBoot up() { throw new Error("nope"); }
    }
    const app = yerd({ routes: [], services: [Broken] });
    const next = vi.fn();
    await app.handle({} as never, {} as never, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "nope" }));
    await expect(app.handle({} as never, {} as never)).rejects.toThrow("nope");
  });

  it("boot validation errors fail start() as a BootError", async () => {
    @service({ lifetime: "scoped" }) class Hooked {
      @onBoot up() {}
    }
    const error = await yerd({ routes: [], services: [Hooked] }).start().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BootError);
    expect((error as BootError).problems).toEqual(["Hooked (scoped): @onBoot, @onShutdown, @every, @on and @handles need a singleton service"]);
  });

  it("refuses lifecycle hooks on routes", async () => {
    @route("/hooked")
    class HookedRoute {
      @every("1s") tick() {}
      @get show() { return "x"; }
    }
    await expect(yerd({ routes: [HookedRoute], services: [] }).boot()).rejects.toThrow(
      "HookedRoute: lifecycle hooks (@onBoot, @onShutdown, @every) belong on singleton services, not routes",
    );
  });

  it("runs hooks on a class registered through app.services(), including under a token", async () => {
    const log: string[] = [];
    class Plain {
      @onBoot up() { log.push("plain"); }
    }
    const app = yerd({ routes: [], services: [] }).services((s) => s.singleton(Plain));
    await app.start();
    await app.stop();
    expect(log).toEqual(["plain"]);
  });
});

describe("@onShutdown and stop()", () => {
  it("runs shutdown hooks newest service first, keeps going past failures, then disposes", async () => {
    const { records, sink } = collector();
    const log: string[] = [];
    @service class A {
      @onShutdown one() { log.push("a.one"); }
      @onShutdown two() { log.push("a.two"); }
      [Symbol.dispose]() { log.push("a:dispose"); }
    }
    @service class B {
      @onShutdown async fail() { await sleep(1); log.push("b.fail"); throw new Error("flush failed"); }
    }
    @service class C {
      @onShutdown last() { log.push("c.last"); }
    }
    const app = yerd({ routes: [], services: [A, B, C] }).services((s) => s.value(ILogger, sink));
    await app.start();
    await app.stop();
    expect(log).toEqual(["c.last", "b.fail", "a.two", "a.one", "a:dispose"]);
    const failure = records.find((r) => r.message === "@onShutdown hook failed")!;
    expect([failure.level, failure.target, failure.error?.message]).toEqual(["error", "yerd::lifecycle", "flush failed"]);
  });

  it("stop() is idempotent: one shutdown, the same promise", async () => {
    let shutdowns = 0;
    @service class S {
      @onShutdown down() { shutdowns++; }
    }
    const app = yerd({ routes: [], services: [S] });
    await app.start();
    const first = app.stop();
    const second = app.stop();
    expect(second).toBe(first);
    await Promise.all([first, second, app.stop()]);
    expect(shutdowns).toBe(1);
  });

  it("start() after stop() is refused", async () => {
    const app = yerd({ routes: [], services: [] });
    await app.start();
    await app.stop();
    await expect(app.start()).rejects.toThrow("This app was stopped; create a new one to start again");
    await expect(app.listen(0, "127.0.0.1")).rejects.toThrow("This app was stopped");
  });

  it("stop() before start() works and prevents a later start", async () => {
    const app = yerd({ routes: [], services: [] });
    await app.stop();
    await expect(app.start()).rejects.toThrow("This app was stopped");
  });

  it("stop() during a slow start waits for it, then shuts down what it started", async () => {
    const log: string[] = [];
    @service class Slow {
      @onBoot async up() { await sleep(30); log.push("booted"); }
      @onShutdown down() { log.push("shutdown"); }
    }
    const app = yerd({ routes: [], services: [Slow] });
    const started = app.start();
    await sleep(5);
    await app.stop();
    await started;
    expect(log).toEqual(["booted", "shutdown"]);
  });

  it("close() is idempotent and stops the app", async () => {
    let shutdowns = 0;
    @service class S {
      @onShutdown down() { shutdowns++; }
    }
    const server = await yerd({ routes: [], services: [S], handleSignals: false }).listen(0, "127.0.0.1");
    await Promise.all([server.close(), server.close()]);
    await server.close();
    expect(shutdowns).toBe(1);
    expect(server.server.listening).toBe(false);
  });

  it("resolve() works inside shutdown hooks", async () => {
    const { resolve } = await import("@toyz/yerd");
    class Dep { name = "dep"; }
    let seen = "";
    class Hooks {
      @onShutdown down() { seen = resolve(Dep).name; }
    }
    const app = yerd({ routes: [], services: [] }).services((s) => s.singleton(Dep).singleton(Hooks));
    await app.start();
    await app.stop();
    expect(seen).toBe("dep");
  });
});

describe("@every", () => {
  it("runs immediately when asked, never overlaps, and passes a signal that aborts at shutdown", async () => {
    const starts: number[] = [];
    let running = 0;
    let maxRunning = 0;
    let lastSignal: AbortSignal | undefined;
    @service class Ticker {
      @every(5, { immediate: true }) async tick(signal: AbortSignal) {
        lastSignal = signal;
        starts.push(Date.now());
        running++;
        maxRunning = Math.max(maxRunning, running);
        await sleep(20);
        running--;
      }
    }
    const app = yerd({ routes: [], services: [Ticker] });
    const t0 = Date.now();
    await app.start();
    await sleep(15);
    expect(starts.length).toBe(1);
    expect(starts[0]! - t0).toBeLessThan(15);
    await sleep(60);
    expect(maxRunning).toBe(1);
    // Each run starts at least the interval after the previous one ended (20ms run + 5ms gap).
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(22);
    expect(lastSignal!.aborted).toBe(false);
    await app.stop();
    expect(lastSignal!.aborted).toBe(true);
  });

  it("waits a full interval before the first run without immediate", async () => {
    let runs = 0;
    @service class Later {
      @every("80ms") tick() { runs++; }
    }
    const app = yerd({ routes: [], services: [Later] });
    await app.start();
    await sleep(30);
    expect(runs).toBe(0);
    await sleep(90);
    expect(runs).toBe(1);
    await app.stop();
  });

  it("keeps the schedule when runs throw (sync or async), logging each failure", async () => {
    const { records, sink } = collector();
    let runs = 0;
    @service class Flaky {
      @every(5) sync() {
        runs++;
        throw new Error("sync fail");
      }
      @every(5) async later() {
        throw new Error("async fail");
      }
    }
    const app = yerd({ routes: [], services: [Flaky] }).services((s) => s.value(ILogger, sink));
    await app.start();
    await sleep(60);
    await app.stop();
    expect(runs).toBeGreaterThanOrEqual(3);
    const failures = records.filter((r) => r.target === "yerd::lifecycle" && r.level === "error");
    expect(new Set(failures.map((r) => r.message))).toEqual(new Set(["@every Flaky.sync failed", "@every Flaky.later failed"]));
    expect(failures.find((r) => r.message === "@every Flaky.sync failed")!.error?.message).toBe("sync fail");
  });

  it("stops scheduling at shutdown and waits for a run in progress", async () => {
    const log: string[] = [];
    @service class Busy {
      @every(5, { immediate: true }) async tick(signal: AbortSignal) {
        log.push("start");
        await sleep(30);
        log.push(signal.aborted ? "end:aborted" : "end");
      }
      @onShutdown down() { log.push("shutdown"); }
    }
    const app = yerd({ routes: [], services: [Busy] });
    await app.start();
    await sleep(10);
    await app.stop();
    expect(log).toEqual(["start", "end:aborted", "shutdown"]);
    await sleep(30);
    expect(log).toEqual(["start", "end:aborted", "shutdown"]);
  });

  it("gives up waiting on a run that ignores the signal after shutdownTimeout", async () => {
    const { records, sink } = collector();
    let release!: () => void;
    @service class Stuck {
      @every(5, { immediate: true }) async tick() {
        await new Promise<void>((r) => (release = r));
      }
    }
    const app = yerd({ routes: [], services: [Stuck], shutdownTimeout: 40 }).services((s) => s.value(ILogger, sink));
    await app.start();
    await sleep(10);
    const t0 = Date.now();
    await app.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(records.some((r) => r.message === "background work didn't stop within 40ms; continuing shutdown")).toBe(true);
    release();
  });
});

describe("@hosted", () => {
  it("logs a throwing service (sync or async) and keeps the app running", async () => {
    const { records, sink } = collector();
    @hosted class SyncThrow {
      run(): never { throw new Error("sync boom"); }
    }
    @hosted class AsyncThrow {
      async run() { await sleep(1); throw new Error("async boom"); }
    }
    const app = yerd({ routes: [], services: [SyncThrow, AsyncThrow] }).services((s) => s.value(ILogger, sink));
    await app.start();
    await sleep(10);
    await app.stop();
    const messages = records.filter((r) => r.level === "error").map((r) => [r.message, r.error?.message]);
    expect(messages).toEqual(expect.arrayContaining([
      ["hosted service SyncThrow failed", "sync boom"],
      ["hosted service AsyncThrow failed", "async boom"],
    ]));
  });

  it("stops waiting for a service that ignores its signal after shutdownTimeout, then still runs shutdown hooks", async () => {
    const { records, sink } = collector();
    const log: string[] = [];
    @hosted class Deaf {
      async run() { await new Promise(() => {}); }
    }
    @service class Hooks {
      @onShutdown down() { log.push("shutdown"); }
    }
    const app = yerd({ routes: [], services: [Deaf, Hooks], shutdownTimeout: 30 }).services((s) => s.value(ILogger, sink));
    await app.start();
    const t0 = Date.now();
    await app.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(log).toEqual(["shutdown"]);
    expect(records.find((r) => r.level === "warn")!.message).toBe("background work didn't stop within 30ms; continuing shutdown");
  });

  it("starts after every @onBoot hook and gets a signal that aborts at stop", async () => {
    const log: string[] = [];
    @service class Db {
      @onBoot async up() { await sleep(10); log.push("db:boot"); }
    }
    @hosted class Worker {
      @inject(Db) accessor db!: Db;
      async run(signal: AbortSignal) {
        log.push("worker:start");
        await new Promise((r) => signal.addEventListener("abort", r));
        log.push("worker:stop");
      }
    }
    const app = yerd({ routes: [], services: [Db, Worker] });
    await app.start();
    await sleep(5);
    await app.stop();
    expect(log).toEqual(["db:boot", "worker:start", "worker:stop"]);
  });

  it("is a singleton shared with injectors", async () => {
    @hosted class Queue {
      jobs: string[] = [];
      async run(signal: AbortSignal) { await new Promise((r) => signal.addEventListener("abort", r)); }
    }
    @service class Producer {
      @inject(Queue) accessor queue!: Queue;
    }
    const app = yerd({ routes: [], services: [Queue, Producer] });
    await app.start();
    expect(app.container.get(Producer).queue).toBe(app.container.get(Queue));
    await app.stop();
  });
});

describe("listen()", () => {
  /** A port something else is already listening on, and a way to free it. */
  async function takenPort(): Promise<{ port: number; free: () => void }> {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    return { port: (blocker.address() as { port: number }).port, free: () => blocker.close() };
  }

  it("rejects when the port is taken, after stopping the app it started", async () => {
    const log: string[] = [];
    let ticks = 0;
    @service class Jobs {
      @every("5ms") tick() { ticks++; }
      @onShutdown down() { log.push("shutdown"); }
    }
    const { port, free } = await takenPort();
    try {
      const app = yerd({ routes: [], services: [Jobs], handleSignals: false });
      await expect(app.listen(port, "127.0.0.1")).rejects.toMatchObject({ code: "EADDRINUSE" });
      // Stopped: hooks ran, timers are gone, so nothing keeps the process alive.
      expect(log).toEqual(["shutdown"]);
      const after = ticks;
      await sleep(30);
      expect(ticks).toBe(after);
      await expect(app.start()).rejects.toThrow("This app was stopped");
    } finally {
      free();
    }
  });

  it("leaves an app you started yourself running when the port is taken", async () => {
    const log: string[] = [];
    @service class Jobs {
      @onShutdown down() { log.push("shutdown"); }
    }
    const { port, free } = await takenPort();
    const app = yerd({ routes: [], services: [Jobs], handleSignals: false });
    try {
      await app.start();
      await expect(app.listen(port, "127.0.0.1")).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(log).toEqual([]);
      // Still usable: another port works.
      const server = await app.listen(0, "127.0.0.1");
      await server.close();
      expect(log).toEqual(["shutdown"]);
    } finally {
      free();
      await app.stop();
    }
  });

  it("reports the port it got, and closes with await using", async () => {
    @route("/ping") class Ping { @get pong() { return "pong"; } }
    let http: RunningServer["server"] | undefined;
    {
      await using server = await yerd({ routes: [Ping], services: [], handleSignals: false }).listen(0, "127.0.0.1");
      expect(server.port).toBeGreaterThan(0);
      expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
      expect(await (await fetch(`${server.url}/ping`)).text()).toBe("pong");
      http = server.server;
      expect(http.listening).toBe(true);
    }
    // Disposed when the block ended, before the next line runs.
    expect(http!.listening).toBe(false);
  });

  it.each([
    [undefined, /^http:\/\/localhost:\d+$/],
    ["127.0.0.1", /^http:\/\/127\.0\.0\.1:\d+$/],
    ["::1", /^http:\/\/\[::1\]:\d+$/],
  ])("reports the url for host %s with the real port", async (host, pattern) => {
    const server = await yerd({ routes: [], services: [], handleSignals: false }).listen(0, host).catch(() => undefined);
    if (!server) return; // no IPv6 loopback here
    try {
      expect(server.url).toMatch(pattern);
      expect(server.url.endsWith(":0")).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("handles SIGTERM: closes the server, stops the app and exits 0", async () => {
    let shutdowns = 0;
    @service class S {
      @onShutdown down() { shutdowns++; }
    }
    const others = { SIGTERM: process.listeners("SIGTERM"), SIGINT: process.listeners("SIGINT") };
    for (const l of others.SIGTERM) process.off("SIGTERM", l);
    for (const l of others.SIGINT) process.off("SIGINT", l);
    const exited = new Promise<number | undefined>((resolve) => {
      vi.spyOn(process, "exit").mockImplementation(((code?: number) => resolve(code)) as never);
    });
    try {
      const server = await yerd({ routes: [], services: [S] }).listen(0, "127.0.0.1");
      expect(process.listenerCount("SIGTERM")).toBe(1);
      process.emit("SIGTERM");
      expect(await exited).toBe(0);
      expect(shutdowns).toBe(1);
      expect(server.server.listening).toBe(false);
      // The handlers removed themselves.
      expect(process.listenerCount("SIGTERM")).toBe(0);
      expect(process.listenerCount("SIGINT")).toBe(0);
    } finally {
      for (const l of others.SIGTERM) process.on("SIGTERM", l);
      for (const l of others.SIGINT) process.on("SIGINT", l);
    }
  });

  it("registers no signal handlers with handleSignals: false (option or listen argument)", async () => {
    const before = process.listenerCount("SIGTERM");
    const a = await yerd({ routes: [], services: [], handleSignals: false }).listen(0, "127.0.0.1");
    const b = await yerd({ routes: [], services: [] }).listen(0, "127.0.0.1", { handleSignals: false });
    expect(process.listenerCount("SIGTERM")).toBe(before);
    await a.close();
    await b.close();
  });

  it("close() removes the signal handlers it added", async () => {
    const before = process.listenerCount("SIGINT");
    const server = await yerd({ routes: [], services: [] }).listen(0, "127.0.0.1");
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    await server.close();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("close() lets an in-flight request finish within shutdownTimeout", async () => {
    @route("/slow-close")
    class SlowClose {
      @get async show() {
        await sleep(40);
        return "finished";
      }
    }
    const server = await yerd({ routes: [SlowClose], services: [], handleSignals: false }).listen(0, "127.0.0.1");
    const pending = fetch(server.url + "/slow-close").then((r) => r.text());
    await sleep(10);
    await server.close();
    expect(await pending).toBe("finished");
  });

  it("close() cuts a request that outlives shutdownTimeout", async () => {
    @route("/too-slow")
    class TooSlow {
      @get async show() {
        await sleep(500);
        return "late";
      }
    }
    const server = await yerd({ routes: [TooSlow], services: [], handleSignals: false, shutdownTimeout: 30 }).listen(0, "127.0.0.1");
    const pending = fetch(server.url + "/too-slow").then((r) => r.text(), () => "cut");
    await sleep(10);
    const t0 = Date.now();
    await server.close();
    expect(Date.now() - t0).toBeLessThan(300);
    expect(await pending).toBe("cut");
  });
});

describe("listen() timeouts", () => {
  it("defaults keep-alive past load balancers' idle timeouts, headers past keep-alive", async () => {
    await using server = await yerd({ routes: [], services: [], handleSignals: false }).listen(0, "127.0.0.1");
    expect([server.server.keepAliveTimeout, server.server.headersTimeout, server.server.requestTimeout]).toEqual([72_000, 73_000, 300_000]);
  });

  it("takes its own, keeping headers past a longer keep-alive", async () => {
    await using server = await yerd({ routes: [], services: [], handleSignals: false, timeouts: { keepAlive: 120_000, request: 0 } }).listen(0, "127.0.0.1");
    expect([server.server.keepAliveTimeout, server.server.headersTimeout, server.server.requestTimeout]).toEqual([120_000, 121_000, 0]);
  });

  it("refuses ones that can't work, before starting anything", async () => {
    const app = (timeouts: { keepAlive?: number; headers?: number; request?: number }) => yerd({ routes: [], services: [], handleSignals: false, timeouts });
    await expect(app({ headers: 10_000, request: 5_000 }).listen(0, "127.0.0.1")).rejects.toThrow("timeouts.headers (10000) can't be longer than timeouts.request (5000)");
    await expect(app({ keepAlive: -1 }).listen(0, "127.0.0.1")).rejects.toThrow("timeouts.keepAlive must be a whole number of ms");
  });
});
