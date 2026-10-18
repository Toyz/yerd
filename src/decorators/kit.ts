/**
 * The decorator kit. yerd's own decorators are written with these same
 * public functions: request accessors (@param, @query, @body, ...) with
 * createAccessor, method and class decorators (@get, @status, @catches,
 * @prerender, @onBoot, @action, ...) with the builders below. Nothing built
 * in gets a private hook.
 */

import { currentContext, type RouteInfo, type YerdContext } from "../server/context.js";
import { createKey, localKey, metadataOf, type YerdKey } from "./keys.js";
import { assertPublicInstance, isDecoratorContext } from "./util.js";

/**
 * What a request decorator knows how to resolve. Attached to every decorator
 * createAccessor produces, so the same `param("id")` works on an accessor
 * field and inside `@args(...)`. You don't build one yourself: createAccessor
 * does, from its function and options, and the app reads it at boot (for
 * `validate`) and per request (for `resolve`).
 *
 * ```ts
 * export const header = createAccessor((ctx, name: string) => ctx.headers[name], { name: "header" });
 * // header("x-tenant") carries a Resolver with name "header", args ["x-tenant"],
 * // and resolve(ctx) memoized per request.
 * ```
 */
export interface Resolver {
  /** The decorator's name, for boot errors (AccessorOptions.name). */
  readonly name: string;
  /** The arguments the decorator was called with, e.g. ["id", { transform: toInt }]. */
  readonly args: readonly unknown[];
  /** The boot-time check from AccessorOptions.validate, if any. */
  readonly validate?: (route: RouteInfo, ...args: never[]) => string | void;
  /** Memoized per request: every read in one request gets the same value (or the same promise). */
  resolve(ctx: YerdContext): unknown;
}

export interface AccessorEntry extends Resolver {
  field: string;
}

export const ACCESSORS = createKey<AccessorEntry[]>("accessors");

export const RESOLVER: unique symbol = Symbol.for("yerd.resolver");

/** Phantom marker carrying the value type a decorator resolves to, for @args. */
declare const OUTPUT: unique symbol;
/**
 * Carried by every decorator createAccessor() makes: its resolver, plus its
 * value type for @args inference. It's why a decorator can go straight into
 * `@args(...)` and the handler's parameter types are checked against it.
 *
 * ```ts
 * const locale = createAccessor((ctx) => ctx.headers["accept-language"]?.split(",")[0] ?? "en");
 * const forArgs: Resolves<string> = locale; // what @args reads
 *
 * @route("/greet")
 * export class Greet {
 *   @get @args(locale) page(lang: string) { return lang === "fr" ? "Bonjour" : "Hello"; }
 * }
 * ```
 */
export interface Resolves<Out> {
  /** Type-only: the value the decorator resolves to. Never set at runtime. */
  readonly [OUTPUT]?: Out;
  /** The resolver behind the decorator. */
  readonly [RESOLVER]: Resolver;
}

/**
 * The decorator returned by createAccessor. If the field's type can't hold the
 * resolver's value, the return type is an object with no accessor members,
 * which TypeScript rejects at the decorator site. Name it when you export a
 * decorator and want its value type spelled out (as `@toyz/yerd/auth` does
 * for `auth.user`).
 *
 * ```tsx
 * export const tenant: AccessorDecorator<string> = createAccessor(
 *   (ctx) => ctx.headers.host?.split(".")[0] ?? "www",
 *   { name: "tenant" },
 * );
 *
 * @route("/")
 * export class Home {
 *   @tenant accessor tenant!: string; // `accessor tenant!: number` would be a compile error
 *   @get page() { return <h1>{this.tenant}</h1>; }
 * }
 * ```
 */
export type AccessorDecorator<T> = (<This, V>(
  target: ClassAccessorDecoratorTarget<This, V>,
  context: ClassAccessorDecoratorContext<This, V>,
) => [NonNullable<T>] extends [V]
  ? ClassAccessorDecoratorResult<This, V>
  : { "accessor type does not accept the decorator's value": T }) &
  Resolves<T>;

/**
 * Options for createAccessor(). `validate` turns a mistake in how the
 * decorator is used into a boot error instead of a runtime surprise.
 *
 * ```ts
 * export const slug = createAccessor((ctx, name: string) => ctx.params[name], {
 *   name: "slug",
 *   validate: (route, name) => (route.paramNames.includes(name) ? undefined : `:${name} is not in ${route.pattern}`),
 * });
 *
 * @route("/posts/:slug")
 * export class Post {
 *   @slug("slug") accessor slug!: string; // @slug("id") here refuses to boot
 *   @get page() { return this.slug; }
 * }
 * ```
 */
