import { createKey, localKey } from "../decorators/keys.js";
import { classValue, methodFlag, methodList, type DecoratorTarget } from "../decorators/kit.js";
import { isDecoratorContext } from "../decorators/util.js";
import {
  OWNER, classRegistration, currentServices, keyName,
  type Container, type Lifetime, type Registration, type ServiceKey,
} from "./container.js";
import { parseDuration } from "../util/duration.js";

// Public from here too, where it lived before it was shared.
export { parseDuration };

/** A class's lifetime from @singleton / @scoped / @transient. */
const LIFETIME = classValue<Lifetime>("lifetime");

/** The lifetime an injection site asks for, instead of the registration's: @inject.scoped, .transient, .instance. */
export type InjectSite = "scoped" | "transient" | "instance";

export interface InjectEntry {
  field: string;
  key: ServiceKey;
  optional: boolean;
  /** Set by @inject.scoped / .transient / .instance. */
  site?: InjectSite;
}
export const INJECTS = createKey<InjectEntry[]>("injects");

export interface ServiceDef {
  cls: new () => object;
  className: string;
  provides: ServiceKey;
  /** Explicit lifetime from @service options; otherwise LIFETIME metadata, then the default. */
  lifetime: Lifetime | undefined;
  hosted: boolean;
  metadata: DecoratorMetadataObject;
}

/** Every class decorated with @service / @hosted, in definition order. */
export const serviceRegistry: ServiceDef[] = [];

/**
 * Forget every @service / @hosted class. Dev servers call it before
 * re-importing the app (prefer `app.resetRegistries()`, which reaches the copy
 * of yerd the app uses); tests that define services per test can call it
 * between them. Apps built with `yerd({ services: [...] })` don't need it.
 *
 * ```ts
 * afterEach(() => {
 *   resetServiceRegistry();
 *   resetGuardRegistry();
 * });
 * ```
 */
export function resetServiceRegistry(): void {
  serviceRegistry.length = 0;
}

export function lifetimeOf(def: { lifetime?: Lifetime | undefined; metadata: DecoratorMetadataObject }, fallback: Lifetime): Lifetime {
  return def.lifetime ?? LIFETIME.get(def.metadata) ?? fallback;
}

export function registrationFor(def: ServiceDef): Registration {
  return classRegistration(def.provides, def.cls, lifetimeOf(def, "singleton"));
}

/** Options for @service. */
export interface ServiceOptions {
  /**
   * Default "singleton". Wins over a @scoped / @transient decorator on the same class.
   *
   * ```ts
   * @service({ lifetime: "scoped" }) export class UnitOfWork {}
   * ```
   */
  lifetime?: Lifetime;
  /**
   * Register as the implementation of a token (or another class), so
   * `@inject(Mailer)` gets this class.
   *
   * ```ts
   * @service({ provides: Mailer })
   * export class ConsoleMailer implements Mailer {
   *   async send(to: string, body: string) { console.log(`to ${to}: ${body}`); }
   * }
   * ```
   */
  provides?: ServiceKey;
}

function isClassContext(value: unknown): value is ClassDecoratorContext {
  return isDecoratorContext(value, "class");
}

function addService(cls: Function, context: ClassDecoratorContext, options: ServiceOptions, hosted: boolean): void {
  serviceRegistry.push({
    cls: cls as new () => object,
    className: String(context.name ?? "anonymous"),
    provides: options.provides ?? (cls as ServiceKey),
    lifetime: options.lifetime,
    hosted,
    metadata: context.metadata,
  });
}

/**
 * Register a class with DI. Singleton unless told otherwise. Bare or called:
 *
 * ```ts
 * @service
 * export class Clock {
 *   now() { return new Date(); }
 * }
 *
 * @service({ lifetime: "scoped" })
 * export class UnitOfWork {}
 *
 * @service({ provides: Mailer })
 * export class ConsoleMailer implements Mailer {
 *   async send(to: string, body: string) { console.log(`to ${to}: ${body}`); }
 * }
 * ```
 */
