/**
 * Dependency injection with ASP.NET Core's three lifetimes:
 *
 * - singleton: one per app (container)
 * - scoped:    one per request
 * - transient: a new one per resolution
 *
 * Instances are created with `new Class()`; dependencies arrive through
 * `@inject accessor` fields (TC39 decorators can't decorate constructor
 * parameters). Anything with `[Symbol.asyncDispose]` / `[Symbol.dispose]` is
 * disposed in reverse creation order: scoped at the end of the request,
 * singletons at shutdown. A transient lives as long as whatever holds it: one
 * injected into a singleton is disposed at shutdown, one injected into a
 * request-scoped instance (or resolved inside a request) at the end of the
 * request. A transient resolved directly outside any scope (resolve() in an
 * @every method, say) isn't tracked at all: the caller owns its disposal.
 * Factory registrations are tracked like classes; `value()` registrations
 * are never disposed by yerd.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { localKey } from "../decorators/keys.js";
import { maybeContext } from "../server/context.js";

/** How long a service instance lives: one per app, one per request, or a new one per resolution. */
export type Lifetime = "singleton" | "scoped" | "transient";

const TOKEN: unique symbol = Symbol.for("yerd.token");

/** A DI key for things with no runtime class: interfaces, config objects. */
export interface Token<T> {
  /** Brand that marks a token() result. */
  readonly [TOKEN]: true;
  /** The name given to token(), used in error messages. */
  readonly name: string;
  /** Phantom: carries T for type inference. */
  readonly __type?: T;
}

/**
 * Make a DI key for a type with no runtime class. Tokens compare by
 * identity, not name, so create each one once and export it. A token needs an
 * implementation when registered.
 *
 * ```ts
 * export const Config = token<{ dbUrl: string }>("Config");
 * app.services((s) => s.value(Config, { dbUrl: process.env.DB_URL! }));
 * ```
 */
export function token<T>(name: string): Token<T> {
  return { [TOKEN]: true, name };
}

export type Constructor<T> = abstract new (...args: never[]) => T;
/** What a service is registered and resolved by: a class or a token. */
export type ServiceKey<T = unknown> = Token<T> | Constructor<T>;

export function keyName(key: ServiceKey): string {
  return typeof key === "function" ? key.name || "anonymous class" : `token(${key.name})`;
}

export interface Registration {
  key: ServiceKey;
  lifetime: Lifetime;
  /** The class, when the registration is a class (used for metadata checks). */
  impl?: Function;
  create(container: Container): unknown;
}

/** The container an instance was created by, so its @inject fields resolve there. */
export const OWNER = localKey<Container>("owner");

interface ServiceContext {
  container: Container;
  scope: Scope | undefined;
  /** Where transients created here are tracked; null: nobody (the caller owns them). Unset: decided by scope. */
  tracker?: unknown[] | null;
}

/**
 * The disposal list each instance was put on (or would be, if it were
 * disposable), so the transients it holds can share its lifetime. A symbol
 * property like OWNER rather than a WeakMap: routes are constructed per
 * request, and WeakMap entries are costly for the garbage collector.
 */
const TRACKER = localKey<unknown[] | null>("tracker");

/** Tracked objects that can't take a symbol property (frozen, sealed): rare, so a WeakSet is fine. */
const trackedFrozen = new WeakSet<object>();

function isTracked(instance: object): boolean {
  return TRACKER.hasOwn(instance) || trackedFrozen.has(instance);
}

function markTracked(instance: object, tracker: unknown[] | null): void {
  if (Object.isExtensible(instance)) TRACKER.set(instance, tracker);
  else trackedFrozen.add(instance);
}

const storage = new AsyncLocalStorage<ServiceContext>();

export function runWithServices<T>(container: Container, scope: Scope | undefined, fn: () => T): T {
  return storage.run({ container, scope }, fn);
}

export function currentServices(): ServiceContext | undefined {
  // Inside a request, the request context carries its DI scope (one async
  // context for both); runWithServices() covers hooks, scripts and tests.
  return storage.getStore() ?? (maybeContext() as { services?: ServiceContext } | undefined)?.services;
}

/**
 * Resolve a service from the current app and request, for code that can't use
 * @inject: function components, layouts, plain functions.
 *
 * ```tsx
 * function Header() { const repo = resolve(TodoRepo); return <span>{repo.count}</span>; }
 * ```
 */
export function resolve<T>(key: ServiceKey<T>): T {
  const context = currentServices();
  if (!context) throw new Error(`Can't resolve ${keyName(key)}: not inside a yerd request, hook or scope`);
  return context.container.get(key, context.scope);
}

