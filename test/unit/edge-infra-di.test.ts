import { describe, expect, it, vi } from "vitest";
import {
  BootError, Container, ILogger, Scope, ServiceCollection, get, inject, maybe, resolve, route, scoped, service, singleton, token, transient, yerd,
  type LogRecord,
} from "@toyz/yerd";
import type { Registration } from "../../src/di/container.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A bare container with registrations from `configure`. */
function containerWith(configure: (s: ServiceCollection) => void): Container {
  const container = new Container();
  configure(new ServiceCollection((r: Registration) => container.register(r)));
  return container;
}

async function bootError(app: ReturnType<typeof yerd>): Promise<string[]> {
  const error = await app.boot().then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(BootError);
  return (error as BootError).problems;
}

describe("DI: lifetimes and captive dependencies", () => {
  @service({ lifetime: "scoped" }) class PerRequest {}
  @transient @service class Fresh {}
  @service class Shared {}

  it.each([
    ["singleton", "scoped", true],
    ["singleton", "transient", false],
    ["singleton", "singleton", false],
    ["scoped", "singleton", false],
    ["scoped", "scoped", false],
    ["scoped", "transient", false],
    ["transient", "scoped", false],
    ["transient", "singleton", false],
  ] as const)("%s holding %s is a boot error: %s", async (holder, held, refused) => {
    const target = held === "scoped" ? PerRequest : held === "transient" ? Fresh : Shared;
    class Holder {
      @inject(target as never) accessor dep!: unknown;
    }
    const app = yerd({ routes: [], services: [PerRequest, Fresh, Shared] }).services((s) => s[holder](Holder));
    if (refused) {
      expect(await bootError(app)).toEqual([`Holder (singleton) -> PerRequest (scoped): a singleton can't hold a per-request service`]);
    } else {
      await expect(app.boot()).resolves.toBeUndefined();
    }
  });

  it("flags a singleton route that injects a scoped service", async () => {
    @singleton
    @route("/captive")
    class Captive {
      @inject(PerRequest) accessor dep!: PerRequest;
      @get show() {
        return "x";
      }
    }
    expect(await bootError(yerd({ routes: [Captive], services: [PerRequest] }))).toEqual([
      "Captive (singleton) -> PerRequest (scoped): a singleton can't hold a per-request service",
    ]);
  });

  it("lists every problem at once", async () => {
    const Missing = token<string>("Missing");
    class A {
      @inject(PerRequest) accessor dep!: PerRequest;
      @inject(Missing) accessor missing!: string;
    }
    const problems = await bootError(yerd({ routes: [], services: [PerRequest] }).services((s) => s.singleton(A)));
    expect(problems).toEqual([
      "A (singleton) -> PerRequest (scoped): a singleton can't hold a per-request service",
      "A.missing: nothing is registered for token(Missing) (@service it, or app.services(...))",
    ]);
  });

  it("lets @maybe point at nothing without a boot error", async () => {
    const Absent = token<string>("Absent");
    class A {
      @maybe(Absent) accessor absent: string | undefined;
    }
    const app = yerd({ routes: [], services: [] }).services((s) => s.singleton(A));
    await app.boot();
    expect(app.container.get(A).absent).toBeUndefined();
  });

  it("@service options win over a lifetime decorator, in either order", async () => {
    @scoped @service({ lifetime: "singleton" }) class A {}
    @service({ lifetime: "transient" }) @scoped class B {}
    const app = yerd({ routes: [], services: [A, B] });
    await app.boot();
    expect(app.container.registration(A)!.lifetime).toBe("singleton");
    expect(app.container.registration(B)!.lifetime).toBe("transient");
  });
});

