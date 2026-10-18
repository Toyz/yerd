/**
 * Spans and where records go.
 *
 * The current span lives in an AsyncLocalStorage, so spans nest across
 * `await` with nothing passed around. A request's root span lives on its
 * request context instead, so an ordinary request costs no extra async
 * context; only spans opened inside it (@instrument, log.span) run one.
 *
 * Which sink and filter apply comes from the DI container in scope (each app
 * binds its own at boot), so two apps in one process log independently.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomFillSync } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { currentServices } from "../di/container.js";
import { maybeContext } from "../server/context.js";
import { ConsoleLogger } from "./console.js";
import { LogFilter, defaultFilter } from "./filter.js";
import type { ILogger, Level, LogRecord, SpanRecord } from "./ilogger.js";
import { errorInfo, safeFields, safeValue } from "./serialize.js";

export interface LogBinding {
  sink: ILogger;
  filter: LogFilter;
}

export interface Span {
  readonly name: string;
  readonly target: string;
  readonly id: string;
  readonly traceId: string;
  readonly fields: Record<string, unknown>;
  readonly parent: Span | undefined;
  readonly start: number;
  readonly level: Level;
}

const bindings = new WeakMap<object, LogBinding>();
let latest: LogBinding | undefined;
let fallback: LogBinding | undefined;

/** An app's sink and filter, for code running with its container in scope. */
export function bindLogging(container: object, binding: LogBinding): void {
  bindings.set(container, binding);
  latest = binding;
}

/** The sink and filter for the code running now. */
export function activeBinding(): LogBinding {
  const services = currentServices();
  const bound = services && bindings.get(services.container);
  if (bound) return bound;
  return latest ?? (fallback ??= { sink: new ConsoleLogger(), filter: new LogFilter(defaultFilter()) });
}

const spans = new AsyncLocalStorage<Span>();

/** Where a request's root span is kept: on the Node request object itself. */
export const REQUEST_SPAN = Symbol("yerd.request-span");

export function currentSpan(): Span | undefined {
  const own = spans.getStore();
  if (own) return own;
  const request = (maybeContext() as { req?: Record<symbol, unknown> } | undefined)?.req;
  return request?.[REQUEST_SPAN] as Span | undefined;
}

function* spanNames(span: Span | undefined): Generator<string> {
  for (let s = span; s; s = s.parent) yield s.name;
}

function chain(span: Span | undefined): SpanRecord[] {
  const out: SpanRecord[] = [];
  for (let s = span; s; s = s.parent) out.unshift({ name: s.name, id: s.id, fields: s.fields });
  return out;
}

// Ids come from a pool of random bytes refilled 4 KiB at a time: a crypto
// call per id was the biggest cost of request logging.
const pool = Buffer.alloc(4096);
let poolOffset = pool.length;

function randomHex(bytes: number): string {
  if (poolOffset + bytes > pool.length) {
    randomFillSync(pool);
    poolOffset = 0;
  }
  const hex = pool.toString("hex", poolOffset, poolOffset + bytes);
  poolOffset += bytes;
  return hex;
}

export function newSpanId(): string {
  return randomHex(8);
}

function newTraceId(): string {
  return randomHex(16);
}

export function enabledHere(binding: LogBinding, level: Level, target: string, span: Span | undefined, extraSpan?: string): boolean {
  if (!binding.filter.hasSpanDirectives) return binding.filter.enabled(level, target);
  const names = [...spanNames(span)];
  if (extraSpan) names.push(extraSpan);
  return binding.filter.enabled(level, target, names);
}

/** Build and write one record. Callers have already checked the filter. */
export function emit(
  binding: LogBinding,
  level: Level,
  target: string,
  kind: LogRecord["kind"],
  message: string,
  fields: Record<string, unknown> | undefined,
  span: Span | undefined,
  extra: { durationMs?: number; error?: unknown } = {},
): void {
  const record: LogRecord = {
    time: Date.now(),
    level,
    target,
    message,
    fields: safeFields(fields),
    spans: chain(span),
    kind,
  };
  if (extra.durationMs !== undefined) record.durationMs = extra.durationMs;
  if (extra.error !== undefined) record.error = errorInfo(extra.error);
  let root = span;
  while (root?.parent) root = root.parent;
  if (root) record.traceId = root.traceId;
  try {
    binding.sink.write(record);
  } catch (error) {
    // A broken sink must never break the request it was logging.
    console.error("[yerd] the logger failed:", error);
  }
}

