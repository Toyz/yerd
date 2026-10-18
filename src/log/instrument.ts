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

export interface InstrumentOptions<This = any, Args extends unknown[] = any[]> {
  /** Span name. Default `Class::method`. */
  name?: string;
  /** Level of the span's records. Default "debug". */
  level?: Level;
  /** Category. Default the class name. */
  target?: string;
  /** Parameter names to leave out. */
  skip?: readonly string[];
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

export function instrument<This, Args extends unknown[], R>(options: InstrumentOptions<This, Args> = {}) {
  return function (method: (this: This, ...args: Args) => R, context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => R>) {
    const names = parameterNames(method);
    const skip = new Set(options.skip ?? []);
    const methodName = String(context.name);
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
                if (!skip.has(name)) fields[name] = value;
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
