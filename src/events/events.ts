/**
 * Events: an app-wide bus for things that happened (OrderPlaced) and calls
 * that want an answer (QuoteShipping), between services in this process or,
 * through a transport, other instances and other apps.
 *
 * ```ts
 * @named("order.placed")
 * export class OrderPlaced {
 *   constructor(readonly orderId: string, readonly total: number) {}
 * }
 *
 * // In a handler: delivered once the request has succeeded.
 * @inject(Events) accessor events!: Events;
 * @post checkout() {
 *   const order = this.orders.place();
 *   this.events.emit(new OrderPlaced(order.id, order.total));
 *   return redirect(`/orders/${order.id}`);
 * }
 *
 * // Any singleton service reacts, in the background, in its own DI scope.
 * @service class Receipts {
 *   @inject(Mailer) accessor mailer!: Mailer;
 *   @on(OrderPlaced, { retries: 3 }) async send(e: OrderPlaced) {
 *     await this.mailer.send("orders@example.com", `Order ${e.orderId}: ${e.total}`);
 *   }
 * }
 *
 * // A call: one handler answers, the caller awaits its typed result.
 * @named("shipping.quote")
 * export class QuoteShipping extends Call<number> { constructor(readonly grams: number) { super(); } }
 * @service class Shipping { @handles(QuoteShipping) quote(q: QuoteShipping) { return q.grams * 2; } }
 * const cents = await this.events.call(new QuoteShipping(1200)); // number
 * ```
 *
 * - Events emitted while a request runs wait for it: if the handler throws,
 *   they're dropped, so a failed checkout never sends its receipt. Outside a
 *   request (a job, another event's handler) they go at once.
 * - Each `@on` handler gets an event once, even with several instances
 *   sharing a transport (handlers are consumer groups). `{ every: true }`
 *   delivers to every instance instead (dropping a local cache, say).
 * - Events travel as JSON, also in memory, so handlers can't share or
 *   mutate one object and nothing works only until the first deploy with a
 *   real transport. They arrive as instances of their class, built without
 *   running the constructor; a static `fromJSON(data)` takes over when
 *   there's one (for Dates, Maps...).
 * - The default transport is in-process. For several instances register
 *   your own EventTransport (Redis Streams, NATS queue groups, a queue).
 */

import { randomUUID } from "node:crypto";
import { createKey } from "../decorators/keys.js";
import { parseDuration } from "../di/decorators.js";
import { Scope, runWithServices, token, type Container } from "../di/container.js";
import { Logger } from "../log/logger.js";
import { HttpError } from "../respond/response.js";
import { maybeContext, outsideRequest, type YerdContext } from "../server/context.js";

const log = new Logger("yerd::events");

// ── event classes ──

type EventClass<E = object> = abstract new (...args: never[]) => E;

const NAMES = new WeakMap<Function, string>();
const CLASSES = new Map<string, Function>();

/**
 * Give an event (or call) class a stable name: what it's called on the wire
 * and in logs. Without one, the class name is used, which a minifier can
 * change and two apps may not agree on; name anything that leaves the process.
 * Two classes with the same name throw when the second is defined.
 *
 * ```ts
 * @named("order.placed")
 * export class OrderPlaced {
 *   constructor(readonly orderId: string, readonly total: number) {}
 * }
 * ```
 */
export function named(name: string) {
  return (cls: Function, _context: ClassDecoratorContext): void => {
    const taken = CLASSES.get(name);
    if (taken && taken !== cls) throw new TypeError(`Two event classes are named "${name}": ${taken.name} and ${cls.name}`);
    NAMES.set(cls, name);
    CLASSES.set(name, cls);
  };
}

/**
 * An event class's wire name: its @named name, else the class name. Handy in
 * logs, metrics and custom transports.
 *
 * ```ts
 * eventName(OrderPlaced); // "order.placed"
 * ```
 */
export function eventName(cls: Function): string {
  return NAMES.get(cls) ?? cls.name;
}

/**
 * A call: an event that wants an answer of type `R`. One `@handles` method
 * answers it; `events.call()` resolves to what that returns. Extend it (and
 * call `super()`), and give it a @named name like any event.
 *
 * ```ts
 * @named("shipping.quote")
 * export class QuoteShipping extends Call<number> {
 *   constructor(readonly grams: number, readonly country: string) {
 *     super();
 *   }
 * }
 *
 * const cents = await this.events.call(new QuoteShipping(1200, "US")); // number
 * ```
 */
