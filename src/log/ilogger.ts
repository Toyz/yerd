/**
 * The logging sink: where records go. One method, deliberately. Code never
 * calls it directly; it talks to the Logger facade (logger.ts), which builds
 * records and hands them to whichever ILogger the app has.
 *
 * Register one to send logs elsewhere; register none and yerd uses its
 * ConsoleLogger.
 *
 * ```ts
 * @service({ provides: ILogger })
 * class HttpLogger implements ILogger {
 *   write(record: LogRecord) { ... }
 * }
 * ```
 */

import { token } from "../di/container.js";

/** A log level, least to most severe. */
export type Level = "trace" | "debug" | "info" | "warn" | "error";

/** Numeric order of levels; "off" disables everything. */
export const LEVELS: Readonly<Record<Level | "off", number>> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, off: 5 };

/** An open span as it appears on a record. */
export interface SpanRecord {
  /** The span's name, e.g. "request" or "checkout". */
  name: string;
  /** Span id (8-byte hex); the request span's id is the request id. */
  id: string;
  /** Fields given when the span was opened; they apply to everything logged inside it. */
  fields: Record<string, unknown>;
}

/** One log record, as handed to an ILogger sink. */
export interface LogRecord {
  /** Epoch milliseconds. */
  time: number;
  /** Severity. */
  level: Level;
  /** Category: a class name, `yerd::...` for yerd itself, or one you choose. */
  target: string;
  /** The message text. */
  message: string;
  /** Structured fields: the logger's bound fields plus the call's. log.error() moves an Error under `error` to the `error` property. */
  fields: Record<string, unknown>;
  /** Open spans, root first. */
  spans: SpanRecord[];
  /** A plain log call, or a span opening or closing. */
  kind: "event" | "span-enter" | "span-exit";
  /** On span-exit: how long the span ran. */
  durationMs?: number;
  /** A serialized Error, when one was logged. */
  error?: { name: string; message: string; stack?: string };
  /** W3C trace id (16-byte hex) of the request, continued from `traceparent`. */
  traceId?: string;
}

export interface ILogger {
  /** Take one record. Called synchronously on the logging path, so buffer anything slow. */
  write(record: LogRecord): void;
  /** Write out anything buffered; called when the app stops. */
  flush?(): void | Promise<void>;
}

/**
 * Fan records out to several sinks. A sink that throws doesn't stop the
 * others: every sink gets the record (or is flushed), then the first error
 * is rethrown for the caller to report.
 */
export function teeLogger(...sinks: ILogger[]): ILogger {
  return {
    write(record) {
      const errors: unknown[] = [];
      for (const sink of sinks) {
        try {
          sink.write(record);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw errors[0];
    },
    async flush() {
      const results = await Promise.allSettled(sinks.map(async (s) => s.flush?.()));
      const failed = results.find((r) => r.status === "rejected");
      if (failed) throw failed.reason;
    },
  };
}

/** DI token for the sink. */
export const ILogger = token<ILogger>("ILogger");