export interface AccessorOptions<A extends unknown[]> {
  /** Shown in boot errors, e.g. "param". */
  name?: string;
  /**
   * Runs at boot for each route class using this accessor (and each @args
   * use), with the decorator's arguments. Return a message to refuse to boot.
   */
  validate?: (route: RouteInfo, ...args: A) => string | void;
}

type AccessorFactory<T, A extends unknown[]> = A extends [] ? AccessorDecorator<T> : (...args: A) => AccessorDecorator<T>;

const objectIds = new WeakMap<object, number>();
let nextObjectId = 0;

/** Memo key for an argument list; functions and objects by identity. */
function argsKey(args: readonly unknown[]): string {
  return args
    .map((arg) => {
      if ((typeof arg === "object" && arg !== null) || typeof arg === "function") {
        let id = objectIds.get(arg);
        if (id === undefined) objectIds.set(arg, (id = nextObjectId++));
        return `#${id}`;
      }
      return arg === undefined ? "u" : JSON.stringify(arg);
    })
    .join(",");
}

/**
 * Make an accessor decorator that reads a per-request value.
 *
 * ```ts
 * export const userAgent = createAccessor((ctx) => ctx.headers["user-agent"]);
 * class Page { @userAgent accessor ua: string | undefined; }
 * ```
 *
 * Values live in the request context, not on the instance, so the decorator
 * behaves the same whatever the class's lifetime. Each (accessor, args) pair is
 * resolved once per request. When the value is `undefined`, the field's
 * initializer is used: `@query("tab") accessor tab = "posts"`.
 *
 * A resolver may return a promise (like @body). The field then holds that
 * promise, created on first read and shared for the rest of the request, so
 * nothing async runs unless something reads the field.
 */
export function createAccessor<T, A extends unknown[] = []>(
  resolve: (ctx: YerdContext, ...args: A) => T,
  options: AccessorOptions<A> = {},
): AccessorFactory<T, A> {
  const name = options.name ?? (resolve.name || "accessor");
  // Per-request memo slot for this accessor: a fresh symbol, so two accessors with the same name never share it.
  const memo = Symbol(`yerd:memo:${name}`);

  const resolverFor = (args: A): Resolver => {
    const memoKey = argsKey(args);
    const resolver: Resolver = {
      name,
      args,
      resolve(ctx) {
        let perAccessor = ctx.memo.get(memo) as Map<string, unknown> | undefined;
        if (!perAccessor) ctx.memo.set(memo, (perAccessor = new Map()));
        if (perAccessor.has(memoKey)) return perAccessor.get(memoKey);
        const value = resolve(ctx, ...args);
        perAccessor.set(memoKey, value);
        return value;
      },
    };
    if (options.validate) (resolver as { validate?: unknown }).validate = options.validate;
    return resolver;
  };

  const make = (args: A) => {
    const resolver = resolverFor(args);
    const decorator = function <This, V>(
      target: ClassAccessorDecoratorTarget<This, V>,
      context: ClassAccessorDecoratorContext<This, V>,
    ): ClassAccessorDecoratorResult<This, V> {
      assertPublicInstance(context, `@${name}`);
      const field = String(context.name);
      ACCESSORS.ownArray<AccessorEntry>(context.metadata).push(Object.assign(Object.create(resolver), { field }));

      return {
        get(this: This): V {
          let value = resolver.resolve(currentContext());
          if (value === undefined) value = target.get.call(this);
          return value as V;
        },
        set(): void {
          throw new TypeError(`${field} is request data and can't be assigned`);
        },
      };
    };
    return Object.assign(decorator, { [RESOLVER]: resolver });
  };

  const bare = make([] as unknown as A);
  const factory = (...input: unknown[]) => {
    // Bare use (@params): called directly as a decorator with (target, context).
    if (input.length === 2 && isDecoratorContext(input[1], "accessor")) {
      return bare(input[0] as ClassAccessorDecoratorTarget<unknown, unknown>, input[1] as ClassAccessorDecoratorContext<unknown, unknown>);
    }
    return make(input as A);
  };
  // Bare use inside @args(params) reads the resolver off the factory itself.
  return Object.assign(factory, { [RESOLVER]: bare[RESOLVER] }) as unknown as AccessorFactory<T, A>;
}

type ArgTypes<R extends readonly Resolves<unknown>[]> = {
  [K in keyof R]: R[K] extends Resolves<infer Out> ? Awaited<Out> : never;
};

