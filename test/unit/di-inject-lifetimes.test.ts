import { describe, expect, it } from "vitest";
import { BootError, get, inject, onBoot, param, post, route, scoped, service, token, transient, yerd } from "@toyz/yerd";

let made = 0;

/** Waits out the request's scope disposal, which runs after the response is sent. */
const settle = () => new Promise((r) => setTimeout(r, 10));

async function json(app: ReturnType<typeof yerd>, path: string, init?: RequestInit) {
  return (await app.request(path, init)).json();
}

describe("@inject.scoped", () => {
  it("gives one instance per request, shared by every holder in it, apart from the registered singleton", async () => {
    @service
    class Ledger {
      readonly id = ++made;
    }
    @service
    class Orders {
      @inject.scoped(Ledger) accessor ledger!: Ledger;
    }
    @route("/scoped")
    class Probe {
      @inject.scoped(Ledger) accessor ledger!: Ledger;
      @inject(Ledger) accessor shared!: Ledger;
      @inject(Orders) accessor orders!: Orders;
      @get g() {
        return {
          id: this.ledger.id,
          stable: this.ledger === this.ledger,
          sharedWithOrders: this.ledger === this.orders.ledger,
          apartFromSingleton: this.ledger !== this.shared,
          singleton: this.shared.id,
        };
      }
    }
    const app = yerd({ routes: [Probe], services: [Ledger, Orders], handleSignals: false });
    const a = await json(app, "/scoped");
    const b = await json(app, "/scoped");
    expect(a).toMatchObject({ stable: true, sharedWithOrders: true, apartFromSingleton: true });
    expect(b).toMatchObject({ stable: true, sharedWithOrders: true, apartFromSingleton: true });
    expect(a.id).not.toBe(b.id);
    expect(a.singleton).toBe(b.singleton);
  });

  it("is the usual scoped instance for a key registered scoped", async () => {
    @scoped
    @service
    class Tx {}
    @route("/tx")
    class Probe {
      @inject.scoped(Tx) accessor sited!: Tx;
      @inject(Tx) accessor plain!: Tx;
      @get g() {
        return { same: this.sited === this.plain };
      }
    }
    expect(await json(yerd({ routes: [Probe], services: [Tx], handleSignals: false }), "/tx")).toEqual({ same: true });
  });

  it("lets a singleton follow the current request on every read, concurrent requests included", async () => {
    @scoped
    @service
    class AuditLog {
      readonly lines: string[] = [];
    }
    @service
    class Orders {
      @inject.scoped(AuditLog) accessor audit!: AuditLog;
      async place(id: number) {
        this.audit.lines.push(`order ${id}`);
        await new Promise((r) => setTimeout(r, 5));
        this.audit.lines.push(`paid ${id}`);
      }
    }
    @route("/orders/:id")
    class Place {
      @param("id") accessor id!: string;
      @inject(Orders) accessor orders!: Orders;
      @inject(AuditLog) accessor audit!: AuditLog;
      @post async place() {
        await this.orders.place(Number(this.id));
        return { same: this.orders.audit === this.audit, lines: this.audit.lines };
      }
    }
    const app = yerd({ routes: [Place], services: [AuditLog, Orders], handleSignals: false });
    // Interleaved: each place() awaits between its two lines.
    const responses = await Promise.all([1, 2, 3].map((id) => json(app, `/orders/${id}`, { method: "POST" })));
    expect(responses).toEqual([1, 2, 3].map((id) => ({ same: true, lines: [`order ${id}`, `paid ${id}`] })));
  });

  it("resolves in a singleton's constructor when the singleton is first made during a request", async () => {
    @scoped
    @service
    class AuditLog {}
    @service
    class Orders {
      @inject.scoped(AuditLog) accessor audit!: AuditLog;
      readonly first: AuditLog;
      constructor() {
        this.first = this.audit;
      }
    }
    @route("/orders")
    class Place {
      @inject(Orders) accessor orders!: Orders;
      @inject(AuditLog) accessor audit!: AuditLog;
      @get show() {
        return { same: this.orders.first === this.audit };
      }
    }
    const app = yerd({ routes: [Place], services: [AuditLog, Orders], handleSignals: false });
    expect(await json(app, "/orders")).toEqual({ same: true });
  });

  it("throws outside a request, naming the class and field; app.scope() has a scope", async () => {
    @scoped
    @service
    class AuditLog {}
    @service
    class Orders {
      @inject.scoped(AuditLog) accessor audit!: AuditLog;
    }
    const app = yerd({ routes: [], services: [AuditLog, Orders], handleSignals: false });
    await app.boot();
    const orders = app.container.get(Orders);
    expect(() => orders.audit).toThrow(/^Orders\.audit: @inject\.scoped\(AuditLog\) is one per request and was read outside one/);
    expect(await app.scope(() => orders.audit instanceof AuditLog)).toBe(true);
  });

  it("throws in an @onBoot hook", async () => {
    @service
    class AuditLog {}
    @service
    class Warmup {
      @inject.scoped(AuditLog) accessor audit!: AuditLog;
      @onBoot warm() {
        void this.audit;
      }
    }
    const app = yerd({ routes: [], services: [AuditLog, Warmup], handleSignals: false });
    await expect(app.start()).rejects.toThrow(/Warmup\.audit: @inject\.scoped\(AuditLog\) is one per request/);
    await app.stop();
  });

  it("disposes the per-request instance at the end of the request, the registered singleton at shutdown", async () => {
    const disposed: number[] = [];
    @service
    class Conn {
      readonly id = ++made;
      [Symbol.dispose]() {
        disposed.push(this.id);
      }
    }
    @route("/conn")
    class Probe {
      @inject.scoped(Conn) accessor conn!: Conn;
      @inject(Conn) accessor shared!: Conn;
      @get g() {
        return { conn: this.conn.id, shared: this.shared.id };
      }
    }
    const app = yerd({ routes: [Probe], services: [Conn], handleSignals: false });
    const { conn, shared } = await json(app, "/conn");
    await settle();
    expect(disposed).toEqual([conn]);
    await app.stop();
    expect(disposed).toEqual([conn, shared]);
  });
});