export function service(value: Function, context: ClassDecoratorContext): void;
export function service(options?: ServiceOptions): (value: Function, context: ClassDecoratorContext) => void;
export function service(a?: unknown, b?: unknown): unknown {
  // Bare: the runtime calls us as (class, context). Returning nothing keeps the class.
  if (typeof a === "function" && isClassContext(b)) {
    addService(a, b, {}, false);
    return undefined;
  }
  const options = (a ?? {}) as ServiceOptions;
  return (value: Function, context: ClassDecoratorContext) => addService(value, context, options, false);
}

/**
 * Make a @service or @route class a singleton: one instance for the life of
 * the app. Services already are by default, so it's mostly for routes, which
 * are scoped otherwise. Stacks with @route / @service in any order.
 *
 * ```ts
 * @route("/stats")
 * @singleton
 * export class Stats {
 *   #hits = 0;
 *   @get show() { return { hits: ++this.#hits }; }
 * }
 * ```
 */
export const singleton = LIFETIME("singleton");
/**
 * Make a @service or @route class scoped: one instance per request. The
 * default for routes. Stacks with @service in any order.
 *
 * ```ts
 * @scoped
 * @service
 * export class RequestStats {
 *   queries = 0;
 * }
 * ```
 */
export const scoped = LIFETIME("scoped");
/**
 * Make a @service or @route class transient: a new instance every time it's
 * resolved (one per injecting instance, since @inject caches on its owner).
 *
 * ```ts
 * @transient
 * @service
 * export class IdGen {
 *   readonly id = crypto.randomUUID();
 * }
 * ```
 */
export const transient = LIFETIME("transient");

function resolveFor<T>(owner: object, key: ServiceKey<T>, optional: boolean, perOwner: ReturnType<typeof localKey<T>>): T | undefined {
  if (perOwner.hasOwn(owner)) return perOwner.from(owner);
  const own = OWNER.from(owner);
  // The request's services are looked up only when needed: for the container
  // of an instance nobody constructed, or the scope of a scoped or transient.
  let context = own ? undefined : currentServices();
  const container: Container | undefined = own ?? context?.container;
  if (!container) throw new Error(`Can't inject ${keyName(key)}: no yerd app is running`);
  const registration = container.registration(key);
  if (!registration) {
    if (optional) return undefined;
    throw new Error(`No service registered for ${keyName(key)}`);
  }
  if (registration.lifetime === "singleton") {
    const value = container.resolveRegistration(registration) as T;
    // A singleton of the same container keeps it, so its later reads skip
    // the lookups. Only a singleton: a property added to every short-lived
    // instance (a route per request) costs more than it saves on one read.
    if (own && own.outlivesRequests(owner) && Object.isExtensible(owner)) perOwner.set(owner, value);
    return value;
  }
  context ??= currentServices();
  // Transients are cached on the owner: one per owning instance, not one per
  // read, and disposed with it (a singleton's at shutdown, not after a request).
  if (registration.lifetime === "transient") {
    const value = container.resolveRegistration(registration, context?.scope, owner) as T;
    perOwner.set(owner, value);
    return value;
  }
  // Scoped: never cached, as the owner may outlive the request.
  return container.resolveRegistration(registration, context?.scope) as T;
}

/**
 * A read of an @inject.scoped / .transient / .instance field: the
 * registration is looked up on every read (so app.services() overrides
 * apply), then made with the site's lifetime instead of its own.
 */