describe("DI: resolution", () => {
  it("names what's missing", () => {
    const container = new Container();
    const T = token<number>("Port");
    class Named {}
    expect(() => container.get(T)).toThrow("No service registered for token(Port)");
    expect(() => container.get(Named)).toThrow("No service registered for Named");
    expect(() => container.get(class {})).toThrow("No service registered for anonymous class");
  });

  it("tokens compare by identity, not by name", () => {
    const A = token<string>("Same");
    const B = token<string>("Same");
    const container = containerWith((s) => s.value(A, "a").value(B, "b"));
    expect([container.get(A), container.get(B)]).toEqual(["a", "b"]);
  });

  it("a token needs an implementation", () => {
    expect(() => containerWith((s) => s.singleton(token("T")))).toThrow("token(T) is a token, so it needs an implementation");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["zero", 0],
    ["empty string", ""],
    ["false", false],
  ])("value() keeps a falsy value (%s) and caches it", (_label, value) => {
    const T = token<unknown>("T");
    const container = containerWith((s) => s.value(T, value));
    expect(container.get(T)).toBe(value);
    expect(container.get(T)).toBe(value);
  });

  it("caches a singleton factory's result, even when it's undefined", () => {
    let calls = 0;
    const T = token<undefined>("T");
    const container = containerWith((s) => s.singleton(T, () => void calls++));
    container.get(T);
    container.get(T);
    expect(calls).toBe(1);
  });

  it("tells classes from factories", () => {
    function OldStyle(this: { kind: string }) {
      this.kind = "constructed";
    }
    OldStyle.prototype.hello = function () {};
    const Arrow = token<{ kind: string }>("Arrow");
    const Plain = token<{ kind: string }>("Plain");
    const Old = token<{ kind: string }>("Old");
    const Async = token<Promise<string>>("Async");
    const container = containerWith((s) =>
      s
        .singleton(Arrow, () => ({ kind: "arrow" }))
        .singleton(Plain, function () {
          return { kind: "plain" };
        })
        .singleton(Old, OldStyle as never)
        .singleton(Async, async () => "later"),
    );
    expect(container.get(Arrow).kind).toBe("arrow");
    expect(container.get(Plain).kind).toBe("plain");
    expect(container.get(Old).kind).toBe("constructed");
    expect(container.get(Async)).toBeInstanceOf(Promise);
  });

  it("passes the container to factories", () => {
    class Pool {}
    const Db = token<{ pool: Pool }>("Db");
    const container = containerWith((s) => s.singleton(Pool).singleton(Db, (c) => ({ pool: c.get(Pool) })));
    expect(container.get(Db).pool).toBe(container.get(Pool));
  });

  it("a later registration for the same key replaces the earlier one; app.services() beats @service", async () => {
    const Greeting = token<string>("Greeting");
    @service({ provides: Greeting }) class Decorated {}
    const app = yerd({ routes: [], services: [Decorated] }).services((s) => s.value(Greeting, "first")).services((s) => s.value(Greeting, "second"));
    await app.boot();
    expect(app.container.get(Greeting)).toBe("second");
  });

  it("services() can override built-ins like Channels' backend and the Logger", async () => {
    const { Logger } = await import("@toyz/yerd");
    const custom = new Logger("custom");
    const app = yerd({ routes: [], services: [] }).services((s) => s.value(Logger, custom));
    await app.boot();
    expect(app.container.get(Logger)).toBe(custom);
  });

  it("refuses configuration after boot", async () => {
    const app = yerd({ routes: [], services: [] });
    await app.boot();
    expect(() => app.services(() => {})).toThrow("services() must be called before the app starts");
    expect(() => app.container).not.toThrow();
  });

  it("app.container throws before boot", () => {
    expect(() => yerd({ routes: [], services: [] }).container).toThrow("The app hasn't booted yet");
  });

  it("@inject fields can't be assigned", async () => {
    class Dep {}
    class Holder {
      @inject(Dep) accessor dep!: Dep;
    }
    const app = yerd({ routes: [], services: [] }).services((s) => s.singleton(Dep).singleton(Holder));
    await app.boot();
    const holder = app.container.get(Holder);
    expect(() => {
      (holder as { dep: Dep }).dep = new Dep();
    }).toThrow("dep is injected and can't be assigned");
  });

  it("an @inject field on an instance no app built resolves through the current scope, or says no app is running", async () => {
    class Dep {}
    class Loose {
      @inject(Dep) accessor dep!: Dep;
    }
    expect(() => new Loose().dep).toThrow("Can't inject Dep: no yerd app is running");
    const app = yerd({ routes: [], services: [] }).services((s) => s.singleton(Dep));
    await app.scope(() => {
      expect(new Loose().dep).toBe(app.container.get(Dep));
    });
  });

  it("resolve() outside any request, hook or scope says so", () => {
    class Anything {}
    expect(() => resolve(Anything)).toThrow("Can't resolve Anything: not inside a yerd request, hook or scope");
    expect(() => resolve(token("Cfg"))).toThrow("Can't resolve token(Cfg): not inside a yerd request, hook or scope");
  });

  it("resolving a scoped service outside a request points at app.scope()", () => {
    class Unit {}
    const container = containerWith((s) => s.scoped(Unit));
    expect(() => container.get(Unit)).toThrow(
      "Unit is scoped (one per request) and was resolved outside a request. Use app.scope(async () => ...) to create a scope by hand.",
    );
  });

  it("caches a transient per owning instance, not per read", async () => {
    let made = 0;
    class Gen {
      readonly n = ++made;
    }
    class Owner {
      @inject(Gen) accessor gen!: Gen;
    }
    const app = yerd({ routes: [], services: [] }).services((s) => s.transient(Gen).transient(Owner));
    await app.scope(() => {
      const a = resolve(Owner);
      const b = resolve(Owner);
      expect(a).not.toBe(b);
      expect(a.gen).toBe(a.gen);
      expect(a.gen).not.toBe(b.gen);
      expect(resolve(Gen)).not.toBe(resolve(Gen));
    });
    expect(made).toBe(4);
  });
});