describe("@inject.transient", () => {
  it("makes a new instance on every read", async () => {
    @service
    class Hasher {
      readonly id = ++made;
    }
    @route("/hash")
    class Probe {
      @inject.transient(Hasher) accessor hasher!: Hasher;
      @get g() {
        return { fresh: this.hasher !== this.hasher, isHasher: this.hasher instanceof Hasher };
      }
    }
    expect(await json(yerd({ routes: [Probe], services: [Hasher], handleSignals: false }), "/hash")).toEqual({ fresh: true, isHasher: true });
  });

  it("disposes what a request made at its end, even when a singleton holds the field", async () => {
    let disposed = 0;
    @service
    class Hasher {
      [Symbol.dispose]() {
        disposed++;
      }
    }
    @service
    class Users {
      @inject.transient(Hasher) accessor hasher!: Hasher;
    }
    @route("/users")
    class Probe {
      @inject(Users) accessor users!: Users;
      @get g() {
        void this.users.hasher;
        void this.users.hasher;
        return "ok";
      }
    }
    const app = yerd({ routes: [Probe], services: [Hasher, Users], handleSignals: false });
    await (await app.request("/users")).text();
    await settle();
    expect(disposed).toBe(2);
    await app.stop();
    expect(disposed).toBe(2);
  });

  it("doesn't track instances made outside a request (the caller owns them)", async () => {
    let disposed = 0;
    @service
    class Hasher {
      [Symbol.dispose]() {
        disposed++;
      }
    }
    @service
    class Users {
      @inject.transient(Hasher) accessor hasher!: Hasher;
    }
    const app = yerd({ routes: [], services: [Hasher, Users], handleSignals: false });
    await app.start();
    const users = app.container.get(Users);
    void users.hasher;
    void users.hasher;
    await app.stop();
    expect(disposed).toBe(0);
  });
});

describe("@inject.instance", () => {
  it("keeps one instance per holder, apart from the registered singleton", async () => {
    @service
    class OrderState {
      readonly id = ++made;
    }
    @service
    class Checkout {
      @inject.instance(OrderState) accessor state!: OrderState;
    }
    @route("/state")
    class Probe {
      @inject.instance(OrderState) accessor state!: OrderState;
      @inject(OrderState) accessor shared!: OrderState;
      @inject(Checkout) accessor checkout!: Checkout;
      @get g() {
        return {
          stable: this.state === this.state,
          perHolder: this.state !== this.checkout.state,
          apartFromSingleton: this.state !== this.shared && this.checkout.state !== this.shared,
          checkout: this.checkout.state.id,
        };
      }
    }
    const app = yerd({ routes: [Probe], services: [OrderState, Checkout], handleSignals: false });
    const a = await json(app, "/state");
    const b = await json(app, "/state");
    expect(a).toMatchObject({ stable: true, perHolder: true, apartFromSingleton: true });
    // Checkout is a singleton: its own OrderState is kept across requests.
    expect(a.checkout).toBe(b.checkout);
  });

  it("is disposed with its holder: a route's at the end of the request, a singleton's at shutdown", async () => {
    const disposed: string[] = [];
    @service
    class OrderState {
      holder = "";
      [Symbol.dispose]() {
        disposed.push(this.holder);
      }
    }
    @service
    class Checkout {
      @inject.instance(OrderState) accessor state!: OrderState;
    }
    @route("/state")
    class Probe {
      @inject.instance(OrderState) accessor state!: OrderState;
      @inject(Checkout) accessor checkout!: Checkout;
      @get g() {
        this.state.holder = "route";
        this.checkout.state.holder = "checkout";
        return "ok";
      }
    }
    const app = yerd({ routes: [Probe], services: [OrderState, Checkout], handleSignals: false });
    await (await app.request("/state")).text();
    await (await app.request("/state")).text();
    await settle();
    expect(disposed).toEqual(["route", "route"]);
    await app.stop();
    expect(disposed).toEqual(["route", "route", "checkout"]);
  });
});

