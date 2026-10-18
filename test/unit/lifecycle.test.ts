import { describe, expect, it } from "vitest";
import { ILogger, every, hosted, inject, onBoot, onShutdown, parseDuration, service, yerd, type LogRecord } from "@toyz/yerd";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("lifecycle", () => {
  it("runs @onBoot before serving, @hosted and @every in the background, then shuts down in order", async () => {
    const events: string[] = [];

    @service
    class Db {
      connected = false;
      @onBoot async connect() {
        await sleep(5);
        this.connected = true;
        events.push("db:boot");
      }
      @onShutdown close() {
        events.push("db:shutdown");
      }
    }

    @service
    class Cache {
      @inject(Db) accessor db!: Db;
      @onBoot warm() {
        events.push(`cache:boot(db=${this.db.connected})`);
      }
      @onShutdown flush() {
        events.push("cache:shutdown");
      }
    }

    let ticks = 0;
    let overlapping = false;
    let running = false;
    @service
    class Sweeper {
      @every(15) async sweep(signal: AbortSignal) {
        if (running) overlapping = true;
        running = true;
        ticks++;
        await sleep(20);
        running = false;
        if (signal.aborted) events.push("sweep:aborted");
      }
    }

    @hosted
    class Worker {
      async run(signal: AbortSignal) {
        events.push("worker:start");
        while (!signal.aborted) await sleep(5);
        events.push("worker:stop");
      }
    }

    const app = yerd({ routes: [], services: [Db, Cache, Sweeper, Worker], handleSignals: false });
    const server = await app.listen(0, "127.0.0.1");
    expect(events.slice(0, 2)).toEqual(["db:boot", "cache:boot(db=true)"]);
    await sleep(120);
    expect(events).toContain("worker:start");
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(overlapping).toBe(false);

    await server.close();
    const tail = events.slice(events.indexOf("worker:start") + 1);
    expect(tail).toContain("worker:stop");
    // @onShutdown hooks run after background work stops, newest first.
    expect(tail.slice(-2)).toEqual(["cache:shutdown", "db:shutdown"]);
    const after = ticks;
    await sleep(50);
    expect(ticks).toBe(after);
  });

  it("start() runs background work without an HTTP server", async () => {
    let ran = false;
    @hosted
    class Job {
      async run() {
        ran = true;
      }
    }
    const app = yerd({ routes: [], services: [Job] });
    await app.start();
    await sleep(5);
    expect(ran).toBe(true);
    await app.stop();
  });

  it("keeps going when a hosted service throws", async () => {
    @hosted
    class Boom {
      async run() {
        throw new Error("boom");
      }
    }
    const records: LogRecord[] = [];
    const sink: ILogger = { write: (r) => records.push(r) };
    const app = yerd({ routes: [], services: [Boom] }).services((s) => s.value(ILogger, sink));
    await app.start();
    await sleep(5);
    await app.stop();
    const failure = records.find((r) => r.level === "error")!;
    expect(failure.message).toBe("hosted service Boom failed");
    expect(failure.target).toBe("yerd::lifecycle");
    expect(failure.error?.message).toBe("boom");
  });
});

describe("parseDuration", () => {
  it("parses units", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("5s")).toBe(5000);
    expect(parseDuration("1.5m")).toBe(90000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration(42)).toBe(42);
    expect(() => parseDuration("soon")).toThrow(/Invalid duration/);
  });
});
