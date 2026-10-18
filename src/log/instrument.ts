/**
 * `@instrument`, after Rust's `#[instrument]`: a span around a method, with
 * its arguments as fields, the return value and duration on exit, and
 * errors logged (and rethrown).
 *
 * ```ts
 * class UserRepo {
 *   @instrument() find(id: number) { // UserRepo::find{id=7} ... 5.1ms
 *     return this.db.users.get(id);
 *   }
 *
 *   @instrument({ skip: ["password"], level: "info" })
 *   create(email: string, password: string) {
 *     return this.db.users.add(email, password);
 *   }
 *
 *   @instrument({ fields: (_self, [order]) => ({ orderId: order.id }) })
 *   charge(order: Order) {
 *     return this.stripe.charge(order);
 *   }
 * }
 * ```
 *
 * Disabled (the default `debug` level under `YERD_LOG=info`) means the method
 * is called directly: no argument capture, no timing, no record. Sync
 * methods stay sync. Fields named like secrets are redacted whatever you do.
 */

import type { Level } from "./ilogger.js";
import { compilePath, prunePaths } from "./paths.js";
import { withSpan } from "./span.js";

// ── typed argument paths ──
//
// TypeScript can't see parameter names (Parameters<F> keeps positions and
// types; the labels are display-only), so paths are checked as far as types
// go: a positional path ("1.headers.authorization") is checked all the way
// down, a named one ("opts.headers.authorization") from the second segment
// on, and the name itself when the class loads, against the parameter names
// read from the compiled source.

type Depth = [never, 0, 1, 2, 3, 4];
type Leaf = string | number | boolean | bigint | symbol | null | undefined | Date | RegExp | URL | Function | Uint8Array | ArrayBuffer;

/** Every dotted path into `T`: nested fields, optional ones, array items (`items.0.secret`). Five levels deep at most. */
export type DeepPath<T, D extends number = 4> = [D] extends [never]
  ? never
  : T extends Leaf
    ? never
    : T extends readonly (infer Item)[]
      ? `${number}` | `${number}.${DeepPath<NonNullable<Item>, Depth[D]>}`
      : T extends object
        ? { [K in keyof T & string]-?: K | `${K}.${DeepPath<NonNullable<T[K]>, Depth[D]>}` }[keyof T & string]
        : never;

/** A path rooted at an argument's position: "0", "1.password", "2.items.0.token". Wildcards ("card.*", "**.cvc") are checked up to the first one. */
export type ArgPath<Args extends readonly unknown[]> = {
  [I in keyof Args & `${number}`]: I | `${I}.${DeepPath<NonNullable<Args[I]>>}`;
}[keyof Args & `${number}`];

/**
 * Check one `skip` entry: a valid positional path, a parameter name (checked
 * when the class loads), or `name.path` whose path exists in some parameter.
 * An invalid entry becomes a message type, so the error says what's wrong.
 */
export type SkipPath<E extends string, Args extends readonly unknown[]> = E extends `${infer Pre}*${string}`
  ? WildcardSkip<E, Pre, Args>
  : PlainSkip<E, Args>;

/** A path with a wildcard ("card.*", "**.cvc"): what comes before the first wildcard must be a valid path. */
type WildcardSkip<E extends string, Pre extends string, Args extends readonly unknown[]> = Pre extends ""
  ? E
  : Pre extends `${infer Prefix}.`
    ? PlainSkip<Prefix, Args> extends Prefix
      ? E
      : `skip "${E}": "${Prefix}" isn't a field of any argument`
    : `skip "${E}": a wildcard is a whole segment ("*" or "**"), not part of one`;

type PlainSkip<E extends string, Args extends readonly unknown[]> = E extends ArgPath<Args>
  ? E
  : E extends `${number}`
    ? `skip "${E}": there's no argument at that position`
    : E extends `${infer Index extends number}.${infer Rest}`
      ? `skip "${E}": argument ${Index} has no field "${Rest}"`
    : E extends `${string}.${infer Rest}`
      ? E extends `${infer _Root}.${Rest}`
        ? Rest extends DeepPath<NonNullable<Args[number]>>
          ? E
          : `skip "${E}": no parameter has a field "${Rest}"`
        : E
      : E;

