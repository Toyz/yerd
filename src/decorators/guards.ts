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
export type GuardFn = (ctx: YerdContext) => GuardResult | Promise<GuardResult>;

const GUARD: unique symbol = Symbol.for("yerd.guard");

/** A value guard: callable as a class or method decorator, or listed in `guards`. */
export interface GuardRef {
  readonly [GUARD]: true;
  readonly label: string;
  readonly run: GuardFn;
  (value: Function, context: ClassDecoratorContext | ClassMethodDecoratorContext): void;
}

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
 * ```ts
 * export const businessHours = createGuard("businessHours", () => {
 *   const h = new Date().getHours();
 *   return (h >= 9 && h < 17) || new HttpError(403, "Come back during business hours");
 * });
 *
 * @route("/support") @businessHours class Support { ... }
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

/** Apply guards (names or value guards) to a class or method. */
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

export function resetGuardRegistry(): void {
  guardRegistry.length = 0;
  for (const fn of resetHooks) fn();
}

/**
 * Define a named guard on a @service method; the name defaults to the method
 * name. The method gets the request context and returns a guard result.
 *
 * ```ts
 * @service class AuthGuards {
 *   @inject(Sessions) accessor sessions!: Sessions;
 *   @guard("auth") check(ctx: YerdContext) { return this.sessions.current() ? true : "/login"; }
 * }
 * ```
 */
export function guard(name?: string) {
  return (_method: (ctx: YerdContext) => unknown, context: ClassMethodDecoratorContext): void => {
    if (context.static || context.private) throw new TypeError("@guard must decorate a public instance method");
    guardRegistry.push({ name: name ?? String(context.name), method: context.name, metadata: context.metadata });
  };
}