describe("DI: circular dependencies", () => {
  it("resolves a cycle through lazy @inject fields (read after construction)", async () => {
    const B = token<{ a: unknown }>("B");
    class A {
      @inject(B) accessor b!: { a: unknown };
    }
    class BImpl {
      @inject(A) accessor a!: A;
    }
    const app = yerd({ routes: [], services: [] }).services((s) => s.singleton(A).singleton(B, BImpl));
    await app.boot();
    const a = app.container.get(A);
    expect(a.b.a).toBe(a);
  });

  it("reports a cycle hit during construction with the chain, instead of overflowing the stack", async () => {
    class Left {
      readonly right = resolve(Right);
    }
    class Right {
      readonly left = resolve(Left);
    }
    const app = yerd({ routes: [], services: [] }).services((s) => s.singleton(Left).singleton(Right));
    await app.boot();
    const error = await app.scope(() => resolve(Left)).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Circular dependency: Left -> Right -> Left");
  });

  it("reports a factory that resolves itself", () => {
    const Self = token<unknown>("Self");
    const container = containerWith((s) => s.singleton(Self, (c) => c.get(Self)));
    expect(() => container.get(Self)).toThrow("Circular dependency: token(Self) -> token(Self)");
  });

  it("reports a transient cycle and recovers for the next resolution", () => {
    class Loop {
      readonly again: unknown = container.get(Loop);
    }
    const container = containerWith((s) => s.transient(Loop));
    expect(() => container.get(Loop)).toThrow("Circular dependency: Loop -> Loop");
    // The failed attempt leaves nothing behind.
    expect(() => container.get(Loop)).toThrow("Circular dependency: Loop -> Loop");
  });

  it("a constructor that throws leaves the key resolvable later", () => {
    let fail = true;
    class Flaky {
      constructor() {
        if (fail) throw new Error("not yet");
      }
    }
    const container = containerWith((s) => s.singleton(Flaky));
    expect(() => container.get(Flaky)).toThrow("not yet");
    fail = false;
    expect(container.get(Flaky)).toBeInstanceOf(Flaky);
  });
});

describe("DI: factories and instance tracking", () => {
  it("a factory may return a frozen object", () => {
    const Config = token<{ port: number }>("Config");
    const container = containerWith((s) => s.singleton(Config, () => Object.freeze({ port: 1 })).transient(token("T"), () => Object.freeze({})));
    expect(container.get(Config).port).toBe(1);
  });

  it("a class whose constructor freezes the instance can still be constructed and disposed", async () => {
    let disposed = 0;
    class Frozen {
      constructor() {
        Object.freeze(this);
      }
      [Symbol.dispose]() {
        disposed++;
      }
    }
    const container = containerWith((s) => s.singleton(Frozen));
    expect(container.get(Frozen)).toBeInstanceOf(Frozen);
    await container.dispose();
    expect(disposed).toBe(1);
  });

  it("a factory aliasing another singleton doesn't dispose it twice", async () => {
    let disposed = 0;
    class Pool {
      [Symbol.dispose]() {
        disposed++;
      }
    }
    const IPool = token<Pool>("IPool");
    const container = containerWith((s) => s.singleton(Pool).singleton(IPool, (c) => c.get(Pool)));
    expect(container.get(IPool)).toBe(container.get(Pool));
    await container.dispose();
    expect(disposed).toBe(1);
  });

  it("a scoped factory returning a singleton doesn't dispose the singleton at the end of the request", async () => {
    let disposed = 0;
    class Pool {
      [Symbol.asyncDispose]() {
        disposed++;
        return Promise.resolve();
      }
    }
    const Conn = token<Pool>("Conn");
    const app = yerd({ routes: [], services: [] }).services((s) => s.singleton(Pool).scoped(Conn, (c) => c.get(Pool)));
    await app.scope(() => resolve(Conn));
    await app.scope(() => resolve(Conn));
    expect(disposed).toBe(0);
    await app.stop();
    expect(disposed).toBe(1);
  });

  it("a factory returning a value() registration never disposes it", async () => {
    let disposed = 0;
    const Raw = token<object>("Raw");
    const Alias = token<object>("Alias");
    const raw = { [Symbol.dispose]: () => void disposed++ };
    const app = yerd({ routes: [], services: [] }).services((s) => s.value(Raw, raw).scoped(Alias, (c) => c.get(Raw)));
    await app.scope(() => resolve(Alias));
    await app.stop();
    expect(disposed).toBe(0);
  });
});