/**
 * Pass request values to a handler as arguments. TC39 decorators have no
 * parameter decorators, so the resolvers go on the method instead; the
 * method's parameter types are checked against them. Promises (like @body's)
 * are awaited first, so parameters get plain values.
 *
 * ```ts
 * class TodoChanges {
 *   @is.string({ optional: true }) title?: string;
 *   @is.boolean({ optional: true }) done?: boolean;
 * }
 *
 * @patch
 * @args(param("id", { transform: toInt }), body(TodoChanges))
 * update(id: number, changes: TodoChanges) {
 *   return this.todos.update(id, changes);
 * }
 * ```
 *
 * Any accessor works here, with the same options it takes as a field:
 * `body({ transform: dto(TodoChanges) })` or `query("page", { transform: toInt })`.
 */
export function args<const R extends readonly Resolves<unknown>[]>(
  ...resolvers: R
): <This>(method: (this: This, ...args: ArgTypes<R>) => unknown, context: ClassMethodDecoratorContext<This>) => void {
  return ARGS(resolvers.map((r) => r[RESOLVER]));
}

// ── Method and class decorators ──

/** A member name, as decorator contexts give it. */
type Member = string | symbol;

/**
 * What the kit's readers take: a class, or its decorator metadata object
 * (`context.metadata` inside a decorator, or `metadataOf(cls)`). Either way a
 * subclass sees what its parent declared, plus its own.
 *
 * ```ts
 * audit.has(Invoice, "refund");              // by class
 * audit.has(metadataOf(Invoice), "refund");  // by metadata: the same answer
 * ```
 */
export type DecoratorTarget = Function | DecoratorMetadataObject;

/** A method decorator's context, for any class (decorators here don't depend on `this`). */
type MethodContext = ClassMethodDecoratorContext<any, any>;
/** A class decorator's context, for any class. */
type ClassContext = ClassDecoratorContext<any>;

type MethodDecoratorFn = (method: Function, context: MethodContext) => void;
type ClassDecoratorFn = (value: Function, context: ClassContext) => void;
type WrappingDecoratorFn = <M extends Function>(method: M, context: MethodContext) => M | void;

const NO_MEMBERS: ReadonlySet<never> = new Set<never>();
const NO_ENTRIES: ReadonlyMap<never, never> = new Map<never, never>();
const NO_ITEMS: readonly never[] = Object.freeze([]);

function metadataFor(target: DecoratorTarget): DecoratorMetadataObject {
  return typeof target === "function" ? metadataOf(target) : target;
}

function labelFor(name: string): string {
  if (typeof name !== "string" || !/^[A-Za-z_$][\w$.]*$/.test(name)) {
    throw new TypeError(`A decorator's name is a plain identifier, like "audit" (got ${typeof name === "string" ? JSON.stringify(name) : typeof name})`);
  }
  return `@${name}`;
}

/** Which methods a decorator accepts, beyond "a method". */
interface MemberRules {
  /** Also static and #private methods. */
  anyMember?: boolean;
  /** Not symbol-named ones. */
  stringNamed?: boolean;
}

/**
 * Throw unless `context` is a method decorator's context the rules allow.
 * @internal Shared with yerd's own decorators that check before delegating.
 */
export function checkMethod(context: unknown, label: string, rules: MemberRules = {}): asserts context is MethodContext {
  if (!isDecoratorContext(context)) throw new TypeError(`${label} was used wrong: it decorates a method`);
  if (context.kind !== "method") throw new TypeError(`${label} must decorate a method (got ${context.kind} ${String(context.name)})`);
  const stringNamed = rules.stringNamed ?? false;
  if (!rules.anyMember) assertPublicInstance(context, label, { stringNamed });
  else if (stringNamed && typeof context.name !== "string") throw new TypeError(`${label} must decorate a string-named method (got ${String(context.name)})`);
}

/** Throw unless `context` is a class decorator's context. */
function checkClass(context: unknown, label: string): asserts context is ClassContext {
  if (!isDecoratorContext(context)) throw new TypeError(`${label} was used wrong: it decorates a class`);
  if (context.kind !== "class") throw new TypeError(`${label} must decorate a class (got ${context.kind} ${String(context.name)})`);
}

/** `@x` written bare where only `@x(...)` was declared. */
function refuseBare(args: readonly unknown[], label: string): void {
  if (args.length === 2 && typeof args[0] === "function" && isDecoratorContext(args[1])) {
    throw new TypeError(`${label} takes arguments: write ${label}(...)`);
  }
}

/** A decorator declared bare-only, written as a call: `@x()`. */
function refuseCall(context: unknown, label: string): void {
  if (!isDecoratorContext(context)) throw new TypeError(`${label} takes no arguments: write ${label}, not ${label}()`);
}

