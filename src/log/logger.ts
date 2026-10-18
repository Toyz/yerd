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
 * await log.span("import-batch", { size: rows.length }, async () => { ... });
 * ```
 *
 * Events logged inside a request carry its span (request id, method, path)
 * and its trace id, whichever service logs them.
 */

import type { Level } from "./ilogger.js";
import { activeBinding, currentSpan, emit, enabledHere, withSpan } from "./span.js";
import { className } from "./instrument.js";

/**
 * A logger for one target (category). Get one with @logger, inject the
 * app's with `@inject(Logger)` (target "app"), or use the exported `log`.
 * Records go to the app's ILogger once its filter allows the level.
 */
export class Logger {
  /** `target` names the category in records and filters; `bound` fields go on every record. */
  constructor(
    readonly target = "app",
    readonly bound: Readonly<Record<string, unknown>> = {},
  ) {}

  /** Whether `level` would be written here (to skip building expensive fields). */
  enabled(level: Level): boolean {
    return enabledHere(activeBinding(), level, this.target, currentSpan());
  }

  /** Write an event at `level`. `error`, when given, is serialized into the record's `error`. */
  log(level: Level, message: string, fields?: Record<string, unknown>, error?: unknown): void {
    const binding = activeBinding();
    const span = currentSpan();
    if (!enabledHere(binding, level, this.target, span)) return;
    const all = Object.keys(this.bound).length > 0 ? { ...this.bound, ...fields } : fields;
    emit(binding, level, this.target, "event", message, all, span, error === undefined ? {} : { error });
  }

  /** Write a trace-level event. */
  trace(message: string, fields?: Record<string, unknown>): void {
    this.log("trace", message, fields);
  }

  /** Write a debug-level event. */
  debug(message: string, fields?: Record<string, unknown>): void {
    this.log("debug", message, fields);
  }

  /** Write an info-level event. */
  info(message: string, fields?: Record<string, unknown>): void {
    this.log("info", message, fields);
  }

  /** Write a warn-level event. */
  warn(message: string, fields?: Record<string, unknown>): void {
    this.log("warn", message, fields);
  }

  /** `log.error("charge failed", { orderId })`, or `log.error(err)` / `log.error("msg", { error: err })` for the stack. */
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

  /** A logger with extra fields on every record. */
  child(fields: Record<string, unknown>): Logger {
    return new Logger(this.target, { ...this.bound, ...fields });
  }

  /** A logger for another target. */
  for(target: string): Logger {
    return new Logger(target, this.bound);
  }

  /** Run `fn` inside a span: enter and exit records, duration, nesting across await. */
  span<T>(name: string, fields: Record<string, unknown>, fn: () => T, level: Level = "info"): T {
    return withSpan({ name, target: this.target, level, fields }, fn);
  }
}

/** The root logger, target "app". */
export const log = new Logger("app");

const CACHED = Symbol("yerd.logger");

function loggerAccessor(explicit: string | undefined) {
  return function <This extends object>(
    _target: ClassAccessorDecoratorTarget<This, Logger>,
    context: ClassAccessorDecoratorContext<This, Logger>,
  ): ClassAccessorDecoratorResult<This, Logger> {
    if (context.static || context.private) throw new TypeError("@logger goes on a public instance accessor");
    return {
      get(this: This): Logger {
        const self = this as This & { [CACHED]?: Logger };
        return (self[CACHED] ??= new Logger(explicit ?? className(this)));
      },
      set() {
        throw new TypeError("@logger fields are read-only");
      },
    };
  };
}

/**
 * A Logger whose target is the owning class's name (like `ILogger<UserRepo>`),
 * or `@logger("billing")` for a category of your own.
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
