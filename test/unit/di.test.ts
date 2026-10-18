import { describe, expect, it } from "vitest";
import {
  BootError, get, inject, maybe, route, scoped, service, singleton, token, transient, yerd,
} from "@toyz/yerd";

let created = 0;

@service
class Clock {
  readonly id = ++created;
  now() {
    return 1700000000000;
  }
}

@service({ lifetime: "scoped" })
class RequestLog {
  readonly id = ++created;
  readonly lines: string[] = [];
}

@transient
@service
class IdGen {
  readonly id = ++created;
}

interface Mailer {
  send(to: string): string;
}
const Mailer = token<Mailer>("Mailer");

@service({ provides: Mailer })
class SmtpMailer implements Mailer {
  send(to: string) {
    return `smtp:${to}`;
  }
}

class FakeMailer implements Mailer {
  send(to: string) {
    return `fake:${to}`;
  }
}

@service({ lifetime: "scoped" })
class Handler {
  @inject(RequestLog) accessor log!: RequestLog;
  @inject(IdGen) accessor gen!: IdGen;
}

@route("/di")
class DiRoute {
  @inject(Clock) accessor clock!: Clock;
  @inject(RequestLog) accessor log!: RequestLog;
  @inject(Handler) accessor handler!: Handler;
  @inject(IdGen) accessor gen!: IdGen;
  @inject(Mailer) accessor mailer!: Mailer;
  @maybe(token<string>("missing")) accessor missing: string | undefined;

  @get show() {
    return {
      clock: this.clock.id,
      sameLog: this.log === this.handler.log,
      log: this.log.id,
      genStable: this.gen === this.gen,
      genPerOwner: this.gen !== this.handler.gen,
      mail: this.mailer.send("ada"),
      missing: this.missing ?? null,
    };
  }
}

@singleton
@route("/counter")
class Counter {
  count = 0;
  @get hit() {
    return { count: ++this.count };
  }
}

const services = [Clock, RequestLog, IdGen, SmtpMailer, Handler];

async function call(app: ReturnType<typeof yerd>, path: string) {
  const server = await app.listen(0, "127.0.0.1");
  try {
    return await (await fetch(server.url + path)).json();
  } finally {
    await server.close();
  }
}

describe("DI lifetimes", () => {
  it("singleton per app, scoped per request, transient per owner", async () => {
    const app = yerd({ routes: [DiRoute], services, handleSignals: false });
    const server = await app.listen(0, "127.0.0.1");
    try {
      const a = await (await fetch(server.url + "/di")).json();
      const b = await (await fetch(server.url + "/di")).json();
      expect(a).toMatchObject({ sameLog: true, genStable: true, genPerOwner: true, mail: "smtp:ada", missing: null });
      expect(a.clock).toBe(b.clock);
      expect(a.log).not.toBe(b.log);
    } finally {
      await server.close();
    }
  });

  it("lets app.services() override decorator registrations", async () => {
    const app = yerd({ routes: [DiRoute], services, handleSignals: false }).services((s) => s.singleton(Mailer, FakeMailer));
    expect((await call(app, "/di")).mail).toBe("fake:ada");
  });

  it("keeps one instance of a singleton route", async () => {
    const app = yerd({ routes: [Counter], services: [], handleSignals: false });
    const server = await app.listen(0, "127.0.0.1");
    try {
      await fetch(server.url + "/counter");
      expect(await (await fetch(server.url + "/counter")).json()).toEqual({ count: 2 });
    } finally {
      await server.close();
    }
  });

  it("refuses to resolve scoped services outside a request, except in app.scope()", async () => {
    const app = yerd({ routes: [], services, handleSignals: false });
    await app.boot();
    expect(() => app.container.get(RequestLog)).toThrow(/scoped .* outside a request/);
    const fromScope = await app.scope(async () => {
      @route("/unused")
      class Probe {
        @inject(RequestLog) accessor log!: RequestLog;
        @get g() {
          return 1;
        }
      }
      return new Probe().log instanceof RequestLog;
    }).catch((e: unknown) => e);
    expect(fromScope).toBe(true);
  });
});