/** Run a `validate` option; a returned message becomes "@name: message". */
function runValidate<A extends unknown[]>(validate: ((...args: A) => string | void) | undefined, label: string, ...args: A): void {
  const message = validate?.(...args);
  if (typeof message === "string" && message !== "") throw new TypeError(`${label}: ${message}`);
}

/**
 * Per-member lists kept in the order the decorators are written. TC39
 * applies stacked decorators bottom-up, so each application goes in ahead of
 * what this class already added for the member, but after what it inherited.
 */
class MemberLists<T> {
  readonly #key: YerdKey<Map<Member, T[]>>;
  /** Per class, per member: how many entries came from the parent class. */
  readonly #inherited = new WeakMap<object, Map<Member, number>>();

  constructor(name: string) {
    this.#key = localKey<Map<Member, T[]>>(`kit:${name}`);
  }

  add(metadata: DecoratorMetadataObject, member: Member, items: readonly T[]): void {
    const map = this.#key.ownMap<Member, T[]>(metadata);
    let counts = this.#inherited.get(metadata);
    if (!counts) this.#inherited.set(metadata, (counts = new Map()));
    let list = map.get(member);
    let at = counts.get(member);
    if (at === undefined) {
      // First use in this class: copy what it inherited, never add to the parent's list.
      list = list ? list.slice() : [];
      map.set(member, list);
      counts.set(member, (at = list.length));
    }
    list!.splice(at, 0, ...items);
  }

  get(target: DecoratorTarget, member: Member): readonly T[] {
    return this.#key.from(metadataFor(target))?.get(member) ?? NO_ITEMS;
  }

  entries(target: DecoratorTarget): ReadonlyMap<Member, readonly T[]> {
    return this.#key.from(metadataFor(target)) ?? NO_ENTRIES;
  }
}

/**
 * A bare method decorator that flags the methods it's on, as methodFlag()
 * returns it: the decorator plus its readers.
 *
 * ```ts
 * export const audit: MethodFlag = methodFlag("audit");
 * ```
 */
export interface MethodFlag {
  (method: Function, context: MethodContext): void;
  /**
   * Whether `member` carries the flag (its own or inherited).
   *
   * ```ts
   * audit.has(Invoice, "refund"); // true
   * ```
   */
  has(target: DecoratorTarget, member: Member): boolean;
  /**
   * Every flagged member, in the order they were decorated.
   *
   * ```ts
   * for (const member of audit.members(Invoice)) console.log(String(member));
   * ```
   */
  members(target: DecoratorTarget): ReadonlySet<Member>;
  /**
   * Flag the method `context` names, from inside another decorator.
   *
   * ```ts
   * const sensitive = (_method: Function, context: ClassMethodDecoratorContext) => audit.mark(context);
   * ```
   */
  mark(context: MethodContext): void;
}

/**
 * Make a bare method decorator that flags methods, plus readers to find them
 * later. Public instance methods only; a subclass sees its parent's flags
 * and adds its own without changing the parent's.
 *
 * ```ts
 * export const audit = methodFlag("audit");
 *
 * @route("/invoices/:id")
 * class Invoice {
 *   @post @audit refund() { return 204; }
 * }
 *
 * audit.has(Invoice, "refund"); // true
 * ```
 */
export function methodFlag(name: string): MethodFlag {
  const label = labelFor(name);
  const key = localKey<Set<Member>>(`kit:${name}`);
  const mark = (context: MethodContext): void => {
    checkMethod(context, label);
    key.ownSet<Member>(context.metadata).add(context.name);
  };
  const decorator = (_method: Function, context: MethodContext): void => {
    refuseCall(context, label);
    mark(context);
  };
  return Object.assign(decorator, {
    has: (target: DecoratorTarget, member: Member) => key.from(metadataFor(target))?.has(member) ?? false,
    members: (target: DecoratorTarget): ReadonlySet<Member> => key.from(metadataFor(target)) ?? NO_MEMBERS,
    mark,
  });
}

/**
 * Options for methodValue(), methodList(), classValue() and classList().
 * `validate` checks each value as the decorator is called, so a bad one fails
 * on the line that wrote it, before the class exists.
 *
 * ```ts
 * export const summary = methodValue<string>("summary", {
 *   validate: (text) => (text.length <= 80 ? undefined : "keep it under 80 characters"),
 * });
 * // @summary("a".repeat(90)) throws "@summary: keep it under 80 characters"
 * ```
 */
export interface ValueOptions<T> {
  /** Return a message to refuse the value (or throw your own error). */
  validate?: (value: T) => string | void;
}