export interface SpanOptions {
  name: string;
  target: string;
  level?: Level;
  fields?: Record<string, unknown>;
  /** Fields for the exit record, from the return value (e.g. `ret`). */
  onReturn?: (value: unknown) => Record<string, unknown> | undefined;
  /** Log a throw at error level (default true). */
  err?: boolean;
}

/**
 * Run `fn` inside a new span: an enter record, the work (sync stays sync),
 * then an exit record with the duration, or an error record if it threw.
 * When the span's level isn't enabled, `fn` just runs.
 */
export function withSpan<T>(options: SpanOptions, fn: () => T): T {
  const binding = activeBinding();
  const level = options.level ?? "info";
  const parent = currentSpan();
  if (!enabledHere(binding, level, options.target, parent, options.name)) return fn();
  const span: Span = {
    name: options.name,
    target: options.target,
    id: newSpanId(),
    traceId: parent ? rootOf(parent).traceId : newTraceId(),
    fields: safeFields(options.fields),
    parent,
    start: performance.now(),
    level,
  };
  emit(binding, level, span.target, "span-enter", span.name, undefined, span);
  const exit = (value: unknown) => {
    emit(binding, level, span.target, "span-exit", span.name, options.onReturn?.(value), span, { durationMs: elapsed(span) });
  };
  const fail = (error: unknown) => {
    if (options.err === false) emit(binding, level, span.target, "span-exit", span.name, undefined, span, { durationMs: elapsed(span) });
    else emit(binding, "error", span.target, "span-exit", span.name, undefined, span, { durationMs: elapsed(span), error });
  };
  let result: T;
  try {
    result = spans.run(span, fn);
  } catch (error) {
    fail(error);
    throw error;
  }
  if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
    return (result as unknown as Promise<unknown>).then(
      (value) => {
        exit(value);
        return value;
      },
      (error: unknown) => {
        fail(error);
        throw error;
      },
    ) as T;
  }
  exit(result);
  return result;
}

function rootOf(span: Span): Span {
  let root = span;
  while (root.parent) root = root.parent;
  return root;
}

function elapsed(span: Span): number {
  return Math.round((performance.now() - span.start) * 100) / 100;
}

// ── the request root span ──

const REQUEST_ID = /^[\w.:@-]{1,128}$/;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/**
 * Open a request's root span, or return undefined when request logging is
 * off (then nothing is generated at all). The id comes from a well-formed
 * `x-request-id`, else is new; the trace id continues `traceparent`.
 */
export function startRequestSpan(binding: LogBinding, req: IncomingMessage, method: string, path: string): Span | undefined {
  if (!binding.filter.enabled("info", "yerd::request")) return undefined;
  const given = req.headers["x-request-id"];
  const id = typeof given === "string" && REQUEST_ID.test(given) ? given : newSpanId();
  const parent = req.headers.traceparent;
  const trace = typeof parent === "string" ? TRACEPARENT.exec(parent) : null;
  return {
    name: "request",
    target: "yerd::request",
    id,
    traceId: trace && trace[1] !== "0".repeat(32) ? trace[1]! : newTraceId(),
    fields: { method, path },
    parent: undefined,
    start: performance.now(),
    level: "info",
  };
}

/** Close the request span: the access log line. 5xx at error, 4xx at warn. */
export function endRequestSpan(binding: LogBinding, span: Span, status: number): void {
  const level: Level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  emit(binding, level, span.target, "span-exit", span.name, { status }, span, { durationMs: elapsed(span) });
}

/** Format a value for a pretty log line. */
export function formatValue(value: unknown): string {
  if (typeof value === "string") return /^[^\s"=]*$/.test(value) && value !== "" ? value : JSON.stringify(value);
  const safe = safeValue(value);
  return typeof safe === "string" ? safe : JSON.stringify(safe);
}