export abstract class Call<R> {
  /** Type-only: the answer. */
  declare readonly __result?: R;
}

/**
 * What `events.call(x)` resolves to for a call class. For helpers that pass
 * calls through and keep their result type.
 *
 * ```ts
 * function ask<C extends Call<any>>(events: Events, call: C): Promise<ResultOf<C>> {
 *   return events.call(call, { timeout: "2s" });
 * }
 * ```
 */
export type ResultOf<C> = C extends Call<infer R> ? R : never;

function toWire(value: object): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function fromWire<E>(cls: Function, data: unknown): E {
  const custom = (cls as { fromJSON?: (data: unknown) => E }).fromJSON;
  if (typeof custom === "function") return custom.call(cls, data);
  return Object.assign(Object.create((cls as { prototype: object }).prototype) as object, data) as E;
}

// ── handlers ──

/** Options for @on. */
export interface OnOptions {
  /**
   * Run again this many times when it throws. Default 0.
   *
   * ```ts
   * @on(OrderPlaced, { retries: 3 }) async send(e: OrderPlaced) {
   *   await this.mailer.send("orders@example.com", `Order ${e.orderId}`);
   * }
   * ```
   */
  retries?: number;
  /**
   * Wait before the first retry, doubling after each ("500ms", "2s"). Default "1s".
   *
   * ```ts
   * // Retries after 2s, 4s, 8s, then 16s.
   * @on(OrderPlaced, { retries: 4, backoff: "2s" }) reserve(e: OrderPlaced) {
   *   return this.stock.reserve(e.orderId);
   * }
   * ```
   */
  backoff?: string | number;
  /**
   * Every instance gets the event, not just one of them (for in-process state, like caches).
   *
   * ```ts
   * @on(PriceChanged, { every: true }) forget(e: PriceChanged) { this.cache.delete(e.sku); }
   * ```
   */
  every?: boolean;
}

export interface OnEntry {
  method: string | symbol;
  type: Function;
  options: OnOptions;
}

export interface HandlesEntry {
  method: string | symbol;
  type: Function;
}

export const ON_EVENT = createKey<OnEntry[]>("events:on");
export const HANDLES = createKey<HandlesEntry[]>("events:handles");

/**
 * Run this method of a singleton service whenever an event of this class is
 * emitted: in the background, in its own DI scope, after the emitting request
 * has succeeded. Failures are logged (after any retries), never shown to the user.
 * Each handler is its own consumer group, so with several instances on a shared
 * transport it still runs once per event (unless `every: true`).
 *
 * A service that only has handlers is never injected anywhere, so import its
 * module from the app's entry (or `discover()` it), or it never registers.
 *
 * ```ts
 * @service
 * export class Receipts {
 *   @inject(Mailer) accessor mailer!: Mailer;
 *
 *   @on(OrderPlaced, { retries: 3, backoff: "2s" }) async send(e: OrderPlaced) {
 *     await this.mailer.send("orders@example.com", `Order ${e.orderId}: ${e.total}`);
 *   }
 * }
 * ```
 */
export function on<E extends object>(type: EventClass<E>, options: OnOptions = {}) {
  if (options.retries !== undefined && (!Number.isInteger(options.retries) || options.retries < 0)) {
    throw new TypeError("@on retries must be a whole number of at least 0");
  }
  if (options.backoff !== undefined) parseDuration(options.backoff);
  return (_method: (this: any, event: E) => unknown, context: ClassMethodDecoratorContext): void => {
    if (context.static || context.private) throw new TypeError("@on must decorate a public instance method");
    ON_EVENT.ownArray<OnEntry>(context.metadata).push({ method: context.name, type, options });
  };
}

/**
 * Answer calls of this class (see Call) on a singleton service. One handler
 * per call class in an app (two is a boot error). The return value is the
 * caller's result; an HttpError thrown here reaches the caller as an HttpError.
 *
 * ```ts
 * @service
 * export class Shipping {
 *   @handles(QuoteShipping) quote(q: QuoteShipping): number {
 *     if (q.country === "AQ") throw new HttpError(422, "We don't ship to Antarctica");
 *     return 499 + Math.ceil(q.grams / 500) * 150;
 *   }
 * }
 * ```
 */
export function handles<C extends Call<any>>(type: EventClass<C>) {
  return (_method: (this: any, call: C) => ResultOf<C> | Promise<ResultOf<C>>, context: ClassMethodDecoratorContext): void => {
    if (context.static || context.private) throw new TypeError("@handles must decorate a public instance method");
    HANDLES.ownArray<HandlesEntry>(context.metadata).push({ method: context.name, type });
  };
}