function resolveAt<T>(owner: object, key: ServiceKey<T>, site: InjectSite, field: string, perOwner: ReturnType<typeof localKey<T>>): T {
  if (site === "instance" && perOwner.hasOwn(owner)) return perOwner.from(owner) as T;
  const context = currentServices();
  const container: Container | undefined = OWNER.from(owner) ?? context?.container;
  if (!container) throw new Error(`Can't inject ${keyName(key)}: no yerd app is running`);
  const registration = container.registration(key);
  if (!registration) throw new Error(`No service registered for ${keyName(key)}`);
  const scope = context?.scope;
  if (site === "scoped") {
    if (!scope) {
      throw new Error(
        `${owner.constructor.name}.${field}: @inject.scoped(${keyName(key)}) is one per request and was read outside one ` +
          `(an @every job, @onBoot, a hosted service). Read it while handling a request, or make a scope with app.scope(async () => ...).`,
      );
    }
    return container.resolveAs(registration, "scoped", scope) as T;
  }
  if (site === "transient") return container.resolveAs(registration, "transient", scope) as T;
  // One per holder, kept on it and disposed with it, like a transient registration's.
  const value = container.resolveAs(registration, "transient", scope, owner) as T;
  perOwner.set(owner, value);
  return value;
}

function injectDecorator<T>(key: ServiceKey<T>, optional: boolean, site?: InjectSite) {
  return function <This extends object, V>(
    _target: ClassAccessorDecoratorTarget<This, V>,
    context: ClassAccessorDecoratorContext<This, V>,
  ): ClassAccessorDecoratorResult<This, V> {
    const field = String(context.name);
    INJECTS.ownArray<InjectEntry>(context.metadata).push(site ? { field, key, optional, site } : { field, key, optional });
    const perOwner = localKey<T>(`inject:${field}`);
    const set = (): void => {
      throw new TypeError(`${field} is injected and can't be assigned`);
    };
    if (site) {
      return {
        get(this: This): V {
          return resolveAt(this, key, site, field, perOwner) as unknown as V;
        },
        set,
      };
    }
    return {
      get(this: This): V {
        return resolveFor(this, key, optional, perOwner) as V;
      },
      set,
    };
  };
}

/** What @inject(key) and its lifetime forms return: an accessor decorator whose field must hold `T`. */
type InjectDecorator<T> = <This extends object>(
  target: ClassAccessorDecoratorTarget<This, T>,
  context: ClassAccessorDecoratorContext<This, T>,
) => ClassAccessorDecoratorResult<This, T>;

/**
 * The type of [inject](api:yerd.inject): call it for the registration's own
 * lifetime, or use a member to choose the lifetime at the injection site.
 * Only class and factory registrations can be re-scoped; a `value()`
 * registration used with a member is a boot error.
 *
 * ```ts
 * @service
 * export class Orders {
 *   @inject(Catalog) accessor catalog!: Catalog;              // as registered
 *   @inject.scoped(AuditLog) accessor audit!: AuditLog;       // the current request's
 *   @inject.transient(Hasher) accessor hasher!: Hasher;       // a new one per read
 *   @inject.instance(OrderState) accessor state!: OrderState; // this Orders' own
 * }
 * ```
 */
export interface Inject {
  <T>(key: ServiceKey<T>): InjectDecorator<T>;
  /**
   * One instance per request, shared by every `@inject.scoped` of the key in
   * that request. A key registered scoped gives its usual scoped instance; a
   * singleton or transient one gets an instance of its own per request,
   * separate from the registered singleton. Resolved on every read, never
   * kept, so a singleton may hold it: each read sees the current request.
   * Reading it outside a request (an @every job, @onBoot) throws;
   * `app.scope()` and event handlers have a scope and work.
   *
   * ```ts
   * @scoped
   * @service
   * export class AuditLog {
   *   readonly lines: string[] = [];
   * }
   *
   * @service
   * export class Orders {
   *   // plain @inject(AuditLog) here would refuse to boot: a singleton can't hold a scoped service
   *   @inject.scoped(AuditLog) accessor audit!: AuditLog;
   *   place(id: number) { this.audit.lines.push(`order ${id} placed`); }
   * }
   * ```
   */
  scoped<T>(key: ServiceKey<T>): InjectDecorator<T>;
  /**
   * A new instance on every read of the field. Disposable ones made during a
   * request are disposed at its end; outside a request nobody tracks them, so
   * dispose them yourself. Keep the instance in a local when you need it twice.
   *
   * ```ts
   * @service
   * export class Users {
   *   @inject.transient(Hasher) accessor hasher!: Hasher;
   *
   *   async register(name: string, password: string) {
   *     const hasher = this.hasher; // one read, one Hasher
   *     return { name, hash: await hasher.hash(password) };
   *   }
   * }
   * ```
   */
  transient<T>(key: ServiceKey<T>): InjectDecorator<T>;
  /**
   * One instance per holder: made on the first read, kept on the instance
   * that has the field, and disposed with it (a singleton's at shutdown, a
   * route's at the end of its request). What plain @inject does for a key
   * registered transient, for any class or factory registration.
   *
   * ```ts
   * @scoped
   * @service
   * export class Checkout {
   *   @inject.instance(OrderState) accessor state!: OrderState; // not shared with any other holder
   * }
   * ```
   */
  instance<T>(key: ServiceKey<T>): InjectDecorator<T>;
}

