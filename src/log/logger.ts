/**
 * The Logger facade: what code calls. It builds records and hands them to
 * the app's ILogger (or the built-in ConsoleLogger), only after the filter
 * says the level is wanted, so a disabled call costs one cached lookup.
 *
 * ```ts
 * @service
 * class UserRepo {
 *   @logger accessor log!: Logger;          // target "UserRepo"
 *
 *   find(id: number) {
 *     this.log.debug("looking up", { id });
 *   }
 * }
 *
 * await log.span("import-batch", { size: rows.length }, () => importRows(rows));
 * ```
 *
 * Events logged inside a request carry its span (request id, method, path)
 * and its trace id, whichever service logs them.
 */

import type { Level } from "./ilogger.js";
import { activeBinding, currentSpan, emit, enabledHere, withSpan } from "./span.js";
import { className } from "./instrument.js";
import { assertPublicInstance } from "../decorators/util.js";

/**
 * A logger for one target (category). Get one with @logger, inject the
 * app's with `@inject(Logger)` (target "app"), or use the exported `log`.
 * Records go to the app's ILogger once its filter allows the level.
 *
 * ```ts
 * @service
 * export class Billing {
 *   @logger accessor log!: Logger; // target "Billing"
 *
 *   async charge(order: Order) {
 *     const orderLog = this.log.child({ orderId: order.id });
 *     orderLog.info("charging", { total: order.total });
 *     await this.log.span("stripe", { amount: order.total }, () => this.stripe.charge(order));
 *   }
 * }
 * ```
 */
export class Logger {
  /**
   * `target` names the category in records and filters; `bound` fields go on every record.
   * @logger and child() are usually handier than `new`.
   *
   * ```ts
   * const billing = new Logger("billing", { region: "eu" });
   * ```
   */
  constructor(
    readonly target = "app",
    readonly bound: Readonly<Record<string, unknown>> = {},
  ) {}

  /**
   * Whether `level` would be written here (to skip building expensive fields).
   *
   * ```ts
   * if (this.log.enabled("debug")) this.log.debug("cart", { lines: summarize(cart) });
   * ```
   */
  enabled(level: Level): boolean {
    return enabledHere(activeBinding(), level, this.target, currentSpan());
  }

  /**
   * Write an event at `level`. `error`, when given, is serialized into the record's `error`.
   * For a level chosen at runtime; otherwise use the named methods.
   *
   * ```ts
   * this.log.log(status >= 500 ? "error" : "info", "upstream answered", { status });
   * ```
   */
  log(level: Level, message: string, fields?: Record<string, unknown>, error?: unknown): void {
    const binding = activeBinding();
    const span = currentSpan();
    if (!enabledHere(binding, level, this.target, span)) return;
    const all = Object.keys(this.bound).length > 0 ? { ...this.bound, ...fields } : fields;
    emit(binding, level, this.target, "event", message, all, span, error === undefined ? {} : { error });
  }

  /**
   * Write a trace-level event: the finest detail, usually off.
   *
   * ```ts
   * this.log.trace("raw order", { order });
   * ```
   */
  trace(message: string, fields?: Record<string, unknown>): void {
    this.log("trace", message, fields);
  }

  /**
   * Write a debug-level event.
   *
   * ```ts
   * this.log.debug("cache miss", { key });
   * ```
   */
  debug(message: string, fields?: Record<string, unknown>): void {
    this.log("debug", message, fields);
  }

  /**
   * Write an info-level event.
   *
   * ```ts
   * log.info("server starting", { port: 3000 });
   * ```
   */
  info(message: string, fields?: Record<string, unknown>): void {
    this.log("info", message, fields);
  }

  /**
   * Write a warn-level event.
   *
   * ```ts
   * this.log.warn("retrying", { attempt: 2 });
   * ```
   */
  warn(message: string, fields?: Record<string, unknown>): void {
    this.log("warn", message, fields);
  }