// ── transport ──

/**
 * How events travel. Topics are named after event classes; every
 * subscription belongs to a group, and a message goes to each group once (to
 * one member of it). Map it onto Redis Streams consumer groups, NATS queue
 * groups, or a queue per group. Messages are plain JSON-safe values; yerd
 * names the topics and groups.
 *
 * A sketch over NATS, whose queue groups are exactly this model:
 *
 * ```ts
 * export class NatsTransport implements EventTransport {
 *   constructor(private readonly nc: NatsConnection) {}
 *
 *   publish(topic: string, message: unknown) {
 *     this.nc.publish(topic, JSON.stringify(message)); // no count: an unanswered call times out
 *   }
 *
 *   subscribe(topic: string, group: string, deliver: (message: unknown) => void | Promise<void>) {
 *     const sub = this.nc.subscribe(topic, {
 *       queue: group, // one member of the group gets each message
 *       callback: (_error, data) => void deliver(JSON.parse(data)),
 *     });
 *     return () => sub.unsubscribe();
 *   }
 * }
 *
 * app.services((s) => s.value(EventTransport, new NatsTransport(nc)));
 * ```
 */
export interface EventTransport {
  /**
   * Send `message` to every group subscribed to `topic`. May return how many
   * groups it reached, when it knows: a call that reaches none fails at once
   * instead of timing out.
   *
   * ```ts
   * async publish(topic: string, message: unknown) {
   *   const groups = await this.redis.smembers(`groups:${topic}`);
   *   for (const group of groups) await this.redis.rpush(`queue:${topic}:${group}`, JSON.stringify(message));
   *   return groups.length;
   * }
   * ```
   */
  publish(topic: string, message: unknown): number | void | Promise<number | void>;
  /**
   * Join `group` on `topic`: each message for the group goes to one of its
   * members. Returns a function that leaves. Errors thrown by `deliver` are
   * yerd's to log; the transport only needs to keep going.
   *
   * ```ts
   * subscribe(topic: string, group: string, deliver: (message: unknown) => void | Promise<void>) {
   *   const sub = this.nc.subscribe(topic, { queue: group, callback: (_error, data) => void deliver(JSON.parse(data)) });
   *   return () => sub.unsubscribe();
   * }
   * ```
   */
  subscribe(topic: string, group: string, deliver: (message: unknown) => void | Promise<void>): () => void;
}

/** DI token for a custom transport: `app.services((s) => s.value(EventTransport, myTransport))`. */
export const EventTransport = token<EventTransport>("EventTransport");

/**
 * One process: the default when no EventTransport is registered. Groups take
 * turns among their members; delivery is asynchronous, never inside
 * publish(). Construct one yourself to drive an Events bus in a unit test.
 *
 * ```ts
 * const events = new Events(new MemoryTransport());
 * const next = events.waitFor(OrderPlaced);
 * await events.emitNow(new OrderPlaced("o1", 42));
 * (await next).total; // 42
 * ```
 */
export class MemoryTransport implements EventTransport {
  readonly #topics = new Map<string, Map<string, { members: Array<(message: unknown) => void | Promise<void>>; next: number }>>();

  publish(topic: string, message: unknown): number {
    const groups = this.#topics.get(topic);
    if (!groups) return 0;
    let reached = 0;
    for (const group of groups.values()) {
      if (group.members.length === 0) continue;
      const deliver = group.members[group.next++ % group.members.length]!;
      reached++;
      queueMicrotask(() => {
        void Promise.resolve()
          .then(() => deliver(message))
          .catch((error) => log.error(`delivery on ${topic} failed`, { error }));
      });
    }
    return reached;
  }

  subscribe(topic: string, group: string, deliver: (message: unknown) => void | Promise<void>): () => void {
    let groups = this.#topics.get(topic);
    if (!groups) this.#topics.set(topic, (groups = new Map()));
    let entry = groups.get(group);
    if (!entry) groups.set(group, (entry = { members: [], next: 0 }));
    entry.members.push(deliver);
    const members = entry.members;
    return () => {
      const at = members.indexOf(deliver);
      if (at >= 0) members.splice(at, 1);
    };
  }
}

// ── the bus ──

interface EventMessage {
  name: string;
  data: unknown;
}

interface CallMessage {
  id: string;
  reply: string;
  name: string;
  data: unknown;
}

