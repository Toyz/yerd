/**
 * `@instrument`, after Rust's `#[instrument]`: a span around a method, with
 * its arguments as fields, the return value and duration on exit, and
 * errors logged (and rethrown).
 *
 * ```ts
 * @instrument() find(id: number) { ... }                      // UserRepo::find{id=7} ... 5.1ms
 * @instrument({ skip: ["password"], level: "info" }) create(email: string, password: string) { ... }
 * @instrument({ fields: (_self, [order]) => ({ orderId: order.id }) }) charge(order: Order) { ... }
 * ```
 *
 * Disabled (the default `debug` level under `YERD_LOG=info`) means the method
 * is called directly: no argument capture, no timing, no record. Sync
 * methods stay sync. Fields named like secrets are redacted whatever you do.
 */

import type { Level } from "./ilogger.js";
import { withSpan } from "./span.js";

/** Options for @instrument. */
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

/** A path rooted at an argument's position: "0", "1.password", "2.items.0.token". */
export type ArgPath<Args extends readonly unknown[]> = {
  [I in keyof Args & `${number}`]: I | `${I}.${DeepPath<NonNullable<Args[I]>>}`;
}[keyof Args & `${number}`];

/**
 * Check one `skip` entry: a valid positional path, a parameter name (checked
 * when the class loads), or `name.path` whose path exists in some parameter.
 * An invalid entry becomes a message type, so the error says what's wrong.
 */
export type SkipPath<E extends string, Args extends readonly unknown[]> = E extends ArgPath<Args>
  ? E
  : E extends `${number}`
    ? `skip "${E}": there's no argument at that position`
    : E extends `${string}.${infer Rest}`
      ? E extends `${infer _Root}.${Rest}`
        ? Rest extends DeepPath<NonNullable<Args[number]>>
          ? E
          : `skip "${E}": no parameter has a field "${Rest}"`
        : E
      : E;

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
   * (`"opts.headers.authorization"`, `"1.items.0.token"`). Checked by the
   * compiler as far as types allow, and the names when the class loads.
   */
  skip?: S & { readonly [K in keyof S]: SkipPath<S[K] & string, Args> };
  /** Record no arguments. */
  skipAll?: boolean;
  /** Extra or derived fields. */
  fields?: (self: This, args: Args) => Record<string, unknown>;
  /** Record the return value on exit. Default true. */
  ret?: boolean;
  /** Log a throw at error level. Default true. Always rethrown. */
  err?: boolean;
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
    const c = source[i];
    if (c === "(" || c === "[" || c === "{") depth++;
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
  for (const c of list) {
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

/** Wrap a method in a span; see the module notes above. Call it, even with no options: `@instrument()`. */
/**
 * Resolve skip entries to argument positions, once, when the decorator runs:
 * position -> nested paths to drop ([] drops the whole argument). A name
 * that isn't one of the method's parameters throws here, at class definition.
 */
function compileSkip(entries: readonly string[], names: string[], method: string): Map<number, string[][]> {
  const out = new Map<number, string[][]>();
  for (const entry of entries) {
    const [root, ...path] = entry.split(".");
    const index = /^\d+$/.test(root!) ? Number(root) : findParameter(names, root!);
    if (index < 0 || (/^\d+$/.test(root!) && names.length > 0 && index >= names.length)) {
      throw new TypeError(`@instrument skip "${entry}": ${method}(${names.join(", ")}) has no parameter "${root}"`);
    }
    const list = out.get(index) ?? [];
    if (path.length === 0) out.set(index, []);
    else if (!out.has(index) || list.length > 0) out.set(index, [...list, path]);
  }
  return out;
}

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

/** A copy of `value` without the fields at `paths`; never touches the original argument. */
function without(value: unknown, paths: string[][]): unknown {
  if (typeof value !== "object" || value === null) return value;
  const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? [...value] : { ...(value as Record<string, unknown>) };
  const here = paths.filter((p) => p.length === 1).map((p) => p[0]!);
  for (const key of here) {
    if (Array.isArray(copy)) copy[Number(key)] = "[skipped]";
    else delete (copy as Record<string, unknown>)[key];
  }
  const deeper = new Map<string, string[][]>();
  for (const p of paths) if (p.length > 1) deeper.set(p[0]!, [...(deeper.get(p[0]!) ?? []), p.slice(1)]);
  for (const [key, rest] of deeper) {
    const target = copy as Record<string, unknown>;
    if (key in target) target[key] = without(target[key], rest);
  }
  return copy;
}

export function instrument<This, Args extends unknown[], R, const S extends readonly string[] = []>(
  options: InstrumentOptions<This, Args, S> = {},
) {
  return function (method: (this: This, ...args: Args) => R, context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => R>) {
    const names = parameterNames(method);
    const methodName = String(context.name);
    const skip = compileSkip((options.skip ?? []) as readonly string[], names, methodName);
    return function (this: This, ...args: Args): R {
      const target = options.target ?? ((this as { constructor?: { name?: string } })?.constructor?.name || "anonymous");
      const self = this;
      return withSpan(
        {
          name: options.name ?? `${target}::${methodName}`,
          target,
          level: options.level ?? "debug",
          // A getter: withSpan reads it only after the filter check, so a
          // disabled span never captures its arguments.
          get fields() {
            const fields: Record<string, unknown> = {};
            if (!options.skipAll) {
              args.forEach((value, i) => {
                const name = names[i] ?? `arg${i}`;
                const paths = skip.get(i);
                if (paths === undefined) fields[name] = value;
                else if (paths.length > 0) fields[name] = without(value, paths);
                // an empty list means the whole argument is skipped
              });
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
