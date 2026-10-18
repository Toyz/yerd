/**
 * Long-lived streaming responses: newline-delimited JSON and Server-Sent
 * Events. Both take an async iterable (usually an async generator), send
 * headers immediately, and stop the source when the client goes away: the
 * request's `ctx.signal` aborts and the iterator's `return()` is called.
 * Graceful shutdown ends them the same way.
 *
 * One JavaScript rule to know: `return()` on an async generator that is
 * parked at an `await` waits for that await to settle, so its `finally` only
 * runs once whatever it waits on resolves. A source that waits on something
 * slow (a queue, a timer, a subscription) should pass the request's signal
 * (`@signal accessor stop`) to that wait, as Channels.subscribe does, so
 * a disconnect ends it straight away.
 */

import { HttpError, YerdResponse } from "./response.js";
import { Logger } from "../log/logger.js";
import { maybeContext } from "../server/context.js";

const streamLog = new Logger("yerd::stream");

/** Marks a response as long-lived: headers are sent at once, and shutdown ends it instead of waiting. */
export const LONG_LIVED = "x-yerd-long-lived";

const STREAM_HEADERS = {
  "cache-control": "no-cache, no-transform",
  // nginx and friends buffer responses unless told not to
  "x-accel-buffering": "no",
  [LONG_LIVED]: "1",
};

/** What a client may see when a stream fails partway: HttpError messages if exposed, otherwise a generic one. */
function publicMessage(error: unknown): string {
  if (error instanceof HttpError && error.expose) return error.message;
  // The client left (or the server is shutting down) and the source stopped
  // because of it: that's an ending, not a failure.
  const aborted = (maybeContext() as { signal?: AbortSignal } | undefined)?.signal?.aborted;
  if (aborted || (error instanceof Error && error.name === "AbortError")) streamLog.debug("stream ended by abort", { error });
  else streamLog.error("stream failed", { error });
  return "Internal Server Error";
}

/**
 * Pull from `source`, yielding `heartbeat()` whenever it's quiet for `ms`.
 * Returns the source's items through `onItem`.
 */
async function* withHeartbeat<T>(source: AsyncIterable<T>, ms: number, beat: string, onItem: (item: T) => string): AsyncGenerator<string> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    let pending = iterator.next();
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick =
        ms > 0
          ? new Promise<"tick">((resolve) => {
              timer = setTimeout(() => resolve("tick"), ms);
            })
          : undefined;
      const result = await (tick ? Promise.race([pending, tick]) : pending);
      clearTimeout(timer);
      if (result === "tick") {
        yield beat;
        continue;
      }
      if (result.done) return;
      yield onItem(result.value);
      pending = iterator.next();
    }
  } finally {
    await iterator.return?.();
  }
}

// ── NDJSON ──

/** Options for ndjson(). */
export interface NdjsonOptions {
  /** Write an empty line every N ms while the source is quiet (readers skip blank lines). 0 disables. Default 0. */
  heartbeat?: number;
  /**
   * If the source throws after streaming has started, write one last line
   * `{"error": message}` before closing. Default true; false just closes.
   */
  errorLine?: boolean;
}

async function* ndjsonLines(source: AsyncIterable<unknown>, options: NdjsonOptions): AsyncGenerator<string> {
  try {
    yield* withHeartbeat(source, options.heartbeat ?? 0, "\n", (item) => `${JSON.stringify(item) ?? "null"}\n`);
  } catch (error) {
    if (options.errorLine === false) throw error;
    yield `${JSON.stringify({ error: publicMessage(error) })}\n`;
  }
}

function ndjsonResponse(source: AsyncIterable<unknown>, options: NdjsonOptions = {}): YerdResponse {
  return new YerdResponse(200, { "content-type": "application/x-ndjson; charset=utf-8", ...STREAM_HEADERS }, ndjsonLines(source, options));
}

// ── SSE ──

const EVENT: unique symbol = Symbol.for("yerd.sse.event");

/** The fields of one Server-Sent Event, for event(). */
export interface SseEventInit {
  /** Payload. Strings are sent as-is; anything else as JSON. */
  data?: unknown;
  /** Event name (`addEventListener(name)` on the client). */
  event?: string;
  /** Last-Event-ID for reconnects. */
  id?: string;
  /** Reconnect delay hint for the client, in ms. */
  retry?: number;
  /** A comment line; ignored by EventSource. */
  comment?: string;
}

/** An event built with event(), sent with its fields rather than as plain data. */
export interface SseEvent extends SseEventInit {
  /** Brand that marks an event() result. */
  readonly [EVENT]: true;
}

/** A named or id'd event. Anything else yielded from an SSE stream is sent as plain `data`. */
export function event(init: SseEventInit): SseEvent {
  return { ...init, [EVENT]: true };
}