function disposerOf(value: unknown): (() => unknown) | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<symbol, unknown>;
  const asyncDispose = v[Symbol.asyncDispose];
  if (typeof asyncDispose === "function") return () => asyncDispose.call(value);
  const dispose = v[Symbol.dispose];
  if (typeof dispose === "function") return () => dispose.call(value);
  return undefined;
}

async function disposeAll(created: unknown[]): Promise<void> {
  const errors: unknown[] = [];
  for (let i = created.length - 1; i >= 0; i--) {
    try {
      await disposerOf(created[i])?.();
    } catch (error) {
      errors.push(error);
    }
  }
  created.length = 0;
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Several services failed to dispose");
}

/** One request's worth of scoped instances. */
export class Scope {
  /** Scoped instances by key, created on first resolution. */
  readonly instances = new Map<ServiceKey, unknown>();
  /** Disposable instances owned by this scope, in creation order. */
  readonly created: unknown[] = [];

  /** Nothing was resolved in this scope (the common case): disposing would be a no-op. */
  get isEmpty(): boolean {
    return this.instances.size === 0 && this.created.length === 0;
  }

  /** Dispose this scope's instances, newest first. Several failures are thrown as an AggregateError. */
  async dispose(): Promise<void> {
    this.instances.clear();
    await disposeAll(this.created);
  }
}

/**
 * The app's service container: registrations, singletons and their disposal.
 * The app builds it at boot (app.container); you normally resolve through
 * @inject or resolve() rather than calling it.
 */
export class Container {
  readonly #registrations = new Map<ServiceKey, Registration>();
  readonly #singletons = new Map<ServiceKey, unknown>();
  readonly #created: unknown[] = [];
  /** Keys whose create() is running, outermost first (see #creating). */
  readonly #resolving: ServiceKey[] = [];

  /** Add a registration, replacing any earlier one for the same key. */
  register(registration: Registration): void {
    this.#registrations.set(registration.key, registration);
  }

  /** The registration for `key`, if there is one. */
  registration(key: ServiceKey): Registration | undefined {
    return this.#registrations.get(key);
  }

  /** Every registration, in the order keys were first registered. */
  registrations(): IterableIterator<Registration> {
    return this.#registrations.values();
  }

  /** Whether anything is registered for `key`. */
  has(key: ServiceKey): boolean {
    return this.#registrations.has(key);
  }

  /** Construct a class owned by this container (its @inject fields resolve here). */
  construct<T>(cls: new () => T, scope: Scope | undefined, lifetime: Lifetime): T {
    const instance = new cls();
    // A constructor may freeze its instance; it then just can't carry the mark.
    if (typeof instance === "object" && instance !== null && Object.isExtensible(instance)) OWNER.set(instance, this);
    return this.adopt(instance, scope, lifetime);
  }

  /**
   * Track a freshly created instance (constructed, or returned by a factory)
   * for disposal per its lifetime. An instance already tracked (a factory
   * handing back another registration's instance, `(c) => c.get(Pool)`)
   * keeps the lifetime it has, so it's never disposed twice or early.
   */
  adopt<T>(instance: T, scope: Scope | undefined, lifetime: Lifetime): T {
    if (typeof instance !== "object" || instance === null || isTracked(instance)) return instance;
    const tracker = this.#trackerFor(scope, lifetime);
    markTracked(instance, tracker);
    if (tracker && disposerOf(instance)) tracker.push(instance);
    return instance;
  }