describe("injection-site lifetimes at boot", () => {
  it("refuse a value() registration, naming the class, field and why", async () => {
    const Config = token<{ url: string }>("Config");
    @route("/config")
    class Probe {
      @inject(Config) accessor plain!: { url: string };
      @inject.scoped(Config) accessor a!: { url: string };
      @inject.transient(Config) accessor b!: { url: string };
      @inject.instance(Config) accessor c!: { url: string };
      @get g() {
        return 1;
      }
    }
    const app = yerd({ routes: [Probe], services: [], handleSignals: false }).services((s) => s.value(Config, { url: "x" }));
    const error = (await app.boot().catch((e: unknown) => e)) as BootError;
    expect(error).toBeInstanceOf(BootError);
    const why = "can't re-scope a value() registration, which is one existing object; register a class or a factory, or use plain @inject";
    expect(error.problems).toEqual([
      `Probe.a: @inject.scoped(token(Config)) ${why}`,
      `Probe.b: @inject.transient(token(Config)) ${why}`,
      `Probe.c: @inject.instance(token(Config)) ${why}`,
    ]);
  });

  it("accept a factory registration, re-run per site lifetime", async () => {
    const Clock = token<{ id: number }>("Clock");
    @route("/clock")
    class Probe {
      @inject(Clock) accessor plain!: { id: number };
      @inject.scoped(Clock) accessor perRequest!: { id: number };
      @get g() {
        return { apart: this.plain !== this.perRequest, stable: this.perRequest === this.perRequest };
      }
    }
    const app = yerd({ routes: [Probe], services: [], handleSignals: false }).services((s) => s.singleton(Clock, () => ({ id: ++made })));
    expect(await json(app, "/clock")).toEqual({ apart: true, stable: true });
  });

  it("don't trip the captive-dependency check, which still refuses plain @inject", async () => {
    @scoped
    @service
    class RequestStats {}
    @service
    class Explicit {
      @inject.scoped(RequestStats) accessor stats!: RequestStats;
      @inject.transient(RequestStats) accessor fresh!: RequestStats;
      @inject.instance(RequestStats) accessor own!: RequestStats;
    }
    @service
    class Captive {
      @inject(RequestStats) accessor stats!: RequestStats;
    }
    await yerd({ routes: [], services: [RequestStats, Explicit], handleSignals: false }).boot();
    const error = (await yerd({ routes: [], services: [RequestStats, Explicit, Captive] }).boot().catch((e: unknown) => e)) as BootError;
    expect(error.problems).toEqual(["Captive (singleton) -> RequestStats (scoped): a singleton can't hold a per-request service"]);
  });

  it("refuse a key nothing provides, like plain @inject", async () => {
    class Unregistered {}
    @service
    class Needs {
      @inject.scoped(Unregistered) accessor u!: Unregistered;
    }
    const error = (await yerd({ routes: [], services: [Needs] }).boot().catch((e: unknown) => e)) as BootError;
    expect(error.problems).toEqual(["Needs.u: nothing is registered for Unregistered (@service it, or app.services(...))"]);
  });
});