  /**
   * Write an error-level event. An Error passed directly, or under the `error`
   * field, is logged with its stack.
   *
   * ```ts
   * try {
   *   await this.stripe.charge(order);
   * } catch (error) {
   *   this.log.error("charge failed", { orderId: order.id, error });
   * }
   * ```
   */
  error(message: string | unknown, fields?: Record<string, unknown>): void {
    if (typeof message !== "string") {
      this.log("error", message instanceof Error ? message.message : String(message), fields, message);
      return;
    }
    const error = fields?.error;
    if (error instanceof Error) {
      const { error: _, ...rest } = fields!;
      this.log("error", message, rest, error);
    } else this.log("error", message, fields);
  }

  /**
   * A logger with extra fields on every record (same target).
   *
   * ```ts
   * const orderLog = this.log.child({ orderId: order.id });
   * orderLog.info("charging"); // orderId=... on this and every later record
   * ```
   */
  child(fields: Record<string, unknown>): Logger {
    return new Logger(this.target, { ...this.bound, ...fields });
  }

  /**
   * A logger for another target, keeping the bound fields.
   *
   * ```ts
   * this.log.for("billing.audit").info("charged", { orderId: order.id });
   * ```
   */
  for(target: string): Logger {
    return new Logger(target, this.bound);
  }

  /**
   * Run `fn` inside a span: enter and exit records, duration, nesting across
   * await. Returns what `fn` returns (sync stays sync); a throw is logged at
   * error and rethrown.
   *
   * ```ts
   * const receipt = await this.log.span("stripe", { amount: order.total }, () => this.stripe.charge(order));
   * ```
   */
  span<T>(name: string, fields: Record<string, unknown>, fn: () => T, level: Level = "info"): T {
    return withSpan({ name, target: this.target, level, fields }, fn);
  }
}

/**
 * The root logger, target "app". For scripts, module-level code and anywhere
 * a class logger would be overkill.
 *
 * ```ts
 * log.info("server starting", { port: 3000 });
 * log.error("charge failed", { orderId: 42, error: new Error("card declined") });
 * ```
 */
export const log = new Logger("app");

function loggerAccessor(explicit: string | undefined) {
  return function <This extends object>(
    _target: ClassAccessorDecoratorTarget<This, Logger>,
    context: ClassAccessorDecoratorContext<This, Logger>,
  ): ClassAccessorDecoratorResult<This, Logger> {
    assertPublicInstance(context, "@logger");
    // One cache per accessor: a class may have several loggers under different names.
    const cached = Symbol("yerd.logger");
    return {
      get(this: This): Logger {
        const self = this as This & { [cached]?: Logger };
        return (self[cached] ??= new Logger(explicit ?? className(this)));
      },
      set() {
        throw new TypeError("@logger fields are read-only");
      },
    };
  };
}

/**
 * A Logger whose target is the owning class's name (like `ILogger<UserRepo>`),
 * or `@logger("billing")` for a category of your own. Works in any class and
 * any lifetime; records still carry the current request's span.
 *
 * ```ts
 * @service
 * export class UserRepo {
 *   @logger accessor log!: Logger; // target "UserRepo"
 *   @logger("audit") accessor audit!: Logger;
 *
 *   remove(id: number) {
 *     this.log.debug("removing", { id });
 *     this.audit.info("user removed", { id });
 *   }
 * }
 * ```
 */
export function logger<This extends object>(
  target: ClassAccessorDecoratorTarget<This, Logger>,
  context: ClassAccessorDecoratorContext<This, Logger>,
): ClassAccessorDecoratorResult<This, Logger>;
export function logger(name: string): ReturnType<typeof loggerAccessor>;
export function logger(...args: unknown[]): unknown {
  if (typeof args[0] === "string") return loggerAccessor(args[0]);
  return loggerAccessor(undefined)(args[0] as never, args[1] as never);
}
