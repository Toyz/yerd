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
import { requestIdFrom } from "../server/http.js";
import { ConsoleLogger } from "./console.js";
import { LogFilter, defaultFilter } from "./filter.js";
import type { ILogger, Level, LogRecord, SpanRecord } from "./ilogger.js";
import { prunePaths } from "./paths.js";
import { errorInfo, safeFields } from "./serialize.js";

export interface LogBinding {
  sink: ILogger;
  filter: LogFilter;
  /** Field paths masked in every record (logging({ redact })), compiled. */
  redact?: string[][];
}

/** A record's fields, serialized safely, with the app's redact paths masked. */
function recordFields(binding: LogBinding, fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!binding.redact?.length || !fields) return safeFields(fields);
  // Redact before serializing: paths name the fields as written (form.email),
  // not as the serializer wraps class instances ({"CheckoutForm": {...}}).
  try {
    return safeFields(prunePaths(fields, binding.redact, "[redacted]") as Record<string, unknown>);
  } catch {
    // Something on the way threw (a getter): redact what the serializer made of it.
    return prunePaths(safeFields(fields), binding.redact, "[redacted]") as Record<string, unknown>;
  }
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
/** Containers ever bound. While it's one, every lookup would find `latest`. */
let boundContainers = 0;

/** An app's sink and filter, for code running with its container in scope. */
export function bindLogging(container: object, binding: LogBinding): void {
  if (!bindings.has(container)) boundContainers++;
  bindings.set(container, binding);
  latest = binding;
}

/** The sink and filter for the code running now. */
export function activeBinding(): LogBinding {
  // One app in the process (the usual case): its binding, wherever the code
  // runs, so skip the async-context lookups that find the current container.
  if (boundContainers === 1) return latest!;
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

/**
 * Whether a record at `level` for `target` is written here (`extraSpan`: in
 * a span about to open). The current span is looked up only when span
 * directives make it matter, so a disabled call skips that async-context read.
 */
export function enabledHere(binding: LogBinding, level: Level, target: string, extraSpan?: string): boolean {
  const filter = binding.filter;
  if (!filter.hasSpanDirectives) return filter.enabled(level, target);
  const names = [...spanNames(currentSpan())];
  if (extraSpan) names.push(extraSpan);
  return filter.enabled(level, target, names);
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
    fields: recordFields(binding, fields),
    spans: chain(span),
    kind,
  };
  if (extra.durationMs !== undefined) record.durationMs = extra.durationMs;
  if (extra.error !== undefined) record.error = errorInfo(extra.error);
  if (span) record.traceId = rootOf(span).traceId;
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
  /** The span's fields, or a function building them, called only once the span is known to be enabled. */
  fields?: Record<string, unknown> | (() => Record<string, unknown>);
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
  if (!enabledHere(binding, level, options.target, options.name)) return fn();
  const parent = currentSpan();
  const fields = options.fields;
  const span: Span = {
    name: options.name,
    target: options.target,
    id: newSpanId(),
    traceId: parent ? rootOf(parent).traceId : newTraceId(),
    fields: recordFields(binding, typeof fields === "function" ? fields() : fields),
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

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/**
 * Open a request's root span, or return undefined when request logging is
 * off (then nothing is generated at all). The id comes from a well-formed
 * `x-request-id`, else is new; the trace id continues `traceparent`.
 */
export function startRequestSpan(binding: LogBinding, req: IncomingMessage, method: string, path: string): Span | undefined {
  if (!binding.filter.enabled("info", "yerd::request")) return undefined;
  const id = requestIdFrom(req) ?? newSpanId();
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
