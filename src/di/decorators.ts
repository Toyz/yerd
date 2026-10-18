import { createKey, localKey } from "../decorators/keys.js";
import { assertPublicInstance, isDecoratorContext } from "../decorators/util.js";
import {
  OWNER, currentServices, keyName,
  type Container, type Lifetime, type Registration, type ServiceKey,
} from "./container.js";
import { parseDuration } from "../util/duration.js";

// Public from here too, where it lived before it was shared.
export { parseDuration };

export const LIFETIME = createKey<Lifetime>("lifetime");

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
  return def.lifetime ?? LIFETIME.from(def.metadata) ?? fallback;
}

export function registrationFor(def: ServiceDef): Registration {
  const lifetime = lifetimeOf(def, "singleton");
  return {
    key: def.provides,
    lifetime,
    impl: def.cls,
    create: (container) => container.construct(def.cls, currentServices()?.scope, lifetime),
  };
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

function lifetimeDecorator(lifetime: Lifetime) {
  return (_value: Function, context: ClassDecoratorContext): void => {
    LIFETIME.set(context.metadata, lifetime);
  };
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
export const singleton = lifetimeDecorator("singleton");
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
export const scoped = lifetimeDecorator("scoped");
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
export const transient = lifetimeDecorator("transient");

function resolveFor<T>(owner: object, key: ServiceKey<T>, optional: boolean, perOwner: ReturnType<typeof localKey<T>>): T | undefined {
  const context = currentServices();
  const container: Container | undefined = OWNER.from(owner) ?? context?.container;
  if (!container) throw new Error(`Can't inject ${keyName(key)}: no yerd app is running`);
  const registration = container.registration(key);
  if (!registration) {
    if (optional) return undefined;
    throw new Error(`No service registered for ${keyName(key)}`);
  }
  // Transients are cached on the owner: one per owning instance, not one per
  // read, and disposed with it (a singleton's at shutdown, not after a request).
  if (registration.lifetime === "transient") {
    if (perOwner.hasOwn(owner)) return perOwner.from(owner);
    const value = container.get(key, context?.scope, owner);
    perOwner.set(owner, value);
    return value;
  }
  return container.get(key, context?.scope);
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

export const ON_BOOT = createKey<Array<string | symbol>>("on-boot");
export const ON_SHUTDOWN = createKey<Array<string | symbol>>("on-shutdown");

export interface EveryEntry {
  method: string | symbol;
  ms: number;
  immediate: boolean;
}
export const EVERY = createKey<EveryEntry[]>("every");

function hook(key: typeof ON_BOOT, label: string) {
  return (_method: Function, context: ClassMethodDecoratorContext): void => {
    assertPublicInstance(context, `@${label}`);
    key.ownArray<string | symbol>(context.metadata).push(context.name);
  };
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
export const onBoot = hook(ON_BOOT, "onBoot");

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
export const onShutdown = hook(ON_SHUTDOWN, "onShutdown");

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
export function every(interval: string | number, options: EveryOptions = {}) {
  const ms = parseDuration(interval);
  if (ms <= 0) throw new TypeError(`@every interval must be positive`);
  return (_method: (this: any, signal: AbortSignal) => unknown, context: ClassMethodDecoratorContext): void => {
    assertPublicInstance(context, "@every");
    EVERY.ownArray<EveryEntry>(context.metadata).push({ method: context.name, ms, immediate: options.immediate ?? false });
  };
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
