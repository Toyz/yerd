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
 * `ok || new Forbidden()`), or anything else, which becomes the response
 * through the normal coercion table.
 *
 * Order: app guards, then the group chain outer to inner, then the route's
 * `guards` option, then class-level guards, then the method's. The first one
 * that doesn't continue decides the response.
 */

import type { YerdContext } from "../server/context.js";
import { checkMethod, classList, createMethodDecorator, methodList } from "./kit.js";

export type GuardResult = boolean | string | void | undefined | unknown;
/**
 * A guard's check: gets the request context and returns a guard result (see
 * the module notes above). May be async. Type a check with it when you keep
 * it apart from createGuard(), to share or test it on its own.
 *
 * ```ts
 * const hasApiKey: GuardFn = (ctx) =>
 *   ctx.headers["x-api-key"] === process.env.API_KEY || new Unauthorized("Bad API key");
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

/** Per class: its guards, top to bottom, after its parent's. */
export const CLASS_GUARDS = classList<GuardSpec>("guards");
/** Per method: its guards, top to bottom, after the ones it inherits. */
export const METHOD_GUARDS = methodList<GuardSpec>("guards");

/** One decorator for classes and methods: each kind has its own list. */
function attach(specs: readonly GuardSpec[], context: ClassDecoratorContext | ClassMethodDecoratorContext, label: string): void {
  if (context.kind === "class") return CLASS_GUARDS.add(context, ...specs);
  checkMethod(context, label);
  METHOD_GUARDS.add(context, ...specs);
}

/**
 * Make a value guard.
 *
 * ```tsx
 * export const businessHours = createGuard("businessHours", () => {
 *   const h = new Date().getHours();
 *   return (h >= 9 && h < 17) || new Forbidden("Come back during business hours");
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
    attach([ref as GuardRef], context, `@${label}`);
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
  return (_value: Function, context: ClassDecoratorContext | ClassMethodDecoratorContext): void => attach(specs, context, "@guards");
}

/** Per class: the inherited guards it skips (@skipGuards). */
export const CLASS_SKIPS = classList<GuardSpec>("skipGuards");
/** Per method: the guards it skips. */
export const METHOD_SKIPS = methodList<GuardSpec>("skipGuards");

/**
 * Skip guards this route would otherwise inherit: app-wide ones from
 * app.guard(), a group's, the class's. On a route or group class it covers
 * every handler and action under it; on a method, just that one. Guards are
 * matched as written: the same createGuard() value, or the same name.
 * Skipping one that isn't applied there stops the boot, so a typo can't
 * pass for an exemption.
 *
 * ```tsx
 * yerd().guard(auth.required);
 *
 * @route("/login")
 * @skipGuards(auth.required)
 * export class Login { ... }
 *
 * @route("/status")
 * export class Status {
 *   @get @skipGuards(auth.required) health() { return { ok: true }; }
 * }
 * ```
 */
export function skipGuards(...specs: GuardSpec[]) {
  return (_value: Function, context: ClassDecoratorContext | ClassMethodDecoratorContext): void => {
    if (context.kind === "class") return CLASS_SKIPS.add(context, ...specs);
    checkMethod(context, "@skipGuards");
    METHOD_SKIPS.add(context, ...specs);
  };
}

/** A guard spec as a person wrote it: its name, or a value guard's label. */
export function guardLabel(spec: GuardSpec): string {
  return typeof spec === "string" ? `"${spec}"` : spec.label;
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
export function guard(name?: string): (method: (ctx: YerdContext) => unknown, context: ClassMethodDecoratorContext) => void {
  return GUARD_METHOD(name);
}

const GUARD_METHOD = createMethodDecorator("guard", {
  apply(context, name?: string) {
    guardRegistry.push({ name: name ?? String(context.name), method: context.name, metadata: context.metadata });
  },
});
