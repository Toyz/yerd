/**
 * Guards: gates in front of route handlers and actions.
 *
 * Two kinds, usable together:
 *
 * - Named guards, loom style: `@guard("auth")` on a method of a @service class,
 *   referenced by name in `guards: ["auth"]` on routes and groups, or
 *   `@guards("auth")`. The service is resolved through DI when the guard
 *   runs, so its @inject fields work and its lifetime is respected.
 * - Value guards from `createGuard(fn)`: usable directly as decorators
 *   (`@authenticated`, `@role("admin")`) or in `guards: [...]` lists.
 *
 * A guard returns `true` (or nothing) to continue, a string to redirect there
 * (303), `false` for 403, an Error (thrown or returned, e.g.
 * `ok || new HttpError(403)`), or anything else, which becomes the response
 * through the normal coercion table.
 *
 * Order: app guards, then the group chain outer to inner, then the route's
 * `guards` option, then class-level guards, then the method's. The first one
 * that doesn't continue decides the response.
 */

import type { YerdContext } from "../server/context.js";
import { createKey } from "./keys.js";

export type GuardResult = boolean | string | void | undefined | unknown;
/**
 * A guard's check: gets the request context and returns a guard result (see
 * the module notes above). May be async. Type a check with it when you keep
 * it apart from createGuard(), to share or test it on its own.
 *
 * ```ts
 * const hasApiKey: GuardFn = (ctx) =>
 *   ctx.headers["x-api-key"] === process.env.API_KEY || new HttpError(401, "Bad API key");
 *
 * export const apiKey = createGuard("apiKey", hasApiKey);
 * ```
 */
export type GuardFn = (ctx: YerdContext) => GuardResult | Promise<GuardResult>;

const GUARD: unique symbol = Symbol.for("yerd.guard");

/**
 * A value guard, as createGuard() returns it. The same object is a class or
 * method decorator, an entry in a `guards` list, and (through `run`) a plain
 * function you can call in a test.
 *
 * ```tsx
 * const staffOnly: GuardRef = createGuard("staffOnly", (ctx) => ctx.headers["x-staff"] === "yes");
 *
 * @route("/staff") @staffOnly
 * export class StaffHome {
 *   @get page() { return <h1>Staff</h1>; }
 * }
 *
 * @group("/ops", { guards: [staffOnly] })
 * export class Ops {}
 * ```
 */
export interface GuardRef {
  /** Brand that marks a createGuard() result. */
  readonly [GUARD]: true;
  /** The name given to createGuard(), used in logs and errors. */
  readonly label: string;
  /**
   * The check itself, callable without a server: hand it a stand-in context
   * holding just what the guard reads.
   *
   * ```ts
   * const result = await staffOnly.run({ headers: {} } as unknown as YerdContext); // false: a 403
   * ```
   */
  readonly run: GuardFn;
  (value: Function, context: ClassDecoratorContext | ClassMethodDecoratorContext): void;
}

/**
 * A guard in a `guards` list: the name of a @guard service method, or a value
 * guard from createGuard(). Lists can mix both.
 *
 * ```tsx
 * const adminGuards: GuardSpec[] = ["auth", staffOnly]; // a @guard name and a value guard
 *
 * @route("/admin/users", { guards: adminGuards })
 * export class AdminUsers {
 *   @get list() { return <h1>Users</h1>; }
 * }
 * ```
 */
export type GuardSpec = string | GuardRef;

export function isGuardRef(value: unknown): value is GuardRef {
  return typeof value === "function" && (value as Partial<GuardRef>)[GUARD] === true;
}

export const CLASS_GUARDS = createKey<GuardSpec[]>("guards:class");
export const METHOD_GUARDS = createKey<Map<string | symbol, GuardSpec[]>>("guards:method");

const CLASS_SLOT = Symbol("class");
/** Per class, per slot (the class or a method): how many guards came from the parent class. */
const inheritedCounts = new WeakMap<DecoratorMetadataObject, Map<string | symbol, number>>();

/**
 * TC39 applies stacked decorators bottom-up, so each one goes in ahead of the
 * ones this class already applied (but after the parent's): `@a @b` runs a, then b.
 */