  #trackerFor(scope: Scope | undefined, lifetime: Lifetime): unknown[] | null {
    if (lifetime === "singleton") return this.#created;
    if (lifetime === "scoped") return scope?.created ?? this.#created;
    // A transient goes where its holder's lifetime says (see get()); otherwise
    // inside a request it lives as long as the request, and outside one it's
    // the caller's to dispose.
    const context = storage.getStore();
    if (context?.container === this && context.tracker !== undefined) return context.tracker;
    return scope ? scope.created : null;
  }

  /**
   * Resolve `key`. `holder` is the instance that will keep a transient result
   * (an @inject field's owner): the transient then shares its lifetime, so a
   * singleton's transient isn't disposed with the request that first read it.
   */
  get<T>(key: ServiceKey<T>, scope?: Scope, holder?: object): T {
    const registration = this.#registrations.get(key);
    if (!registration) throw new Error(`No service registered for ${keyName(key)}`);

    if (registration.lifetime === "singleton") {
      if (this.#singletons.has(key)) return this.#singletons.get(key) as T;
      const instance = this.#creating(key, () => runWithServices(this, undefined, () => registration.create(this)));
      this.#singletons.set(key, instance);
      return instance as T;
    }

    if (registration.lifetime === "scoped") {
      if (!scope) {
        throw new Error(
          `${keyName(key)} is scoped (one per request) and was resolved outside a request. ` +
            `Use app.scope(async () => ...) to create a scope by hand.`,
        );
      }
      if (scope.instances.has(key)) return scope.instances.get(key) as T;
      const instance = this.#creating(key, () => runWithServices(this, scope, () => registration.create(this)));
      scope.instances.set(key, instance);
      return instance as T;
    }

    const tracker = holder && TRACKER.has(holder) ? TRACKER.from(holder)! : scope ? scope.created : null;
    return this.#creating(key, () => storage.run({ container: this, scope, tracker }, () => registration.create(this))) as T;
  }

  /**
   * Run a registration's create(), refusing to re-enter a key already being
   * created: a constructor or factory that (indirectly) resolves itself
   * would otherwise recurse until the stack overflows. Creation is
   * synchronous, so one stack per container is enough.
   */
  #creating<T>(key: ServiceKey, create: () => T): T {
    if (this.#resolving.includes(key)) {
      const chain = [...this.#resolving.slice(this.#resolving.indexOf(key)), key].map(keyName).join(" -> ");
      throw new Error(`Circular dependency: ${chain}`);
    }
    this.#resolving.push(key);
    try {
      return create();
    } finally {
      this.#resolving.pop();
    }
  }

  /** Dispose singletons, newest first. */
  async dispose(): Promise<void> {
    this.#singletons.clear();
    await disposeAll(this.#created);
  }
}

/** Fluent registration API passed to `app.services(...)`. */
export class ServiceCollection {
  /** Created by the app; you receive one in app.services(). */
  constructor(private readonly add: (registration: Registration) => void) {}

  /**
   * Register a singleton. `impl` is a class or a factory `(container) => T`;
   * without it, `key` itself must be a class. Tells classes from factories
   * by their source (`class ...`), so pass plain functions only as factories.
   *
   * ```ts
   * app.services((s) => s
   *   .singleton(Clock, FakeClock)
   *   .singleton(Db, () => new Db(process.env.DB_URL!))
   *   .scoped(UnitOfWork));
   * ```
   */
  singleton<T>(key: ServiceKey<T>, impl?: (new () => T) | ((container: Container) => T)): this {
    return this.#register(key, "singleton", impl);
  }

  /** Register a scoped service (one per request); `impl` as for singleton(). */
  scoped<T>(key: ServiceKey<T>, impl?: (new () => T) | ((container: Container) => T)): this {
    return this.#register(key, "scoped", impl);
  }

  /** Register a transient service (a new instance per resolution); `impl` as for singleton(). */
  transient<T>(key: ServiceKey<T>, impl?: (new () => T) | ((container: Container) => T)): this {
    return this.#register(key, "transient", impl);
  }

  /** Register an existing value as a singleton. */
  value<T>(key: ServiceKey<T>, value: T): this {
    // Marked as tracked by nobody, so a factory returning it doesn't adopt it either.
    if (typeof value === "object" && value !== null && !isTracked(value)) markTracked(value, null);
    this.add({ key, lifetime: "singleton", create: () => value });
    return this;
  }

  #register<T>(key: ServiceKey<T>, lifetime: Lifetime, impl?: (new () => T) | ((container: Container) => T)): this {
    const target = impl ?? (typeof key === "function" ? (key as unknown as new () => T) : undefined);
    if (!target) throw new TypeError(`${keyName(key)} is a token, so it needs an implementation`);
    // A class, or an old-style constructor function with prototype methods;
    // anything else is a factory `(container) => instance`.
    const isClass =
      /^class[\s{]/.test(Function.prototype.toString.call(target)) ||
      (target.prototype !== undefined && Object.getOwnPropertyNames(target.prototype).length > 1);
    if (isClass) {
      const cls = target as new () => T;
      this.add({
        key,
        lifetime,
        impl: cls,
        create: (container) => container.construct(cls, currentServices()?.scope, lifetime),
      });
    } else {
      const factory = target as (container: Container) => T;
      this.add({ key, lifetime, create: (container) => container.adopt(factory(container), currentServices()?.scope, lifetime) });
    }
    return this;
  }
}
