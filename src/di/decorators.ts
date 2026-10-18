import { createKey, localKey } from "../decorators/keys.js";
import {
  OWNER, currentServices, keyName,
  type Container, type Lifetime, type Registration, type ServiceKey,
} from "./container.js";

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

export interface ServiceOptions {
  lifetime?: Lifetime;
  /** Register as the implementation of a token (or another class). */
  provides?: ServiceKey;
}

function isClassContext(value: unknown): value is ClassDecoratorContext {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "class";
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
 * @service class Clock { ... }
 * @service({ lifetime: "scoped" }) class UnitOfWork { ... }
 * @service({ provides: Mailer }) class SmtpMailer implements Mailer { ... }
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

/** Lifetime shorthands for @service and @route classes. Stack in any order. */
export const singleton = lifetimeDecorator("singleton");
export const scoped = lifetimeDecorator("scoped");
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

/** Inject a service. Lazy: resolved on first read, cached per the service's lifetime. */
export function inject<T>(key: ServiceKey<T>) {
  return injectDecorator(key, false) as <This extends object>(
    target: ClassAccessorDecoratorTarget<This, T>,
    context: ClassAccessorDecoratorContext<This, T>,
  ) => ClassAccessorDecoratorResult<This, T>;
}

/** Like @inject, but `undefined` when nothing is registered. */
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
    if (context.static || context.private) throw new TypeError(`@${label} must decorate a public instance method`);
    key.ownArray<string | symbol>(context.metadata).push(context.name);
  };
}

/** Run when the app starts, before it accepts requests. Awaited, in registration order. Singleton services only. */
export const onBoot = hook(ON_BOOT, "onBoot");

/** Run when the app stops, after requests drain. Reverse registration order. Singleton services only. */
export const onShutdown = hook(ON_SHUTDOWN, "onShutdown");

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "500ms", "5s", "1m", "2h", "1d", or a number of ms. */
export function parseDuration(value: string | number): number {
  if (typeof value === "number") return value;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) throw new TypeError(`Invalid duration: ${JSON.stringify(value)} (use e.g. "500ms", "5s", "1m")`);
  return Number(match[1]) * UNITS[match[2]!]!;
}

export interface EveryOptions {
  /** Also run once right at startup. */
  immediate?: boolean;
}

/**
 * Run a method periodically on a singleton service. Runs never overlap: the
 * next one is scheduled after the previous finishes. The method gets an
 * AbortSignal that fires at shutdown.
 *
 * ```ts
 * @every("5m") async sweep(signal: AbortSignal) { ... }
 * ```
 */
export function every(interval: string | number, options: EveryOptions = {}) {
  const ms = parseDuration(interval);
  if (ms <= 0) throw new TypeError(`@every interval must be positive`);
  return (_method: (this: any, signal: AbortSignal) => unknown, context: ClassMethodDecoratorContext): void => {
    if (context.static || context.private) throw new TypeError("@every must decorate a public instance method");
    EVERY.ownArray<EveryEntry>(context.metadata).push({ method: context.name, ms, immediate: options.immediate ?? false });
  };
}

/** What a @hosted class must implement. */
export interface HostedService {
  /** Long-running work. Resolve or return when `signal` aborts (at shutdown). */
  run(signal: AbortSignal): unknown;
}

/**
 * A background service, like ASP.NET Core's BackgroundService: a singleton
 * whose `run(signal)` starts after boot and is told to stop at shutdown.
 *
 * ```ts
 * @hosted class Mailer { async run(signal: AbortSignal) { while (!signal.aborted) { ... } } }
 * ```
 */
export function hosted<C extends abstract new (...args: never[]) => HostedService>(value: C, context: ClassDecoratorContext<C>): void {
  addService(value, context as ClassDecoratorContext, { lifetime: "singleton" }, true);
}