interface MethodValueReaders<T> {
  /**
   * The value on `member` (its own, else inherited), or undefined.
   *
   * ```ts
   * summary.get(Todos, "list"); // "List todos"
   * ```
   */
  get(target: DecoratorTarget, member: Member): T | undefined;
  /**
   * Every decorated member with its value, in the order they were decorated.
   *
   * ```ts
   * for (const [member, text] of summary.entries(Todos)) console.log(String(member), text);
   * ```
   */
  entries(target: DecoratorTarget): ReadonlyMap<Member, T>;
  /**
   * Store a value for the method `context` names, from inside another decorator.
   *
   * ```ts
   * const undocumented = (_method: Function, context: ClassMethodDecoratorContext) => summary.set(context, "TODO");
   * ```
   */
  set(context: MethodContext, value: T): void;
}

/**
 * A method decorator that stores one value per method, as methodValue()
 * returns it: `@summary("List todos")`. `MethodValue<T, true>` is the type
 * made with `bare`, which also works uncalled.
 *
 * ```ts
 * export const summary: MethodValue<string> = methodValue<string>("summary");
 * export const cache: MethodValue<number, true> = methodValue("cache", { bare: () => 60 });
 * ```
 */
export type MethodValue<T, Bare extends boolean = false> = MethodValueReaders<T> &
  (Bare extends true
    ? { (value?: T, _?: never): MethodDecoratorFn; (method: Function, context: MethodContext): void }
    : (value: T) => MethodDecoratorFn);

/**
 * Make a method decorator that stores a value per method:
 * `@summary("List todos")`. Written twice on one method, the top one wins; a
 * subclass's own value wins over its parent's. With `bare: () => value` it
 * also works uncalled (`@cache` as well as `@cache(300)`).
 *
 * ```ts
 * export const summary = methodValue<string>("summary");
 * export const cache = methodValue("cache", { bare: () => 60 }); // seconds
 *
 * @route("/todos")
 * class Todos {
 *   @get @summary("List todos") @cache list() { return []; }
 * }
 *
 * summary.get(Todos, "list"); // "List todos"
 * cache.get(Todos, "list");   // 60
 * ```
 */
export function methodValue<T>(name: string, options: ValueOptions<T> & { bare: () => T }): MethodValue<T, true>;
export function methodValue<T>(name: string, options?: ValueOptions<T>): MethodValue<T>;
export function methodValue<T>(name: string, options: ValueOptions<T> & { bare?: () => T } = {}): MethodValue<T, boolean> {
  const label = labelFor(name);
  const key = localKey<Map<Member, T>>(`kit:${name}`);
  const store = (context: MethodContext, value: T): void => {
    checkMethod(context, label);
    key.ownMap<Member, T>(context.metadata).set(context.name, value);
  };
  const set = (context: MethodContext, value: T): void => {
    runValidate(options.validate, label, value);
    store(context, value);
  };
  const decorate = (value: T): MethodDecoratorFn => (_method, context) => store(context, value);
  const bare = options.bare;
  const factory = (...args: unknown[]) => {
    if (bare && args.length === 2 && isDecoratorContext(args[1], "method")) return decorate(bare())(args[0] as Function, args[1]);
    if (!bare) refuseBare(args, label);
    const value = bare && args[0] === undefined ? bare() : (args[0] as T);
    runValidate(options.validate, label, value);
    return decorate(value);
  };
  return Object.assign(factory, {
    get: (target: DecoratorTarget, member: Member) => key.from(metadataFor(target))?.get(member),
    entries: (target: DecoratorTarget): ReadonlyMap<Member, T> => key.from(metadataFor(target)) ?? NO_ENTRIES,
    set,
  }) as unknown as MethodValue<T, boolean>;
}

/**
 * A method decorator that collects values per method, as methodList()
 * returns it: `@tags("billing", "admin")`.
 *
 * ```ts
 * export const tags: MethodList<string> = methodList<string>("tags");
 * ```
 */
export interface MethodList<T> {
  (...items: T[]): MethodDecoratorFn;
  /**
   * The member's values: its parent's first, then its own top to bottom.
   * Empty when it has none.
   *
   * ```ts
   * tags.get(Reports, "monthly"); // ["billing", "admin"]
   * ```
   */
  get(target: DecoratorTarget, member: Member): readonly T[];
  /**
   * Every decorated member with its values, in the order they were
   * decorated. A member decorated with no values is listed, with none.
   *
   * ```ts
   * for (const [member, list] of tags.entries(Reports)) index.add(String(member), list);
   * ```
   */
  entries(target: DecoratorTarget): ReadonlyMap<Member, readonly T[]>;
  /**
   * Add values for the method `context` names, from inside another decorator.
   *
   * ```ts
   * const billing = (_method: Function, context: ClassMethodDecoratorContext) => tags.add(context, "billing");
   * ```
   */
  add(context: MethodContext, ...items: T[]): void;
}

