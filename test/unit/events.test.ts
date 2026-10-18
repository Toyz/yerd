import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BootError, Call, Conflict, Events, EventTransport, YerdError, ILogger, MemoryTransport, get, inject, named, on, handles, post, resolve, route,
  scoped, service, yerd, type RunningServer, type YerdApp,
} from "@toyz/yerd";
import { maybeContext, runWithContext, type YerdContext } from "../../src/server/context.js";

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

class TooLight extends Conflict {
  constructor() {
    super("Too light to ship", { code: "too_light", details: { min: 2 }, headers: { "retry-after": "5" } });
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
    if (q.grams < 0) throw new YerdError(422, "Negative weight");
    if (q.grams === 1) throw new TooLight();
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

  it("calls: the handler's answer, its YerdErrors as YerdErrors, other failures as Errors", async () => {
    server = await app().listen(0, "127.0.0.1");
    const events = await inApp(() => resolve(Events));
    const answer: number = await events.call(new Quote(600));
    expect(answer).toBe(1200);
    const http = await events.call(new Quote(-1)).catch((e: unknown) => e);
    expect(http).toBeInstanceOf(YerdError);
    expect((http as YerdError).status).toBe(422);
    await expect(events.call(new Quote(0))).rejects.toThrow("boom");
  });

  it("calls: a YerdError subclass arrives as yerd's class for its status, code, details and headers intact", async () => {
    server = await app().listen(0, "127.0.0.1");
    const events = await inApp(() => resolve(Events));
    const error = await events.call(new Quote(1)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Conflict);
    expect(error).toMatchObject({ status: 409, message: "Too light to ship", code: "too_light", details: { min: 2 }, headers: { "retry-after": "5" } });
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

describe("events without app.start()", () => {
  it("throw at emit() when they can't be sent, instead of crashing later", async () => {
    @named("test.big")
    class Big {
      constructor(readonly n: bigint) {}
    }
    const bus = new Events();
    expect(() => bus.emit(new Big(1n))).toThrow(TypeError);
    expect(() => bus.emit(new Big(1n))).toThrow(/test.big can't be sent as JSON/);
    await expect(bus.emitNow(new Big(1n))).rejects.toThrow(/can't be sent as JSON/);
  });

  it("reach their handlers from a script (app.scope) and from app.request, unstarted", async () => {
    @named("test.unstarted")
    class Unstarted {
      constructor(readonly from: string) {}
    }
    const heard: string[] = [];
    @service
    class Listener {
      @on(Unstarted) note(e: Unstarted) {
        heard.push(e.from);
      }
    }
    @route("/emit-unstarted")
    class Emitter {
      @inject(Events) accessor events!: Events;
      @post go() {
        this.events.emit(new Unstarted("request"));
        return 204;
      }
    }
    const lazy = yerd({ routes: [Emitter], services: [Listener], handleSignals: false });
    await lazy.scope(() => resolve(Events).emit(new Unstarted("script")));
    await tick();
    expect(heard).toEqual(["script"]);
    const res = await lazy.request("/emit-unstarted", { method: "POST", headers: { origin: "http://localhost" } });
    expect(res.status).toBe(204);
    await tick();
    expect(heard).toEqual(["script", "request"]);
    await lazy.stop();
  });
});

describe("delivery copies and cleanup", () => {
  @named("test.basket")
  class Basket {
    constructor(readonly items: string[]) {}
  }
  const fake = { get: () => undefined } as never;

  it("give each handler and waiter its own copy of the event, in memory too", async () => {
    const bus = new Events(new MemoryTransport());
    const views: string[][] = [];
    bus.wire(fake, {
      a: (e: Basket) => (e.items.push("from a"), views.push([...e.items])),
      b: (e: Basket) => (e.items.push("from b"), views.push([...e.items])),
    }, "Shop", [
      { method: "a", type: Basket, options: {} },
      { method: "b", type: Basket, options: {} },
    ], []);
    const waited = bus.waitFor(Basket);
    const original = new Basket(["apple"]);
    bus.emit(original);
    const event = await waited;
    await tick();
    expect(views.sort()).toEqual([["apple", "from a"], ["apple", "from b"]]);
    expect(event.items).toEqual(["apple"]);
    expect(original.items).toEqual(["apple"]);
  });

  it("give a fromJSON class fresh data per delivery", async () => {
    @named("test.tagged")
    class Tagged {
      constructor(readonly tags: string[]) {}
      static fromJSON(data: { tags: string[] }): Tagged {
        data.tags.push("seen");
        return new Tagged(data.tags);
      }
    }
    const bus = new Events(new MemoryTransport());
    const [first, second] = [bus.waitFor(Tagged), bus.waitFor(Tagged)];
    bus.emit(new Tagged(["x"]));
    expect((await first).tags).toEqual(["x", "seen"]);
    expect((await second).tags).toEqual(["x", "seen"]);
  });

  it("refuse a call that can't be sent with a clear TypeError, leaving no timer or pending call", async () => {
    @named("test.big-call")
    class BigCall extends Call<number> {
      constructor(readonly n: bigint) {
        super();
      }
    }
    vi.useFakeTimers();
    try {
      const bus = new Events(new MemoryTransport());
      await expect(bus.call(new BigCall(1n), { timeout: "1h" })).rejects.toThrow(TypeError);
      await expect(bus.call(new BigCall(1n))).rejects.toThrow(/test.big-call can't be sent as JSON/);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("take each retry's abort listener off the stop signal once the wait is over", async () => {
    const signals = new Set<EventTarget>();
    const add = EventTarget.prototype.addEventListener;
    const spy = vi.spyOn(EventTarget.prototype, "addEventListener").mockImplementation(function (this: EventTarget, ...args) {
      if (args[0] === "abort") signals.add(this);
      return add.apply(this, args);
    });
    try {
      let tries = 0;
      const bus = new Events(new MemoryTransport());
      const flaky = () => {
        if (tries++ < 3) throw new Error("down");
      };
      bus.wire(fake, { flaky }, "Shop", [{ method: "flaky", type: Basket, options: { retries: 3, backoff: 1 } }], []);
      bus.emit(new Basket([]));
      await tick(50);
      expect(tries).toBe(4);
      expect(signals.size).toBeGreaterThan(0);
      for (const signal of signals) expect(getEventListeners(signal, "abort")).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("keep a request's queue on its context: released or dropped once, per bus", async () => {
    const heard: string[] = [];
    const listen = (bus: Events, label: string) =>
      bus.wire(fake, { note: (e: Basket) => heard.push(`${label}:${e.items.join()}`) }, "Shop", [{ method: "note", type: Basket, options: {} }], []);
    const [bus, other] = [new Events(new MemoryTransport()), new Events(new MemoryTransport())];
    listen(bus, "bus");
    listen(other, "other");
    const ok = {} as YerdContext;
    const failed = {} as YerdContext;
    runWithContext(ok, () => bus.emit(new Basket(["kept"])));
    runWithContext(failed, () => bus.emit(new Basket(["dropped"])));
    await tick();
    expect(heard).toEqual([]);
    bus.release(ok);
    bus.discard(failed);
    bus.release(ok);
    runWithContext(ok, () => bus.emit(new Basket(["after release"])));
    // Released on one bus is not released on another.
    runWithContext(ok, () => other.emit(new Basket(["held"])));
    await tick();
    expect(heard).toEqual(["bus:kept", "bus:after release"]);
  });
});