describe("DI boot checks", () => {
  it("refuses a singleton that injects a scoped service", async () => {
    @service
    class Captive {
      @inject(RequestLog) accessor log!: RequestLog;
    }
    const error = (await yerd({ routes: [], services: [RequestLog, Captive] }).boot().catch((e: unknown) => e)) as BootError;
    expect(error).toBeInstanceOf(BootError);
    expect(error.problems).toEqual([
      "Captive (singleton) -> RequestLog (scoped): a singleton can't hold a per-request service",
    ]);
  });

  it("refuses injections nothing provides", async () => {
    class Unregistered {}
    @route("/x")
    class Needs {
      @inject(Unregistered) accessor u!: Unregistered;
      @get g() {
        return 1;
      }
    }
    const error = (await yerd({ routes: [Needs], services: [] }).boot().catch((e: unknown) => e)) as BootError;
    expect(error.problems[0]).toMatch(/Needs.u: nothing is registered for Unregistered/);
  });

  it("refuses lifecycle hooks on scoped services", async () => {
    const { onBoot } = await import("@toyz/yerd");
    @scoped
    @service
    class Wrong {
      @onBoot init() {}
    }
    const error = (await yerd({ routes: [], services: [Wrong] }).boot().catch((e: unknown) => e)) as BootError;
    expect(error.problems[0]).toMatch(/Wrong \(scoped\): @onBoot, @onShutdown, @every, @on and @handles need a singleton service/);
  });
});

describe("disposal", () => {
  it("disposes scoped services after the request and singletons at shutdown, newest first", async () => {
    const order: string[] = [];
    @service
    class Pool {
      [Symbol.asyncDispose]() {
        order.push("pool");
        return Promise.resolve();
      }
    }
    @service
    class Cache {
      @inject(Pool) accessor pool!: Pool;
      [Symbol.dispose]() {
        order.push("cache");
      }
    }
    @service({ lifetime: "scoped" })
    class Tx {
      [Symbol.dispose]() {
        order.push("tx");
      }
    }
    @route("/tx")
    class TxRoute {
      @inject(Tx) accessor tx!: Tx;
      @inject(Cache) accessor cache!: Cache;
      @get g() {
        void this.cache.pool;
        void this.tx;
        return "ok";
      }
    }
    const server = await yerd({ routes: [TxRoute], services: [Pool, Cache, Tx], handleSignals: false }).listen(0, "127.0.0.1");
    await (await fetch(server.url + "/tx")).text();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["tx"]);
    await server.close();
    expect(order).toEqual(["tx", "pool", "cache"]);
  });
});

describe("disposal by owner lifetime", () => {
  it("keeps a singleton's transient alive past the request that first read it", async () => {
    const disposed: string[] = [];
    @transient
    @service
    class Conn {
      [Symbol.dispose]() {
        disposed.push("conn");
      }
    }
    @service
    class Repo {
      @inject(Conn) accessor conn!: Conn;
    }
    @route("/repo")
    class RepoRoute {
      @inject(Repo) accessor repo!: Repo;
      @get g() {
        void this.repo.conn;
        return "ok";
      }
    }
    const server = await yerd({ routes: [RepoRoute], services: [Conn, Repo], handleSignals: false }).listen(0, "127.0.0.1");
    await (await fetch(server.url + "/repo")).text();
    await (await fetch(server.url + "/repo")).text();
    await new Promise((r) => setTimeout(r, 10));
    expect(disposed).toEqual([]);
    await server.close();
    expect(disposed).toEqual(["conn"]);
  });

  it("doesn't track transients resolved directly outside a scope (the caller owns them)", async () => {
    let disposed = 0;
    @transient
    @service
    class Temp {
      [Symbol.dispose]() {
        disposed++;
      }
    }
    @transient
    @service
    class Holder {
      @inject(Temp) accessor temp!: Temp;
    }
    const app = yerd({ routes: [], services: [Temp, Holder], handleSignals: false });
    await app.start();
    for (let i = 0; i < 3; i++) void app.container.get(Temp);
    void app.container.get(Holder).temp;
    await app.stop();
    expect(disposed).toBe(0);
  });

  it("disposes factory-created instances, but never value() registrations", async () => {
    const disposed: string[] = [];
    class Pool {
      constructor(readonly name: string) {}
      [Symbol.dispose]() {
        disposed.push(this.name);
      }
    }
    const Shared = token<Pool>("Shared");
    const Scratch = token<Pool>("Scratch");
    @route("/pool")
    class PoolRoute {
      @inject(Pool) accessor pool!: Pool;
      @inject(Shared) accessor shared!: Pool;
      @inject(Scratch) accessor scratch!: Pool;
      @get g() {
        return [this.pool.name, this.shared.name, this.scratch.name].join();
      }
    }
    const app = yerd({ routes: [PoolRoute], services: [], handleSignals: false }).services((s) =>
      s.singleton(Pool, () => new Pool("pool")).value(Shared, new Pool("value")).transient(Scratch, () => new Pool("scratch")),
    );
    const server = await app.listen(0, "127.0.0.1");
    expect(await (await fetch(server.url + "/pool")).text()).toBe("pool,value,scratch");
    await new Promise((r) => setTimeout(r, 10));
    expect(disposed).toEqual(["scratch"]);
    await server.close();
    expect(disposed).toEqual(["scratch", "pool"]);
  });
});