/**
 * Make a method decorator that collects values per method:
 * `@tags("billing", "admin")`. Stacked uses add up and read top to bottom; a
 * subclass's come after its parent's. `validate` checks each value.
 *
 * ```ts
 * export const tags = methodList<string>("tags");
 *
 * @route("/reports")
 * class Reports {
 *   @get @tags("billing") @tags("admin") monthly() { return []; }
 * }
 *
 * tags.get(Reports, "monthly"); // ["billing", "admin"]
 * ```
 */
export function methodList<T>(name: string, options: ValueOptions<T> = {}): MethodList<T> {
  const label = labelFor(name);
  const lists = new MemberLists<T>(name);
  const store = (context: MethodContext, items: readonly T[]): void => {
    checkMethod(context, label);
    lists.add(context.metadata, context.name, items);
  };
  const add = (context: MethodContext, ...items: T[]): void => {
    for (const item of items) runValidate(options.validate, label, item);
    store(context, items);
  };
  const factory = (...items: T[]): MethodDecoratorFn => {
    refuseBare(items, label);
    for (const item of items) runValidate(options.validate, label, item);
    return (_method, context) => store(context, items);
  };
  return Object.assign(factory, {
    get: (target: DecoratorTarget, member: Member) => lists.get(target, member),
    entries: (target: DecoratorTarget) => lists.entries(target),
    add,
  });
}

/**
 * A bare class decorator that flags classes, as classFlag() returns it.
 *
 * ```ts
 * export const internal: ClassFlag = classFlag("internal");
 * ```
 */
export interface ClassFlag {
  (value: Function, context: ClassContext): void;
  /**
   * Whether the class (or a parent of it) carries the flag.
   *
   * ```ts
   * internal.has(Health); // true
   * ```
   */
  has(target: DecoratorTarget): boolean;
  /**
   * Flag the class `context` names, from inside another decorator.
   *
   * ```ts
   * const ops = (_cls: Function, context: ClassDecoratorContext) => internal.mark(context);
   * ```
   */
  mark(context: ClassContext): void;
}

/**
 * Make a bare class decorator that flags classes. Subclasses inherit the flag.
 *
 * ```ts
 * export const internal = classFlag("internal");
 *
 * @internal
 * @route("/ops/health")
 * class Health {
 *   @get check() { return { ok: true }; }
 * }
 *
 * internal.has(Health); // true
 * ```
 */
export function classFlag(name: string): ClassFlag {
  const label = labelFor(name);
  const key = localKey<true>(`kit:${name}`);
  const mark = (context: ClassContext): void => {
    checkClass(context, label);
    key.set(context.metadata, true);
  };
  const decorator = (_value: Function, context: ClassContext): void => {
    refuseCall(context, label);
    mark(context);
  };
  return Object.assign(decorator, {
    has: (target: DecoratorTarget) => key.from(metadataFor(target)) === true,
    mark,
  });
}

interface ClassValueReaders<T> {
  /**
   * The class's value (its own, else its parent's), or undefined.
   *
   * ```ts
   * feature.get(Billing); // "beta"
   * ```
   */
  get(target: DecoratorTarget): T | undefined;
  /**
   * Store a value for the class `context` names, from inside another decorator.
   *
   * ```ts
   * const beta = (_cls: Function, context: ClassDecoratorContext) => feature.set(context, "beta");
   * ```
   */
  set(context: ClassContext, value: T): void;
}

/**
 * A class decorator that stores one value per class, as classValue()
 * returns it: `@feature("beta")`. `ClassValue<T, true>` is the type made
 * with `bare`, which also works uncalled.
 *
 * ```ts
 * export const feature: ClassValue<string> = classValue<string>("feature");
 * ```
 */
export type ClassValue<T, Bare extends boolean = false> = ClassValueReaders<T> &
  (Bare extends true
    ? { (value?: T, _?: never): ClassDecoratorFn; (value: Function, context: ClassContext): void }
    : (value: T) => ClassDecoratorFn);

/**
 * Make a class decorator that stores a value per class: `@feature("beta")`.
 * Subclasses inherit it unless they set their own. With `bare: () => value`
 * it also works uncalled, storing that value; that's how `@prerender` and
 * `@prerender({ paths })` are one decorator.
 *
 * ```ts
 * export const feature = classValue<string>("feature");
 *
 * @feature("beta")
 * @route("/billing")
 * class Billing {
 *   @get page() { return "Billing"; }
 * }
 *
 * const routes = [Home, Billing].filter((cls) => !feature.get(cls) || flags.on(feature.get(cls)!));
 * const app = yerd({ routes });
 * ```
 */