/**
 * Options for @instrument. All optional; `@instrument()` alone records every
 * argument and the return value at debug level.
 *
 * ```ts
 * // Every field of card left out (card.* is a wildcard path); no return value recorded.
 * @instrument({ name: "charge", level: "info", target: "billing", skip: ["card.*"], ret: false })
 * async charge(orderId: string, card: { number: string; cvc: string }) {
 *   return this.stripe.charge(orderId, card);
 * }
 * ```
 */
export interface InstrumentOptions<This = any, Args extends unknown[] = any[], S extends readonly string[] = readonly string[]> {
  /** Span name. Default `Class::method`. */
  name?: string;
  /** Level of the span's records. Default "debug". */
  level?: Level;
  /** Category. Default the class name. */
  target?: string;
  /**
   * Arguments, or fields inside them, to leave out of the span: a parameter
   * name (`"password"`), a position (`"1"`), or a dotted path into either
   * (`"opts.headers.authorization"`, `"1.items.0.token"`). A segment can be
   * `*`, any one key or index, or `**`, any depth: `"card.*"` (every field of
   * card), `"*.password"` (password in any argument), `"**.cvc"` (anywhere),
   * `"items.*.secret"` (in every item). Checked by the compiler as far as
   * types allow (up to the first wildcard), and the names when the class
   * loads. For app-wide masking, see `logging({ redact })`.
   *
   * ```ts
   * @instrument({ skip: ["input.password", "1.headers.authorization"] })
   * create(input: Signup, request: { headers: { authorization: string } }) {
   *   return this.users.add(input);
   * }
   *
   * @instrument({ level: "info", skip: ["card.*", "**.cvc", "items.*.secret"] })
   * charge(card: Card, items: LineItem[]) {
   *   return this.stripe.charge(card, items);
   * }
   * ```
   */
  // A mapped type alone (no intersection with S) so a wrong entry's error is
  // the message SkipPath built, at that entry.
  skip?: { readonly [K in keyof S]: SkipPath<S[K] & string, Args> };
  /** Record no arguments. */
  skipAll?: boolean;
  /**
   * Extra or derived fields, from the instance and the arguments. Only called
   * when the span is enabled.
   *
   * ```ts
   * @instrument({ skipAll: true, fields: (self, [order]) => ({ orderId: order.id, region: self.region }) })
   * ship(order: Order) { return this.carrier.book(order); }
   * ```
   */
  fields?: (self: This, args: Args) => Record<string, unknown>;
  /** Record the return value on exit. Default true. */
  ret?: boolean;
  /** Log a throw at error level. Default true. Always rethrown. */
  err?: boolean;
}

const QUOTES = "\"'`";

/** Where the string literal opening at `start` ends (its closing quote), skipping escapes. */
function closingQuote(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === quote) return i;
  }
  return source.length;
}

/**
 * Parameter names from a function's compiled source, read once when the
 * decorator runs. JavaScript keeps no parameter names at runtime, but
 * compiler output is predictable enough: `find(id, opts = {})` gives
 * ["id", "opts"]; destructured or rest parameters become `arg0`, `arg1`.
 */
export function parameterNames(fn: Function): string[] {
  const source = fn.toString();
  const open = source.indexOf("(");
  if (open === -1) return [];
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if (QUOTES.includes(c)) i = closingQuote(source, i);
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [];
  const list = source.slice(open + 1, close);
  const params: string[] = [];
  let current = "";
  depth = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if (QUOTES.includes(c)) {
      // A default value's string may hold commas or brackets: copy it whole.
      const end = closingQuote(list, i);
      current += list.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      params.push(current);
      current = "";
    } else current += c;
  }
  if (current.trim()) params.push(current);
  return params.map((p, i) => {
    const name = p.split("=")[0]!.trim();
    return /^[A-Za-z_$][\w$]*$/.test(name) ? name : `arg${i}`;
  });
}

/**
 * Resolve skip entries to argument positions, once, when the decorator runs:
 * position -> nested paths to drop ([] drops the whole argument). A name
 * that isn't one of the method's parameters throws here, at class definition.
 */