function isEvent(value: unknown): value is SseEvent {
  return typeof value === "object" && value !== null && (value as SseEvent)[EVENT] === true;
}

/** Event names, ids and comments are single-line fields; a newline would start a new field. */
function field(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

export function formatEvent(item: unknown): string {
  const e: SseEventInit = isEvent(item) ? item : { data: item };
  let out = "";
  if (e.comment !== undefined) out += `: ${field(e.comment)}\n`;
  if (e.event !== undefined) out += `event: ${field(e.event)}\n`;
  if (e.id !== undefined) out += `id: ${field(e.id)}\n`;
  if (e.retry !== undefined && Number.isFinite(e.retry)) out += `retry: ${Math.max(0, Math.floor(e.retry))}\n`;
  if (e.data !== undefined) {
    // undefined and functions have no JSON: null, as JSON.stringify does inside arrays.
    const text = typeof e.data === "string" ? e.data : (JSON.stringify(e.data) ?? "null");
    for (const line of text.split(/\r\n|\r|\n/)) out += `data: ${line}\n`;
  }
  return out + "\n";
}

/** Options for sse(). */
export interface SseOptions {
  /** Send a comment every N ms while the source is quiet, so proxies keep the connection. 0 disables. Default 15000. */
  heartbeat?: number;
  /** Reconnect delay hint sent once at the start, in ms. */
  retry?: number;
  /** If the source throws, send `event: error` with the message before closing. Default true. */
  errorEvent?: boolean;
}

async function* sseEvents(source: AsyncIterable<unknown>, options: SseOptions): AsyncGenerator<string> {
  if (options.retry !== undefined && Number.isFinite(options.retry)) yield `retry: ${Math.max(0, Math.floor(options.retry))}\n\n`;
  try {
    yield* withHeartbeat(source, options.heartbeat ?? 15000, ": ping\n\n", formatEvent);
  } catch (error) {
    if (options.errorEvent === false) throw error;
    yield formatEvent(event({ event: "error", data: { error: publicMessage(error) } }));
  }
}

function sseResponse(source: AsyncIterable<unknown>, options: SseOptions = {}): YerdResponse {
  return new YerdResponse(200, { "content-type": "text/event-stream; charset=utf-8", ...STREAM_HEADERS }, sseEvents(source, options));
}

// ── helper + decorator entry points ──

type StreamMethod = (this: any, ...args: any[]) => AsyncIterable<unknown>;
type StreamDecorator = <M extends StreamMethod>(method: M, context: ClassMethodDecoratorContext) => M;

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function";
}

function isMethodContext(value: unknown): value is ClassMethodDecoratorContext {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "method";
}

function wrapMethod(method: StreamMethod, respond: (source: AsyncIterable<unknown>) => YerdResponse): StreamMethod {
  return function (this: unknown, ...args: unknown[]) {
    return respond(method.apply(this, args)) as unknown as AsyncIterable<unknown>;
  };
}

/**
 * Newline-delimited JSON (`application/x-ndjson`), one JSON value per line.
 *
 * ```ts
 * return ndjson(source);                                    // respond with a stream
 * @get @ndjson async *rows() { yield { id: 1 }; }             // decorate a generator method
 * @get @ndjson({ heartbeat: 10_000 }) async *feed() { ... }   // ...with options
 * ```
 */
export function ndjson(source: AsyncIterable<unknown>, options?: NdjsonOptions): YerdResponse;
export function ndjson<M extends StreamMethod>(method: M, context: ClassMethodDecoratorContext): M;
export function ndjson(options?: NdjsonOptions): StreamDecorator;
export function ndjson(a?: unknown, b?: unknown): unknown {
  if (isAsyncIterable(a)) return ndjsonResponse(a, b as NdjsonOptions | undefined);
  if (typeof a === "function" && isMethodContext(b)) return wrapMethod(a as StreamMethod, (s) => ndjsonResponse(s));
  return (method: StreamMethod) => wrapMethod(method, (s) => ndjsonResponse(s, a as NdjsonOptions | undefined));
}

/**
 * Server-Sent Events. Same three forms as ndjson(). Yield plain values for
 * `data`, or `event({ event, id, data })` for named events.
 */
export function sse(source: AsyncIterable<unknown>, options?: SseOptions): YerdResponse;
export function sse<M extends StreamMethod>(method: M, context: ClassMethodDecoratorContext): M;
export function sse(options?: SseOptions): StreamDecorator;
export function sse(a?: unknown, b?: unknown): unknown {
  if (isAsyncIterable(a)) return sseResponse(a, b as SseOptions | undefined);
  if (typeof a === "function" && isMethodContext(b)) return wrapMethod(a as StreamMethod, (s) => sseResponse(s));
  return (method: StreamMethod) => wrapMethod(method, (s) => sseResponse(s, a as SseOptions | undefined));
}