export function classValue<T>(name: string, options: ValueOptions<T> & { bare: () => T }): ClassValue<T, true>;
export function classValue<T>(name: string, options?: ValueOptions<T>): ClassValue<T>;
export function classValue<T>(name: string, options: ValueOptions<T> & { bare?: () => T } = {}): ClassValue<T, boolean> {
  const label = labelFor(name);
  const key = localKey<T>(`kit:${name}`);
  const store = (context: ClassContext, value: T): void => {
    checkClass(context, label);
    key.set(context.metadata, value);
  };
  const set = (context: ClassContext, value: T): void => {
    runValidate(options.validate, label, value);
    store(context, value);
  };
  const decorate = (value: T): ClassDecoratorFn => (_value, context) => store(context, value);
  const bare = options.bare;
  const factory = (...args: unknown[]) => {
    if (bare && args.length === 2 && isDecoratorContext(args[1], "class")) return decorate(bare())(args[0] as Function, args[1]);
    if (!bare) refuseBare(args, label);
    const value = bare && args[0] === undefined ? bare() : (args[0] as T);
    runValidate(options.validate, label, value);
    return decorate(value);
  };
  return Object.assign(factory, {
    get: (target: DecoratorTarget) => key.from(metadataFor(target)),
    set,
  }) as unknown as ClassValue<T, boolean>;
}

/**
 * A class decorator that collects values per class, as classList() returns
 * it: `@scopes("read", "write")`.
 *
 * ```ts
 * export const scopes: ClassList<string> = classList<string>("scopes");
 * ```
 */
export interface ClassList<T> {
  (...items: T[]): ClassDecoratorFn;
  /**
   * The class's values: its parent's first, then its own top to bottom.
   *
   * ```ts
   * scopes.get(Billing); // ["read", "write"]
   * ```
   */
  get(target: DecoratorTarget): readonly T[];
  /**
   * Add values for the class `context` names, from inside another decorator.
   *
   * ```ts
   * const admin = (_cls: Function, context: ClassDecoratorContext) => scopes.add(context, "admin");
   * ```
   */
  add(context: ClassContext, ...items: T[]): void;
}

const CLASS_SLOT = Symbol("class");

/**
 * Make a class decorator that collects values per class:
 * `@scopes("read", "write")`. Stacked uses add up and read top to bottom; a
 * subclass's come after its parent's. `validate` checks each value.
 *
 * ```ts
 * export const scopes = classList<string>("scopes");
 *
 * @scopes("read")
 * @scopes("write")
 * @route("/billing")
 * class Billing {
 *   @get page() { return "Billing"; }
 * }
 *
 * scopes.get(Billing); // ["read", "write"]
 * ```
 */
export function classList<T>(name: string, options: ValueOptions<T> = {}): ClassList<T> {
  const label = labelFor(name);
  const lists = new MemberLists<T>(name);
  const store = (context: ClassContext, items: readonly T[]): void => {
    checkClass(context, label);
    lists.add(context.metadata, CLASS_SLOT, items);
  };
  const add = (context: ClassContext, ...items: T[]): void => {
    for (const item of items) runValidate(options.validate, label, item);
    store(context, items);
  };
  const factory = (...items: T[]): ClassDecoratorFn => {
    refuseBare(items, label);
    for (const item of items) runValidate(options.validate, label, item);
    return (_value, context) => store(context, items);
  };
  return Object.assign(factory, {
    get: (target: DecoratorTarget) => lists.get(target, CLASS_SLOT),
    add,
  });
}

/**
 * Options for createMethodDecorator(). `validate` checks the arguments as the
 * decorator is called; `apply` runs where it's applied (with the method's
 * context: its name, its class's metadata); `wrap` returns a replacement for
 * the method. Each gets the decorator's arguments.
 *
 * ```ts
 * export const retry = createMethodDecorator("retry", {
 *   validate: (times: number) => (Number.isInteger(times) && times > 0 ? undefined : `${times} isn't a positive whole number`),
 *   wrap: (method, _context, times) =>
 *     async function (this: unknown, ...args: unknown[]) {
 *       for (let attempt = 0; ; attempt++) {
 *         try { return await method.apply(this, args); } catch (e) { if (attempt >= times) throw e; }
 *       }
 *     },
 *   anyMember: true, // a wrapper works on #private methods too
 * });
 * ```
 */
