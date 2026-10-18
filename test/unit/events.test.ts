import { afterEach, describe, expect, it } from "vitest";
import {
  BootError, Call, Events, EventTransport, HttpError, ILogger, MemoryTransport, get, inject, named, on, handles, post, resolve, route,
  scoped, service, yerd, type RunningServer, type YerdApp,
} from "@toyz/yerd";
import { maybeContext } from "../../src/server/context.js";

@named("test.order-placed")
class OrderPlaced {
  constructor(
    readonly orderId: string,
    readonly total: number,
  ) {}
  get big(): boolean {
    return this.total > 100;
  }
}

@named("test.stamped")
class Stamped {
  constructor(readonly at: Date) {}
  static fromJSON(data: { at: string }): Stamped {
    return new Stamped(new Date(data.at));
  }
}

@named("test.quote")
class Quote extends Call<number> {
  constructor(readonly grams: number) {
    super();
  }
}

@named("test.unanswered")
class Unanswered extends Call<string> {}

const seen: string[] = [];
let flaky = 0;

@service
@scoped
class PerDelivery {
  readonly id = Math.random();
}

@service
class Receipts {
  @on(OrderPlaced) send(e: OrderPlaced) {
    seen.push(`receipt ${e.orderId} ${e.total} big=${e.big} ${e instanceof OrderPlaced}`);
    if (maybeContext()) seen.push("ran inside the emitting request");
  }

  @on(OrderPlaced, { retries: 2, backoff: "5ms" }) flakyWarehouse(e: OrderPlaced) {
    if (flaky++ < 2) throw new Error("warehouse down");
    seen.push(`warehouse ${e.orderId} after ${flaky} tries`);
  }

  @on(Stamped) stamp(e: Stamped) {
    seen.push(`stamped ${e.at instanceof Date ? e.at.toISOString() : "not a date"}`);
  }

  @handles(Quote) quote(q: Quote): number {
    if (q.grams < 0) throw new HttpError(422, "Negative weight");
    if (q.grams === 0) throw new Error("boom");
    return q.grams * 2;
  }
}

const scopes: number[] = [];

@service
class Scoped {
  @on(Stamped) note() {
    scopes.push(resolve(PerDelivery).id, resolve(PerDelivery).id);
  }
}

@route("/checkout")
class Checkout {
  @inject(Events) accessor events!: Events;

  @post ok() {
    this.events.emit(new OrderPlaced("o1", 250));
    return 204;
  }