/**
 * Inject a service into an `accessor` field (a plain field is a type error).
 * Lazy: resolved on first read, cached per the service's lifetime. Works on
 * routes, services, guards' services and class components. A missing
 * registration is a boot error. `inject.scoped`, `inject.transient` and
 * `inject.instance` choose the lifetime at the injection site instead (see
 * [Inject](api:yerd.Inject)).
 *
 * ```ts
 * @service
 * export class Checkout {
 *   @inject(Orders) accessor orders!: Orders;
 *   @inject(Mailer) accessor mailer!: Mailer; // a token works the same
 *   @inject.scoped(AuditLog) accessor audit!: AuditLog; // the current request's, on every read
 *
 *   async place(email: string) {
 *     const order = this.orders.place();
 *     this.audit.lines.push(`order ${order.id} placed`);
 *     await this.mailer.send(email, `Order ${order.id} placed`);
 *   }
 * }
 * ```
 */
export const inject: Inject = Object.assign(<T>(key: ServiceKey<T>) => injectDecorator(key, false) as InjectDecorator<T>, {
  scoped: <T>(key: ServiceKey<T>) => injectDecorator(key, false, "scoped") as InjectDecorator<T>,
  transient: <T>(key: ServiceKey<T>) => injectDecorator(key, false, "transient") as InjectDecorator<T>,
  instance: <T>(key: ServiceKey<T>) => injectDecorator(key, false, "instance") as InjectDecorator<T>,
});

/**
 * Like @inject, but `undefined` when nothing is registered, instead of a boot
 * error. For optional integrations.
 *
 * ```ts
 * export const Analytics = token<{ track(event: string): void }>("Analytics");
 *
 * @service
 * export class Signup {
 *   @maybe(Analytics) accessor analytics: { track(event: string): void } | undefined;
 *   run() { this.analytics?.track("signup"); }
 * }
 * ```
 */
export function maybe<T>(key: ServiceKey<T>) {
  return injectDecorator(key, true) as <This extends object>(
    target: ClassAccessorDecoratorTarget<This, T | undefined>,
    context: ClassAccessorDecoratorContext<This, T | undefined>,
  ) => ClassAccessorDecoratorResult<This, T | undefined>;
}

/**
 * Boot checks for a class's @inject fields: a key nothing provides (unless
 * @maybe), a singleton holding a scoped service through plain @inject, and a
 * value() registration asked for with another lifetime.
 */
export function checkInjections(name: string, lifetime: Lifetime, metadata: DecoratorMetadataObject, container: Container, problems: string[]): void {
  for (const entry of INJECTS.from(metadata) ?? []) {
    const target = container.registration(entry.key);
    if (!target) {
      if (!entry.optional) problems.push(`${name}.${entry.field}: nothing is registered for ${keyName(entry.key)} (@service it, or app.services(...))`);
      continue;
    }
    if (entry.site) {
      if (target.value) {
        problems.push(
          `${name}.${entry.field}: @inject.${entry.site}(${keyName(entry.key)}) can't re-scope a value() registration, which is one existing object; ` +
            `register a class or a factory, or use plain @inject`,
        );
      }
      continue;
    }
    if (lifetime === "singleton" && target.lifetime === "scoped") {
      problems.push(`${name} (singleton) -> ${keyName(entry.key)} (scoped): a singleton can't hold a per-request service`);
    }
  }
}

