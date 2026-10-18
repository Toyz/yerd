/**
 * The decorator kit. Built-in request accessors (@param, @query, @body, ...)
 * are written with these same public functions; nothing built in gets a
 * private hook.
 */

import { currentContext, type RouteInfo, type YerdContext } from "../server/context.js";
import { createKey, localKey } from "./keys.js";

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
export const ARGS = createKey<Map<string | symbol, readonly Resolver[]>>("args");

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

function isAccessorContext(value: unknown): value is ClassAccessorDecoratorContext {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "accessor";
}

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
  // Per-request memo slot for this accessor; local so two accessors with the same name never share it.
  const memo = localKey<Map<string, unknown>>(`memo:${name}`);

  const resolverFor = (args: A): Resolver => {
    const memoKey = argsKey(args);
    const resolver: Resolver = {
      name,
      args,
      resolve(ctx) {
        let perAccessor = ctx.memo.get(memo.key) as Map<string, unknown> | undefined;
        if (!perAccessor) ctx.memo.set(memo.key, (perAccessor = new Map()));
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
      if (context.static || context.private) {
        throw new TypeError(`@${name} must decorate a public instance accessor (got ${String(context.name)})`);
      }
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
    if (input.length === 2 && isAccessorContext(input[1])) {
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
export function args<const R extends readonly Resolves<unknown>[]>(...resolvers: R) {
  return function <This>(
    _method: (this: This, ...args: ArgTypes<R>) => unknown,
    context: ClassMethodDecoratorContext<This>,
  ): void {
    if (context.static || context.private) {
      throw new TypeError(`@args must decorate a public instance method (got ${String(context.name)})`);
    }
    ARGS.ownMap<string | symbol, readonly Resolver[]>(context.metadata).set(
      context.name,
      resolvers.map((r) => r[RESOLVER]),
    );
  };
}