function insert(metadata: DecoratorMetadataObject, slot: string | symbol, list: readonly GuardSpec[], specs: readonly GuardSpec[]): GuardSpec[] {
  let counts = inheritedCounts.get(metadata);
  if (!counts) inheritedCounts.set(metadata, (counts = new Map()));
  if (!counts.has(slot)) counts.set(slot, list.length);
  const at = counts.get(slot)!;
  return [...list.slice(0, at), ...specs, ...list.slice(at)];
}

function attach(specs: readonly GuardSpec[], context: ClassDecoratorContext | ClassMethodDecoratorContext): void {
  if (context.kind === "class") {
    const own = CLASS_GUARDS.ownArray<GuardSpec>(context.metadata);
    own.splice(0, own.length, ...insert(context.metadata, CLASS_SLOT, own, specs));
  } else {
    if (context.static || context.private) throw new TypeError(`Guards must be on public instance methods (got ${String(context.name)})`);
    const map = METHOD_GUARDS.ownMap<string | symbol, GuardSpec[]>(context.metadata);
    map.set(context.name, insert(context.metadata, context.name, map.get(context.name) ?? [], specs));
  }
}

/**
 * Make a value guard.
 *
 * ```tsx
 * export const businessHours = createGuard("businessHours", () => {
 *   const h = new Date().getHours();
 *   return (h >= 9 && h < 17) || new HttpError(403, "Come back during business hours");
 * });
 *
 * @route("/support") @businessHours
 * export class Support {
 *   @get page() { return <h1>Support</h1>; }
 * }
 * ```
 */
export function createGuard(label: string, run: GuardFn): GuardRef {
  const ref = function (this: unknown, _value: Function, context: ClassDecoratorContext | ClassMethodDecoratorContext) {
    attach([ref as GuardRef], context);
  } as GuardRef;
  Object.defineProperties(ref, {
    [GUARD]: { value: true },
    label: { value: label },
    run: { value: run },
  });
  return ref;
}

/**
 * Apply guards (names of @guard methods, or value guards) to a class or
 * method. On a class they cover every handler and action; on a method, just
 * that one. They run in the order listed, after the class's guards.
 *
 * ```tsx
 * @route("/billing")
 * @guards("beta")
 * export class Billing {
 *   @get page() { return <h1>Billing</h1>; }
 *
 *   @post @guards(signedIn, "staff") refund() { return 204; }
 * }
 * ```
 */
export function guards(...specs: GuardSpec[]) {
  return (_value: Function, context: ClassDecoratorContext | ClassMethodDecoratorContext): void => attach(specs, context);
}

export interface NamedGuard {
  name: string;
  method: string | symbol;
  /** Metadata of the declaring class; matched to a service registration at boot. */
  metadata: DecoratorMetadataObject;
}

/** Every @guard method, in definition order. */
export const guardRegistry: NamedGuard[] = [];

const resetHooks: Array<() => void> = [];

/** @internal Run `fn` whenever the guard registry resets (dev reloads), for state that lives beside it. */
export function onGuardRegistryReset(fn: () => void): void {
  resetHooks.push(fn);
}

/**
 * Forget every @guard method. Dev servers call it before re-importing the app
 * (prefer `app.resetRegistries()`, which reaches the copy of yerd the app
 * uses); tests that define @guard services per test can call it between them.
 *
 * ```ts
 * afterEach(() => {
 *   resetServiceRegistry();
 *   resetGuardRegistry();
 * });
 * ```
 */
export function resetGuardRegistry(): void {
  guardRegistry.length = 0;
  for (const fn of resetHooks) fn();
}

/**
 * Define a named guard on a @service method; the name defaults to the method
 * name. The method gets the request context and returns a guard result.
 *
 * ```ts
 * @service
 * export class Flags {
 *   @inject(FlagStore) accessor store!: FlagStore;
 *
 *   @guard("beta") beta(ctx: YerdContext) {
 *     return this.store.isOn("beta", ctx.path) || "/waitlist";
 *   }
 * }
 *
 * @route("/beta", { guards: ["beta"] })
 * export class Beta {
 *   @get page() { return "You're in"; }
 * }
 * ```
 */
export function guard(name?: string) {
  return (_method: (ctx: YerdContext) => unknown, context: ClassMethodDecoratorContext): void => {
    if (context.static || context.private) throw new TypeError("@guard must decorate a public instance method");
    guardRegistry.push({ name: name ?? String(context.name), method: context.name, metadata: context.metadata });
  };
}