interface ReplyMessage {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { message: string; status?: number; expose?: boolean };
}

/** Options for events.call(). */
export interface CallOptions {
  /**
   * How long to wait for the answer ("5s", ms). Default 10s.
   *
   * ```ts
   * const cents = await this.events.call(new QuoteShipping(1200, "US"), { timeout: "3s" });
   * ```
   */
  timeout?: string | number;
}

/** Options for events.waitFor(). */
export interface WaitOptions<E> {
  /**
   * Give up (reject) after this long ("5s", ms). Default 10s.
   *
   * ```ts
   * await events.waitFor(OrderPlaced, { timeout: "1s" });
   * ```
   */
  timeout?: string | number;
  /**
   * Only an event this accepts; others are skipped, not consumed.
   *
   * ```ts
   * await events.waitFor(OrderPlaced, { where: (e) => e.orderId === id });
   * ```
   */
  where?: (event: E) => boolean;
}

const eventTopic = (name: string) => `event:${name}`;

/** An event as it travels, or a clear TypeError when it can't (BigInt, cycles). */
function encode(event: object): EventMessage {
  const name = eventName(event.constructor);
  try {
    return { name, data: toWire(event) };
  } catch (error) {
    throw new TypeError(`${name} can't be sent as JSON: ${(error as Error).message}`);
  }
}

function isDevelopment(): boolean {
  const env = process.env.NODE_ENV;
  return env === undefined || env === "development";
}
const callTopic = (name: string) => `call:${name}`;

/**
 * The bus. Built in: every app has one in DI (`@inject(Events)`), backed by
 * the EventTransport registered in DI, or an in-process one.
 *
 * ```ts
 * @route("/checkout")
 * export class Checkout {
 *   @inject(Events) accessor events!: Events;
 *   @inject(Orders) accessor orders!: Orders;
 *
 *   @post place() {
 *     const order = this.orders.place();
 *     this.events.emit(new OrderPlaced(order.id, order.total)); // sent once this succeeds
 *     return redirect(`/orders/${order.id}`);
 *   }
 * }
 * ```
 */
export class Events {
  /** This instance, for replies and `every` groups. */
  readonly instance = randomUUID();
  readonly #transport: EventTransport;
  readonly #queued = new WeakMap<YerdContext, EventMessage[]>();
  /** Subscribes the app's @on / @handles methods; set by the app at boot, run once on first use. */
  #wiring: (() => void) | undefined;
  readonly #released = new WeakSet<YerdContext>();
  readonly #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly #running = new Set<Promise<unknown>>();
  readonly #unsubscribe: Array<() => void> = [];
  #replies: (() => void) | undefined;
  readonly #unheard = new Set<string>();
  #stopped: AbortController = new AbortController();

  /**
   * The app builds its own (with the registered EventTransport, if any).
   * Build one yourself only to test handlers or transports without an app.
   *
   * ```ts
   * const events = new Events(new MemoryTransport());
   * ```
   */
  constructor(transport: EventTransport = new MemoryTransport()) {
    this.#transport = transport;
  }

  /**
   * Announce that something happened. Inside a request it waits until the
   * request has succeeded (and is dropped if it fails); elsewhere it's sent now.
   * Doesn't wait for handlers: they run in the background.
   *
   * ```ts
   * this.events.emit(new OrderPlaced(order.id, order.total));
   * ```
   */
  emit(event: object): void {
    // Encoded now, so an event that can't be sent (a BigInt, a cycle) throws
    // here, at the emit, rather than later where nobody can catch it.
    const message = encode(event);
    this.#prepare();
    const ctx = maybeContext();
    if (ctx && !this.#released.has(ctx)) {
      let queue = this.#queued.get(ctx);
      if (!queue) this.#queued.set(ctx, (queue = []));
      queue.push(message);
      return;
    }
    void this.#send(message);
  }

  /**
   * Send now, even inside a request that may still fail. Resolves once the
   * transport has taken it, not when handlers finish.
   *
   * ```ts
   * await this.events.emitNow(new OrderPlaced(order.id, order.total));
   * ```
   */
  async emitNow(event: object): Promise<void> {
    const message = encode(event);
    this.#prepare();
    return this.#send(message);
  }

