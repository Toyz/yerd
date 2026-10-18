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

export interface InjectEntry {
  field: string;
  key: ServiceKey;
  optional: boolean;
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

function injectDecorator<T>(key: ServiceKey<T>, optional: boolean) {
  return function <This extends object, V>(
    _target: ClassAccessorDecoratorTarget<This, V>,
    context: ClassAccessorDecoratorContext<This, V>,
  ): ClassAccessorDecoratorResult<This, V> {
    const field = String(context.name);
    INJECTS.ownArray<InjectEntry>(context.metadata).push({ field, key, optional });
    const perOwner = localKey<T>(`inject:${field}`);
    return {
      get(this: This): V {
        return resolveFor(this, key, optional, perOwner) as V;
      },
      set(): void {
        throw new TypeError(`${field} is injected and can't be assigned`);
      },
    };
  };
}

/**
 * Inject a service into an `accessor` field (a plain field is a type error).
 * Lazy: resolved on first read, cached per the service's lifetime. Works on
 * routes, services, guards' services and class components. A missing
 * registration is a boot error.
 *
 * ```ts
 * @service
 * export class Checkout {
 *   @inject(Orders) accessor orders!: Orders;
 *   @inject(Mailer) accessor mailer!: Mailer; // a token works the same
 *
 *   async place(email: string) {
 *     const order = this.orders.place();
 *     await this.mailer.send(email, `Order ${order.id} placed`);
 *   }
 * }
 * ```
 */
export function inject<T>(key: ServiceKey<T>) {
  return injectDecorator(key, false) as <This extends object>(
    target: ClassAccessorDecoratorTarget<This, T>,
    context: ClassAccessorDecoratorContext<This, T>,
  ) => ClassAccessorDecoratorResult<This, T>;
}

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