describe("DI: disposal", () => {
  it("prefers Symbol.asyncDispose over Symbol.dispose, and awaits it", async () => {
    const log: string[] = [];
    class Both {
      [Symbol.dispose]() {
        log.push("sync");
      }
      async [Symbol.asyncDispose]() {
        await sleep(5);
        log.push("async");
      }
    }
    const container = containerWith((s) => s.singleton(Both));
    container.get(Both);
    await container.dispose();
    expect(log).toEqual(["async"]);
  });

  it("disposes newest first and keeps going past failures, throwing one error as itself", async () => {
    const log: string[] = [];
    const make = (name: string, fail = false) =>
      class {
        [Symbol.dispose]() {
          log.push(name);
          if (fail) throw new Error(`${name} failed`);
        }
      };
    const A = make("a");
    const B = make("b", true);
    const C = make("c");
    const container = containerWith((s) => s.singleton(A).singleton(B).singleton(C));
    container.get(A);
    container.get(B);
    container.get(C);
    await expect(container.dispose()).rejects.toThrow("b failed");
    expect(log).toEqual(["c", "b", "a"]);
  });

  it("throws an AggregateError with every failure, newest first", async () => {
    const make = (name: string) =>
      class {
        async [Symbol.asyncDispose]() {
          throw new Error(name);
        }
      };
    const A = make("a");
    const B = make("b");
    const container = containerWith((s) => s.singleton(A).singleton(B));
    container.get(A);
    container.get(B);
    const error = (await container.dispose().catch((e: unknown) => e)) as AggregateError;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toBe("Several services failed to dispose");
    expect(error.errors.map((e: Error) => e.message)).toEqual(["b", "a"]);
  });

  it("disposing twice disposes once", async () => {
    let disposed = 0;
    class D {
      [Symbol.dispose]() {
        disposed++;
      }
    }
    const container = containerWith((s) => s.singleton(D));
    container.get(D);
    await container.dispose();
    await container.dispose();
    expect(disposed).toBe(1);
  });

  it("ignores dispose members that aren't functions", async () => {
    const Odd = token<object>("Odd");
    const container = containerWith((s) => s.singleton(Odd, () => ({ [Symbol.dispose]: "nope", [Symbol.asyncDispose]: 1 })));
    container.get(Odd);
    await expect(container.dispose()).resolves.toBeUndefined();
  });

  it("app.scope() disposes its scope even when the function throws, and is empty when nothing was resolved", async () => {
    const log: string[] = [];
    class Unit {
      [Symbol.dispose]() {
        log.push("disposed");
      }
    }
    const app = yerd({ routes: [], services: [] }).services((s) => s.scoped(Unit));
    await expect(
      app.scope(() => {
        resolve(Unit);
        throw new Error("script failed");
      }),
    ).rejects.toThrow("script failed");
    expect(log).toEqual(["disposed"]);
    expect(new Scope().isEmpty).toBe(true);
  });

  it("app.scope() gives each call its own scoped instances", async () => {
    class Unit {}
    const app = yerd({ routes: [], services: [] }).services((s) => s.scoped(Unit));
    const a = await app.scope(() => resolve(Unit));
    const b = await app.scope(() => resolve(Unit));
    expect(a).not.toBe(b);
    await app.scope(() => expect(resolve(Unit)).toBe(resolve(Unit)));
  });

  it("logs a scoped disposal failure after a request without changing the response", async () => {
    const records: LogRecord[] = [];
    class Tx {
      [Symbol.dispose]() {
        throw new Error("rollback failed");
      }
    }
    @route("/tx")
    class TxRoute {
      @inject(Tx) accessor tx!: Tx;
      @get show() {
        void this.tx;
        return "committed";
      }
    }
    const server = await yerd({ routes: [TxRoute], services: [], handleSignals: false })
      .services((s) => s.scoped(Tx).value(ILogger, { write: (r) => records.push(r) }))
      .listen(0, "127.0.0.1");
    try {
      const r = await fetch(server.url + "/tx");
      expect([r.status, await r.text()]).toEqual([200, "committed"]);
      await sleep(10);
      const failure = records.find((x) => x.message === "failed to dispose request services")!;
      expect(failure.level).toBe("error");
      expect(failure.error?.message).toBe("rollback failed");
    } finally {
      await server.close();
    }
  });

  it("stop() still flushes the log sink when a singleton fails to dispose, and rejects with that failure", async () => {
    let flushed = 0;
    class Bad {
      [Symbol.dispose]() {
        throw new Error("close failed");
      }
    }
    const app = yerd({ routes: [], services: [] }).services((s) => s.singleton(Bad).value(ILogger, { write() {}, flush: () => void flushed++ }));
    await app.start();
    app.container.get(Bad);
    await expect(app.stop()).rejects.toThrow("close failed");
    expect(flushed).toBe(1);
    // Idempotent: the same outcome again, no second disposal.
    await expect(app.stop()).rejects.toThrow("close failed");
    expect(flushed).toBe(1);
  });
});

