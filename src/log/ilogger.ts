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

export type Level = "trace" | "debug" | "info" | "warn" | "error";

/** Numeric order of levels; "off" disables everything. */
export const LEVELS: Readonly<Record<Level | "off", number>> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, off: 5 };

export interface SpanRecord {
  name: string;
  /** Span id (8-byte hex); the request span's id is the request id. */
  id: string;
  fields: Record<string, unknown>;
}

export interface LogRecord {
  /** Epoch milliseconds. */
  time: number;
  level: Level;
  /** Category: a class name, `yerd::...` for yerd itself, or one you choose. */
  target: string;
  message: string;
  fields: Record<string, unknown>;
  /** Open spans, root first. */
  spans: SpanRecord[];
  kind: "event" | "span-enter" | "span-exit";
  /** On span-exit: how long the span ran. */
  durationMs?: number;
  error?: { name: string; message: string; stack?: string };
  /** W3C trace id (16-byte hex) of the request, continued from `traceparent`. */
  traceId?: string;
}

export interface ILogger {
  write(record: LogRecord): void;
  /** Write out anything buffered; called when the app stops. */
  flush?(): void | Promise<void>;
}

/** Fan records out to several sinks. */
export function teeLogger(...sinks: ILogger[]): ILogger {
  return {
    write(record) {
      for (const sink of sinks) sink.write(record);
    },
    async flush() {
      await Promise.all(sinks.map((s) => s.flush?.()));
    },
  };
}

/** DI token for the sink. */
export const ILogger = token<ILogger>("ILogger");