describe("injection-site lifetimes and registrations", () => {
  interface Mailer {
    readonly id: number;
    send(to: string): string;
  }
  const Mailer = token<Mailer>("Mailer");

  @service({ provides: Mailer })
  class SmtpMailer implements Mailer {
    readonly id = ++made;
    send(to: string) {
      return `smtp:${to}`;
    }
  }
  class FakeMailer implements Mailer {
    readonly id = ++made;
    send(to: string) {
      return `fake:${to}`;
    }
  }

  @route("/mail")
  class MailProbe {
    @inject.scoped(Mailer) accessor scoped!: Mailer;
    @inject.transient(Mailer) accessor transient!: Mailer;
    @inject.instance(Mailer) accessor instance!: Mailer;
    @get g() {
      return {
        sends: [this.scoped.send("a"), this.transient.send("b"), this.instance.send("c")],
        fake: [this.scoped, this.transient, this.instance].every((m) => m instanceof FakeMailer),
      };
    }
  }

  it("follow app.services() overrides", async () => {
    const plain = yerd({ routes: [MailProbe], services: [SmtpMailer], handleSignals: false });
    expect((await json(plain, "/mail")).sends).toEqual(["smtp:a", "smtp:b", "smtp:c"]);
    const faked = yerd({ routes: [MailProbe], services: [SmtpMailer], handleSignals: false }).services((s) => s.singleton(Mailer, FakeMailer));
    expect(await json(faked, "/mail")).toEqual({ sends: ["fake:a", "fake:b", "fake:c"], fake: true });
  });

  it("work for a key registered transient", async () => {
    @transient
    @service
    class IdGen {
      readonly id = ++made;
    }
    @route("/ids")
    class Probe {
      @inject.scoped(IdGen) accessor a!: IdGen;
      @inject.scoped(IdGen) accessor b!: IdGen;
      @inject.instance(IdGen) accessor c!: IdGen;
      @get g() {
        return { shared: this.a === this.b, own: this.c !== this.a && this.c === this.c };
      }
    }
    expect(await json(yerd({ routes: [Probe], services: [IdGen], handleSignals: false }), "/ids")).toEqual({ shared: true, own: true });
  });

  it("are inherited: a subclass gets its parent's injected fields and their boot checks", async () => {
    @service
    class Ledger {
      readonly id = ++made;
    }
    const Config = token<string>("Config");
    class Base {
      @inject.scoped(Ledger) accessor ledger!: Ledger;
      @inject.instance(Ledger) accessor own!: Ledger;
    }
    @route("/child")
    class Child extends Base {
      @inject.transient(Ledger) accessor fresh!: Ledger;
      @get g() {
        return {
          scoped: this.ledger === this.ledger,
          instance: this.own === this.own && this.own !== this.ledger,
          transient: this.fresh !== this.fresh,
        };
      }
    }
    const app = yerd({ routes: [Child], services: [Ledger], handleSignals: false });
    expect(await json(app, "/child")).toEqual({ scoped: true, instance: true, transient: true });

    class BadBase {
      @inject.scoped(Config) accessor config!: string;
    }
    @route("/bad-child")
    class BadChild extends BadBase {
      @get g() {
        return 1;
      }
    }
    const error = (await yerd({ routes: [BadChild], services: [] }).services((s) => s.value(Config, "x")).boot().catch((e: unknown) => e)) as BootError;
    expect(error.problems).toEqual([
      "BadChild.config: @inject.scoped(token(Config)) can't re-scope a value() registration, which is one existing object; register a class or a factory, or use plain @inject",
    ]);
  });

  it("can't be assigned", async () => {
    @service
    class Ledger {}
    @service
    class Holder {
      @inject.instance(Ledger) accessor ledger!: Ledger;
    }
    const app = yerd({ routes: [], services: [Ledger, Holder], handleSignals: false });
    await app.boot();
    expect(() => {
      app.container.get(Holder).ledger = new Ledger();
    }).toThrow(/ledger is injected and can't be assigned/);
  });
});

describe("the services guide's audit log", () => {
  it("answers as the guide shows", async () => {
    @scoped
    @service
    class AuditLog {
      readonly lines: string[] = [];
    }
    @service
    class Orders {
      @inject.scoped(AuditLog) accessor audit!: AuditLog;
      place(id: number) {
        this.audit.lines.push(`order ${id} placed`);
      }
    }
    @route("/api/orders")
    class OrdersApi {
      @inject(Orders) accessor orders!: Orders;
      @inject(AuditLog) accessor audit!: AuditLog;
      @post place() {
        this.orders.place(1001);
        this.orders.place(1002);
        return this.audit.lines;
      }
    }
    const app = yerd({ routes: [OrdersApi], services: [AuditLog, Orders], handleSignals: false });
    for (let i = 0; i < 2; i++) {
      const res = await app.request("/api/orders", { method: "POST" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await res.text()).toBe('["order 1001 placed","order 1002 placed"]');
    }
  });
});