/**
 * A parameter by name. Compilers rename a parameter that shadows an outer
 * variable by adding a number (`input` becomes `input2` in esbuild output), so
 * an unambiguous match without that suffix counts too. Positional paths
 * ("0.secret") don't depend on names at all.
 */
function findParameter(names: string[], name: string): number {
  const exact = names.indexOf(name);
  if (exact >= 0) return exact;
  const renamed = names.flatMap((n, i) => (n.replace(/\d+$/, "") === name ? [i] : []));
  return renamed.length === 1 ? renamed[0]! : -1;
}

/**
 * `skip` entries as field paths over the arguments by name: a positional
 * root ("0.secret") becomes its parameter's name, a wildcard root ("*",
 * "**") stays. A root naming no parameter is an error when the class loads.
 */
function compileSkip(entries: readonly string[], names: string[], method: string): string[][] {
  return entries.map((entry) => {
    const [root, ...path] = compilePath(entry);
    if (root === "*" || root === "**") return [root, ...path];
    const index = /^\d+$/.test(root!) ? Number(root) : findParameter(names, root!);
    if (index < 0 || (/^\d+$/.test(root!) && names.length > 0 && index >= names.length)) {
      throw new TypeError(`@instrument skip "${entry}": ${method}(${names.join(", ")}) has no parameter "${root}"`);
    }
    return [names[index] ?? `arg${index}`, ...path];
  });
}

/**
 * The class name for a default target. Bundlers rename a class whose name
 * clashes with another in the bundle (`TodoList` becomes `TodoList$1`); the
 * suffix is dropped so targets and YERD_LOG filters match what you wrote.
 */
export function className(self: unknown): string {
  const name = (self as { constructor?: { name?: string } } | undefined)?.constructor?.name;
  return name ? name.replace(/\$\d+$/, "") : "anonymous";
}

/**
 * Wrap a method in a span; see the module notes above. Call it, even with no
 * options: `@instrument()`. Works on any class: services, routes, plain
 * classes. A misspelled `skip` name throws when the class is defined.
 *
 * ```ts
 * @service
 * export class UserRepo {
 *   @instrument() async find(id: number) {
 *     return { id, name: "ada" };
 *   }
 *
 *   @instrument({ skip: ["password"], level: "info" })
 *   async create(email: string, password: string) {
 *     return { email };
 *   }
 *
 *   // Wildcards: any field of profile's billing, and cvc wherever it shows up.
 *   @instrument({ skip: ["profile.billing.*", "**.cvc"] })
 *   async update(id: number, profile: { name: string; billing: { card: string; cvc: string } }) {
 *     return { id, name: profile.name };
 *   }
 * }
 * ```
 */
export function instrument<This, Args extends unknown[], R, const S extends readonly string[] = []>(
  options: InstrumentOptions<This, Args, S> = {},
) {
  return function (method: (this: This, ...args: Args) => R, context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => R>) {
    const names = parameterNames(method);
    const methodName = String(context.name);
    const skip = compileSkip((options.skip ?? []) as readonly string[], names, methodName);
    return function (this: This, ...args: Args): R {
      const target = options.target ?? className(this);
      const self = this;
      return withSpan(
        {
          name: options.name ?? `${target}::${methodName}`,
          target,
          level: options.level ?? "debug",
          // A getter: withSpan reads it only after the filter check, so a
          // disabled span never captures its arguments.
          get fields() {
            let fields: Record<string, unknown> = {};
            if (!options.skipAll) {
              args.forEach((value, i) => (fields[names[i] ?? `arg${i}`] = value));
              // A copy without the skipped fields; the arguments themselves are never touched.
              if (skip.length) fields = prunePaths(fields, skip) as Record<string, unknown>;
            }
            if (options.fields) Object.assign(fields, options.fields(self, args));
            return fields;
          },
          onReturn: options.ret === false ? undefined : (value) => (value === undefined ? undefined : { ret: value }),
          err: options.err,
        },
        () => method.apply(self, args),
      );
    };
  };
}