export interface MethodDecoratorOptions<A extends unknown[]> {
  /** true: also usable uncalled, `@x` as well as `@x(...)`, with no arguments; keep them optional. */
  bare?: boolean;
  /** Checks the arguments of a called use (`@x(...)`); return a message to refuse them (or throw your own error). */
  validate?: (...args: A) => string | void;
  /** Runs where the decorator is applied, with its arguments. Throw to refuse. */
  apply?: (context: MethodContext, ...args: A) => void;
  /** Return a function to replace the method (calling `method` from it), or nothing to keep it. */
  wrap?: (method: Function, context: MethodContext, ...args: A) => Function | void;
  /** true: static and #private methods are accepted too. For wrappers; readers key by name. */
  anyMember?: boolean;
  /** true: symbol-named methods are refused. */
  stringNamed?: boolean;
}

interface MethodDecoratorReaders<A extends unknown[]> {
  /**
   * Whether `member` carries the decorator (its own or inherited).
   *
   * ```ts
   * timed.has(Reports, "monthly"); // true
   * ```
   */
  has(target: DecoratorTarget, member: Member): boolean;
  /**
   * The arguments of each use on `member`, top to bottom (an empty list for
   * an uncalled use). Empty when it isn't decorated.
   *
   * ```ts
   * timed.get(Reports, "yearly"); // [["yearly report"]]
   * ```
   */
  get(target: DecoratorTarget, member: Member): readonly A[];
  /**
   * Every decorated member with the arguments of each use.
   *
   * ```ts
   * for (const [member, uses] of timed.entries(Reports)) console.log(String(member), uses.length);
   * ```
   */
  entries(target: DecoratorTarget): ReadonlyMap<Member, readonly A[]>;
}

/**
 * A method decorator as createMethodDecorator() returns it: called with its
 * arguments, plus its readers. `MethodDecoratorFactory<A, true>` is the type
 * made with `bare: true`, which also works uncalled.
 *
 * ```ts
 * export const timed: MethodDecoratorFactory<[label?: string], true> = createMethodDecorator("timed", { bare: true, wrap: timer });
 * ```
 */
export type MethodDecoratorFactory<A extends unknown[], Bare extends boolean = false> = MethodDecoratorReaders<A> &
  (Bare extends true
    ? { (...args: A): WrappingDecoratorFn; <M extends Function>(method: M, context: MethodContext): M | void }
    : (...args: A) => WrappingDecoratorFn);

/**
 * Make any other method decorator: one that wraps the method, checks where
 * it's used, or registers it somewhere. Like the other builders, it names
 * itself in errors, takes public instance methods only (unless `anyMember`),
 * and records each use for has/get/entries.
 *
 * ```ts
 * export const timed = createMethodDecorator("timed", {
 *   bare: true,
 *   wrap: (method, context, label?: string) =>
 *     async function (this: unknown, ...args: unknown[]) {
 *       const started = performance.now();
 *       try {
 *         return await method.apply(this, args);
 *       } finally {
 *         log.info(`${label ?? String(context.name)} took ${Math.round(performance.now() - started)}ms`);
 *       }
 *     },
 * });
 *
 * @service
 * class Reports {
 *   @timed async monthly() { return []; }
 *   @timed("yearly report") async yearly() { return []; }
 * }
 * ```
 */
export function createMethodDecorator<A extends unknown[] = []>(name: string, options: MethodDecoratorOptions<A> & { bare: true }): MethodDecoratorFactory<A, true>;
export function createMethodDecorator<A extends unknown[] = []>(name: string, options?: MethodDecoratorOptions<A>): MethodDecoratorFactory<A>;
export function createMethodDecorator<A extends unknown[] = []>(name: string, options: MethodDecoratorOptions<A> = {}): MethodDecoratorFactory<A, boolean> {
  const label = labelFor(name);
  const lists = new MemberLists<A>(name);
  const decorate =
    (args: A) =>
    (method: Function, context: MethodContext): Function | void => {
      checkMethod(context, label, options);
      options.apply?.(context, ...args);
      lists.add(context.metadata, context.name, [args]);
      return options.wrap?.(method, context, ...args) ?? undefined;
    };
  const factory = (...args: unknown[]) => {
    if (options.bare && args.length === 2 && isDecoratorContext(args[1], "method")) {
      return decorate([] as unknown as A)(args[0] as Function, args[1]);
    }
    if (!options.bare) refuseBare(args, label);
    runValidate(options.validate, label, ...(args as A));
    return decorate(args as A);
  };
  return Object.assign(factory, {
    has: (target: DecoratorTarget, member: Member) => lists.get(target, member).length > 0,
    get: (target: DecoratorTarget, member: Member) => lists.get(target, member),
    entries: (target: DecoratorTarget) => lists.entries(target),
  }) as unknown as MethodDecoratorFactory<A, boolean>;
}

/** Per handler method: the request values @args passes it. */
export const ARGS = methodValue<readonly Resolver[]>("args");