  @get fail(): never {
    this.events.emit(new OrderPlaced("o2", 10));
    throw new Error("payment failed");
  }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

let server: RunningServer | undefined;
let current: YerdApp | undefined;
/** Run inside the app's DI context (like a hook or a script). */
const inApp = <T>(fn: () => T): Promise<T> => current!.scope(fn);
afterEach(async () => {
  await server?.close();
  server = undefined;
  seen.length = 0;
  scopes.length = 0;
  flaky = 0;
});

function app(): YerdApp {
  return (current = yerd({ routes: [Checkout], services: [Receipts, Scoped, PerDelivery], handleSignals: false, secret: "e".repeat(32) }));
}

describe("events", () => {
  it("deliver to @on handlers as instances of their class, through JSON", async () => {
    server = await app().listen(0, "127.0.0.1");
    await inApp(() => resolve(Events).emit(new OrderPlaced("o9", 500)));
    await tick(50);
    expect(seen).toContain("receipt o9 500 big=true true");
    expect(seen).toContain("warehouse o9 after 3 tries");
  });

  it("use a class's fromJSON, and give each delivery its own DI scope", async () => {
    server = await app().listen(0, "127.0.0.1");
    await inApp(() => resolve(Events).emit(new Stamped(new Date("2026-10-18T00:00:00Z"))));
    await inApp(() => resolve(Events).emit(new Stamped(new Date("2026-10-18T00:00:00Z"))));
    await tick();
    expect(seen).toContain("stamped 2026-10-18T00:00:00.000Z");
    expect(scopes).toHaveLength(4);
    expect(scopes[0]).toBe(scopes[1]);
    expect(scopes[2]).toBe(scopes[3]);
    expect(scopes[0]).not.toBe(scopes[2]);
  });

  it("from a request: sent once it succeeds, dropped when it throws", async () => {
    server = await app().listen(0, "127.0.0.1");
    const ok = await fetch(`${server.url}/checkout`, { method: "POST", headers: { origin: server.url } });
    expect(ok.status).toBe(204);
    const failed = await fetch(`${server.url}/checkout`);
    expect(failed.status).toBe(500);
    await tick(50);
    expect(seen.filter((s) => s.startsWith("receipt"))).toEqual(["receipt o1 250 big=true true"]);
    expect(seen).not.toContain("ran inside the emitting request");
  });

  it("calls: the handler's answer, its HttpErrors as HttpErrors, other failures as Errors", async () => {
    server = await app().listen(0, "127.0.0.1");
    const events = await inApp(() => resolve(Events));
    const answer: number = await events.call(new Quote(600));
    expect(answer).toBe(1200);
    const http = await events.call(new Quote(-1)).catch((e: unknown) => e);
    expect(http).toBeInstanceOf(HttpError);
    expect((http as HttpError).status).toBe(422);
    await expect(events.call(new Quote(0))).rejects.toThrow("boom");
  });

  it("calls nobody answers fail at once in memory, and time out on a transport that can't tell", async () => {
    server = await app().listen(0, "127.0.0.1");
    const events = await inApp(() => resolve(Events));
    await expect(events.call(new Unanswered())).rejects.toThrow(/Nothing answers test.unanswered/);
    const silent = new Events({ publish: () => undefined, subscribe: () => () => {} });
    await expect(silent.call(new Unanswered(), { timeout: "30ms" })).rejects.toThrow(/no answer within 30ms/);
  });

  it("waitFor the next matching event", async () => {
    server = await app().listen(0, "127.0.0.1");
    const events = await inApp(() => resolve(Events));
    const next = events.waitFor(OrderPlaced, { where: (e: OrderPlaced) => e.orderId === "b" });
    events.emit(new OrderPlaced("a", 1));
    events.emit(new OrderPlaced("b", 2));
    expect((await next).total).toBe(2);
    await expect(events.waitFor(OrderPlaced, { timeout: 20 })).rejects.toThrow(/saw nothing within 20ms/);
  });
});

describe("several instances on one transport", () => {
  it("each handler gets an event once; every: true reaches every instance", async () => {
    const transport = new MemoryTransport();
    const delivered: string[] = [];
    const [a, b] = [new Events(transport), new Events(transport)];
    const fake = { get: () => undefined } as never;
    for (const [bus, label] of [
      [a, "A"],
      [b, "B"],
    ] as const) {
      bus.wire(fake, { once: () => delivered.push(`once@${label}`), all: () => delivered.push(`all@${label}`) }, "Shop", [
        { method: "once", type: OrderPlaced, options: {} },
        { method: "all", type: OrderPlaced, options: { every: true } },
      ], []);
    }
    a.emit(new OrderPlaced("x", 1));
    a.emit(new OrderPlaced("y", 1));
    await tick();
    expect(delivered.filter((d) => d.startsWith("once")).sort()).toEqual(["once@A", "once@B"]);
    expect(delivered.filter((d) => d.startsWith("all")).sort()).toEqual(["all@A", "all@A", "all@B", "all@B"]);
  });

  it("a registered EventTransport replaces the in-memory one", async () => {
    const published: string[] = [];
    const transport = new MemoryTransport();
    const spy: EventTransport = {
      publish: (topic, message) => (published.push(topic), transport.publish(topic, message)),
      subscribe: (topic, group, deliver) => transport.subscribe(topic, group, deliver),
    };
    server = await app()
      .services((s) => s.value(EventTransport, spy))
      .listen(0, "127.0.0.1");
    await inApp(() => resolve(Events).emit(new OrderPlaced("t", 3)));
    await tick();
    expect(published).toContain("event:test.order-placed");
    expect(seen).toContain("receipt t 3 big=false true");
  });
});

describe("boot checks", () => {
  it("refuse @on on non-singletons and calls answered twice", async () => {
    @service
    @scoped
    class Wrong {
      @on(OrderPlaced) handle() {}
    }
    @service
    class Twice {
      @handles(Quote) again() {
        return 1;
      }
    }
    const error = (await yerd({ routes: [], services: [Wrong, Twice, Receipts] }).boot().catch((e: unknown) => e)) as BootError;
    expect(error).toBeInstanceOf(BootError);
    expect(error.problems.join("\n")).toMatch(/Wrong \(scoped\): .*@on and @handles need a singleton service/);
    expect(error.problems.join("\n")).toMatch(/test.quote is answered twice/);
  });

  it("refuse two event classes with one name", () => {
    expect(() => {
      @named("test.order-placed")
      class Impostor {}
      void Impostor;
    }).toThrow(/Two event classes are named "test.order-placed"/);
  });
});

describe("shutdown", () => {
  it("waits for running handlers", async () => {
    let finished = false;
    @named("test.slow")
    class Slow {}
    @service
    class SlowWorker {
      @on(Slow) async work() {
        await tick(60);
        finished = true;
      }
    }
    const slowApp = yerd({ routes: [], services: [SlowWorker], handleSignals: false });
    const s = await slowApp.listen(0, "127.0.0.1");
    await slowApp.scope(() => resolve(Events).emit(new Slow()));
    await tick(5);
    await s.close();
    expect(finished).toBe(true);
  });
});

describe("development warnings", () => {
  it("say once when an event reaches no handler", async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    const records: Array<{ level: string; message: string }> = [];
    @named("test.unheard")
    class Unheard {}
    const quiet = yerd({ routes: [], services: [], handleSignals: false }).services((s) =>
      s.value(ILogger, { write: (r) => records.push(r) }),
    );
    try {
      await quiet.start();
      await quiet.scope(async () => {
        const events = resolve(Events);
        await events.emitNow(new Unheard());
        await events.emitNow(new Unheard());
      });
      expect(records.filter((r) => r.level === "warn").map((r) => r.message)).toEqual([
        "nothing handles test.unheard: is the module with its @on handlers imported? A @service registers when its module loads",
      ]);
    } finally {
      process.env.NODE_ENV = before;
      await quiet.stop();
    }
  });
});