  /**
   * Ask the one handler of this call class and wait for its answer. Its
   * HttpErrors come back as HttpErrors (status and message), other failures as
   * Errors with its message. Not deferred like emit(): you're waiting on it.
   *
   * ```ts
   * @post async quote() {
   *   const cents = await this.events.call(new QuoteShipping(1200, "US"), { timeout: "3s" });
   *   return { cents }; // a 422 thrown by the handler is a 422 here too
   * }
   * ```
   */
  call<C extends Call<any>>(call: C, options: CallOptions = {}): Promise<ResultOf<C>> {
    this.#prepare();
    const name = eventName(call.constructor);
    const id = randomUUID();
    const ms = parseDuration(options.timeout ?? "10s");
    this.#listenForReplies();
    return new Promise<ResultOf<C>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`events.call(${name}) got no answer within ${ms}ms`));
      }, ms);
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      const message: CallMessage = { id, reply: `reply:${this.instance}`, name, data: toWire(call) };
      Promise.resolve(this.#transport.publish(callTopic(name), message)).then(
        (reached) => {
          if (reached === 0) this.#settle({ id, ok: false, error: { message: `Nothing answers ${name}: no @handles(${call.constructor.name}) in this app or on the transport` } });
        },
        (error: unknown) => this.#settle({ id, ok: false, error: { message: `events.call(${name}) couldn't be sent: ${(error as Error)?.message ?? error}` } }),
      );
    });
  }

  /**
   * The next event of this class this instance sees (tests, scripts). Start
   * waiting before you trigger the event, or you may miss it.
   *
   * ```ts
   * const placed = app.container.get(Events).waitFor(OrderPlaced, { where: (e) => e.orderId === "o1" });
   * await fetch(server.url + "/checkout", { method: "POST" });
   * expect((await placed).total).toBe(42);
   * ```
   */
  waitFor<E extends object>(type: EventClass<E>, options: WaitOptions<E> = {}): Promise<E> {
    this.#prepare();
    const name = eventName(type);
    const ms = parseDuration(options.timeout ?? "10s");
    return new Promise<E>((resolve, reject) => {
      const leave = this.#transport.subscribe(eventTopic(name), `wait:${randomUUID()}`, (message) => {
        const event = fromWire<E>(type, (message as EventMessage).data);
        if (options.where && !options.where(event)) return;
        clearTimeout(timer);
        leave();
        resolve(event);
      });
      const timer = setTimeout(() => {
        leave();
        reject(new Error(`events.waitFor(${name}) saw nothing within ${ms}ms`));
      }, ms);
    });
  }

  /** @internal The request succeeded: send what it emitted, and anything it emits from now on. */
  release(ctx: YerdContext): void {
    this.#released.add(ctx);
    const queue = this.#queued.get(ctx);
    if (!queue) return;
    this.#queued.delete(ctx);
    for (const message of queue) void this.#send(message);
  }

  /**
   * @internal How the app's handlers get subscribed: at start, or (in a
   * script, or a test that never starts the app) on the first emit, call or
   * waitFor, so handlers hear events wherever they're sent from.
   */
  wireWith(wiring: () => void): void {
    this.#wiring = wiring;
  }

  /** @internal Called at app start: subscribe the handlers if no use did yet. */
  subscribeHandlers(): void {
    this.#prepare();
  }

  #prepare(): void {
    const wiring = this.#wiring;
    if (!wiring) return;
    this.#wiring = undefined;
    wiring();
  }

  /** @internal The request failed: forget what it emitted. */
  discard(ctx: YerdContext): void {
    const queue = this.#queued.get(ctx);
    if (!queue) return;
    this.#queued.delete(ctx);
    log.debug(`dropped ${queue.length} event(s) from a failed request`, { events: queue.map((e) => eventName(e.constructor)) });
  }

  /** @internal Subscribe a service's @on and @handles methods (at app start). */
  wire(container: Container, instance: object, label: string, ons: readonly OnEntry[], answers: readonly HandlesEntry[]): void {
    const target = instance as Record<string | symbol, (...args: unknown[]) => unknown>;
    for (const { method, type, options } of ons) {
      const name = eventName(type);
      const handler = `${label}.${String(method)}`;
      const group = options.every ? `${handler}@${this.instance}` : handler;
      this.#unsubscribe.push(
        this.#transport.subscribe(eventTopic(name), group, (message) =>
          this.#track(this.#runWithRetries(container, handler, options, () => target[method]!.call(instance, fromWire(type, (message as EventMessage).data)))),
        ),
      );
    }
    for (const { method, type } of answers) {
      const name = eventName(type);
      this.#unsubscribe.push(
        this.#transport.subscribe(callTopic(name), "answer", (message) => this.#track(this.#answer(container, target, method, type, message as CallMessage))),
      );
    }
  }

  /** @internal Stop taking events and wait (up to `timeout` ms) for running handlers. */
  async stop(timeout: number): Promise<boolean> {
    this.#stopped.abort();
    for (const leave of this.#unsubscribe.splice(0)) leave();
    this.#replies?.();
    this.#replies = undefined;
    for (const [id, waiting] of this.#pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error("the app is shutting down"));
      this.#pending.delete(id);
    }
    if (this.#running.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = Promise.all(this.#running).then(() => true);
    const late = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeout)));
    const finished = await Promise.race([done, late]);
    clearTimeout(timer);
    return finished;
  }

  async #send(message: EventMessage): Promise<void> {
    const { name } = message;
    try {
      const reached = await this.#transport.publish(eventTopic(name), message);
      // In development, once per event: an event nothing hears is usually a
      // handler-only @service whose module is never imported.
      if (reached === 0 && isDevelopment() && !this.#unheard.has(name)) {
        this.#unheard.add(name);
        log.warn(`nothing handles ${name}: is the module with its @on handlers imported? A @service registers when its module loads`);
      }
    } catch (error) {
      log.error(`couldn't send ${name}`, { error });
    }
  }

  #track(work: Promise<unknown>): Promise<void> {
    this.#running.add(work);
    return work.then(
      () => {
        this.#running.delete(work);
      },
      () => {
        this.#running.delete(work);
      },
    );
  }

  /**
   * In a fresh DI scope, like a request: scoped services are per delivery. And
   * outside the request that emitted the event (deliveries inherit its async
   * context): it's over, and its data and scope aren't the handler's.
   */
  async #inScope<T>(container: Container, fn: () => T): Promise<Awaited<T>> {
    const scope = new Scope();
    try {
      return await outsideRequest(() => runWithServices(container, scope, fn));
    } finally {
      if (!scope.isEmpty) await scope.dispose().catch((error) => log.error("failed to dispose event handler services", { error }));
    }
  }

  async #runWithRetries(container: Container, handler: string, options: OnOptions, run: () => unknown): Promise<void> {
    const retries = options.retries ?? 0;
    let wait = parseDuration(options.backoff ?? "1s");
    for (let attempt = 0; ; attempt++) {
      try {
        await this.#inScope(container, run);
        return;
      } catch (error) {
        if (attempt >= retries || this.#stopped.signal.aborted) {
          log.error(`@on ${handler} failed${retries ? ` after ${attempt + 1} attempts` : ""}`, { error });
          return;
        }
        log.warn(`@on ${handler} failed; retrying in ${wait}ms`, { error, attempt: attempt + 1 });
        const stopped = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), wait);
          this.#stopped.signal.addEventListener("abort", () => (clearTimeout(timer), resolve(true)), { once: true });
        });
        if (stopped) return;
        wait *= 2;
      }
    }
  }

  async #answer(container: Container, target: Record<string | symbol, (...args: unknown[]) => unknown>, method: string | symbol, type: Function, message: CallMessage): Promise<void> {
    let reply: ReplyMessage;
    try {
      const result = await this.#inScope(container, () => target[method]!.call(target, fromWire(type, message.data)));
      reply = { id: message.id, ok: true, result: result === undefined ? undefined : toWire({ value: result }) };
    } catch (error) {
      reply =
        error instanceof HttpError
          ? { id: message.id, ok: false, error: { message: error.message, status: error.status, expose: error.expose } }
          : { id: message.id, ok: false, error: { message: (error as Error)?.message ?? String(error) } };
      if (!(error instanceof HttpError)) log.error(`@handles ${message.name} failed`, { error });
    }
    await this.#transport.publish(message.reply, reply);
  }

  #listenForReplies(): void {
    this.#replies ??= this.#transport.subscribe(`reply:${this.instance}`, this.instance, (message) => this.#settle(message as ReplyMessage));
  }

  #settle(reply: ReplyMessage): void {
    const waiting = this.#pending.get(reply.id);
    if (!waiting) return;
    this.#pending.delete(reply.id);
    clearTimeout(waiting.timer);
    if (reply.ok) {
      waiting.resolve((reply.result as { value?: unknown } | undefined)?.value);
      return;
    }
    const failure = reply.error ?? { message: "the call failed" };
    waiting.reject(failure.status !== undefined ? new HttpError(failure.status, failure.message, { expose: failure.expose }) : new Error(failure.message));
  }
}