describe("DI: scope isolation between concurrent requests", () => {
  it("gives each in-flight request its own scoped instance across awaits", async () => {
    let made = 0;
    class Bag {
      readonly id = ++made;
      items: string[] = [];
    }
    @route("/bag/:name")
    class BagRoute {
      @inject(Bag) accessor bag!: Bag;
      @get async show() {
        const { currentContext } = await import("@toyz/yerd");
        const name = currentContext().params.name!;
        this.bag.items.push(name);
        await sleep(Math.random() * 20);
        const again = resolve(Bag);
        again.items.push(`${name}-again`);
        await sleep(Math.random() * 20);
        return { same: again === this.bag, items: this.bag.items };
      }
    }
    const server = await yerd({ routes: [BagRoute], services: [], handleSignals: false })
      .services((s) => s.scoped(Bag))
      .listen(0, "127.0.0.1");
    try {
      const names = Array.from({ length: 30 }, (_, i) => `n${i}`);
      const results = await Promise.all(names.map(async (n) => (await fetch(`${server.url}/bag/${n}`)).json()));
      results.forEach((result, i) => {
        expect(result).toEqual({ same: true, items: [names[i], `${names[i]}-again`] });
      });
      expect(made).toBe(30);
    } finally {
      await server.close();
    }
  });

  it("keeps two apps in one process apart", async () => {
    const Name = token<string>("Name");
    const one = yerd({ routes: [], services: [] }).services((s) => s.value(Name, "one"));
    const two = yerd({ routes: [], services: [] }).services((s) => s.value(Name, "two"));
    const [a, b] = await Promise.all([
      one.scope(async () => {
        await sleep(5);
        return resolve(Name);
      }),
      two.scope(async () => {
        await sleep(1);
        return resolve(Name);
      }),
    ]);
    expect([a, b]).toEqual(["one", "two"]);
  });

  it("a singleton created inside a request doesn't capture that request's scope", async () => {
    class Unit {}
    class Single {
      seen: unknown;
      constructor() {
        try {
          this.seen = resolve(Unit);
        } catch (error) {
          this.seen = (error as Error).message;
        }
      }
    }
    const app = yerd({ routes: [], services: [] }).services((s) => s.scoped(Unit).singleton(Single));
    const seen = await app.scope(() => resolve(Single).seen);
    expect(seen).toMatch(/Unit is scoped/);
  });

  it("disposes a transient resolved inside a request at the end of that request", async () => {
    const log: string[] = [];
    class Temp {
      [Symbol.dispose]() {
        log.push("temp disposed");
      }
    }
    const app = yerd({ routes: [], services: [] }).services((s) => s.transient(Temp));
    await app.scope(() => {
      resolve(Temp);
      log.push("scope body done");
    });
    expect(log).toEqual(["scope body done", "temp disposed"]);
  });

  it("warns nobody when an unresolved scope ends (no spurious disposal work)", async () => {
    const spy = vi.fn();
    const app = yerd({ routes: [], services: [] }).services((s) => s.value(ILogger, { write: spy }));
    await app.scope(() => {});
    expect(spy).not.toHaveBeenCalled();
  });
});