// ── Lifecycle ──

export interface EveryEntry {
  method: string | symbol;
  ms: number;
  immediate: boolean;
}
/** Per method: the schedules its @every decorators declared. */
const EVERY = methodList<Omit<EveryEntry, "method">>("every");

/** A class's @every methods, one entry per schedule. */
export function everyOf(target: DecoratorTarget): EveryEntry[] {
  const out: EveryEntry[] = [];
  for (const [method, schedules] of EVERY.entries(target)) for (const schedule of schedules) out.push({ method, ...schedule });
  return out;
}

/** Whether a class has any @onBoot, @onShutdown or @every method. */
export function hasLifecycleHooks(target: DecoratorTarget): boolean {
  return onBoot.members(target).size > 0 || onShutdown.members(target).size > 0 || EVERY.entries(target).size > 0;
}

/**
 * Run when the app starts, before it accepts requests. Awaited, in
 * registration order. Singleton services only (anything else is a boot error).
 * `app.scope()` doesn't run these; `app.start()` and `listen()` do.
 *
 * ```ts
 * @service
 * export class Search {
 *   #index = new Map<string, string[]>();
 *   @onBoot async load() { this.#index.set("all", []); }
 * }
 * ```
 */
export const onBoot = methodFlag("onBoot");

/**
 * Run when the app stops, after requests drain and background work ends.
 * Reverse registration order. Singleton services only.
 *
 * ```ts
 * @service
 * export class Search {
 *   #index = new Map<string, string[]>();
 *   @onShutdown async save() { this.#index.clear(); }
 * }
 * ```
 */
export const onShutdown = methodFlag("onShutdown");

/** Options for @every. */
export interface EveryOptions {
  /**
   * Also run once right at startup.
   *
   * ```ts
   * @every("1h", { immediate: true }) refresh() {}
   * ```
   */
  immediate?: boolean;
}

/**
 * Run a method periodically on a singleton service. Runs never overlap: the
 * next one is scheduled after the previous finishes. The method gets an
 * AbortSignal that fires at shutdown.
 *
 * ```ts
 * @service
 * export class Mailbox {
 *   #queue: string[] = [];
 *
 *   @every("10s") async drain(signal: AbortSignal) {
 *     for (const to of this.#queue.splice(0)) {
 *       await fetch("https://mail.example.com/send", { method: "POST", body: to, signal });
 *     }
 *   }
 * }
 * ```
 */
export function every(
  interval: string | number,
  options: EveryOptions = {},
): (method: (this: any, signal: AbortSignal) => unknown, context: ClassMethodDecoratorContext) => void {
  const ms = parseDuration(interval);
  if (ms <= 0) throw new TypeError(`@every interval must be positive`);
  return EVERY({ ms, immediate: options.immediate ?? false });
}

/** What a @hosted class must implement. */
export interface HostedService {
  /**
   * Long-running work. Resolve or return when `signal` aborts (at shutdown);
   * shutdown waits up to `shutdownTimeout` for it.
   *
   * ```ts
   * async run(signal: AbortSignal) {
   *   while (!signal.aborted) await this.queue.processNext(signal);
   * }
   * ```
   */
  run(signal: AbortSignal): unknown;
}

/**
 * A background service, like ASP.NET Core's BackgroundService: a singleton
 * whose `run(signal)` starts after boot and is told to stop at shutdown.
 *
 * ```ts
 * @hosted
 * export class QueueWorker implements HostedService {
 *   @inject(Orders) accessor orders!: Orders;
 *
 *   async run(signal: AbortSignal) {
 *     while (!signal.aborted) {
 *       await new Promise((r) => setTimeout(r, 1000)); // poll, process, repeat
 *     }
 *   }
 * }
 * ```
 */
export function hosted<C extends abstract new (...args: never[]) => HostedService>(value: C, context: ClassDecoratorContext<C>): void {
  addService(value, context as ClassDecoratorContext, { lifetime: "singleton" }, true);
}
