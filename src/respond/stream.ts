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
import { isAsyncIterable, isDecoratorContext } from "../decorators/util.js";

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

/** What a heartbeat function is told about the beat it's making. */
export interface HeartbeatInfo {
  /** 1 for the first beat since the stream started, then 2, 3... */
  count: number;
  /** How long the stream has been quiet (since the last item, or the start), in ms. */
  idleMs: number;
  /** How long the stream has been open, in ms. */
  openMs: number;
}

/**
 * Keep a quiet stream alive. A number is how often (ms; 0 is off), sending
 * the default beat (a blank NDJSON line, an SSE comment). An object sets what
 * to send too: a value, or a function that makes one per beat (return
 * undefined for the default). It's written like any item of the stream, so
 * for SSE `event({ event: "ping" })` is a named event and a plain value is a
 * message.
 *
 * ```ts
 * @get @sse({ heartbeat: { every: 20_000, send: ({ count }) => event({ event: "ping", data: { count } }) } }) feed() { ... }
 * return ndjson(rows, { heartbeat: { every: 10_000, send: { type: "keepalive" } } });
 * ```
 */
export type Heartbeat =
  | number
  | {
      /** How often, while the stream is quiet, in ms. */
      every: number;
      /** What to send: a value, or a function making one per beat (undefined: the default beat). */
      send?: ((info: HeartbeatInfo) => unknown) | string | number | boolean | null | object;
    };

/** A heartbeat option as an interval and a function producing each beat's text. */
function beating(option: Heartbeat | undefined, fallback: number, plain: string, format: (value: unknown) => string): { ms: number; beat: (info: HeartbeatInfo) => string } {
  if (option === undefined || typeof option === "number") {
    const ms = option ?? fallback;
    if (!Number.isFinite(ms) || ms < 0) throw new TypeError(`heartbeat must be a number of ms (0 is off), got ${ms}`);
    return { ms, beat: () => plain };
  }
  const { every, send } = option;
  if (!Number.isFinite(every) || every < 0) throw new TypeError(`heartbeat.every must be a number of ms (0 is off), got ${every}`);
  if (send === undefined) return { ms: every, beat: () => plain };
  return {
    ms: every,
    beat: (info) => {
      const value = typeof send === "function" ? (send as (info: HeartbeatInfo) => unknown)(info) : send;
      return value === undefined ? plain : format(value);
    },
  };
}

/**
 * Pull from `source`, yielding a heartbeat whenever it's quiet for `ms`.
 * Returns the source's items through `onItem`.
 */
async function* withHeartbeat<T>(source: AsyncIterable<T>, ms: number, beat: (info: HeartbeatInfo) => string, onItem: (item: T) => string): AsyncGenerator<string> {
  const iterator = source[Symbol.asyncIterator]();
  const opened = Date.now();
  let lastItem = opened;
  let count = 0;
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
        const now = Date.now();
        yield beat({ count: ++count, idleMs: now - lastItem, openMs: now - opened });
        continue;
      }
      if (result.done) return;
      lastItem = Date.now();
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
  /**
   * Keep the stream alive while the source is quiet. A number of ms writes an
   * empty line that often (readers skip blank lines); `{ every, send }`
   * writes `send` (a value, or a function per beat) as a JSON line instead.
   * 0 disables. Default 0.
   *
   * ```ts
   * @get @ndjson({ heartbeat: 15_000 }) feed() { return this.channels.subscribe(orders, this.stop); }
   * @get @ndjson({ heartbeat: { every: 10_000, send: ({ idleMs }) => ({ type: "ping", idleMs }) } }) jobs() { ... }
   * ```
   */
  heartbeat?: Heartbeat;
  /**
   * If the source throws after streaming has started, write one last line
   * `{"error": message}` before closing. Default true; false just closes.
   *
   * ```ts
   * return ndjson(rows, { errorLine: false }); // the client sees a cut-off stream, no error line
   * ```
   */
  errorLine?: boolean;
}

async function* ndjsonLines(source: AsyncIterable<unknown>, options: NdjsonOptions): AsyncGenerator<string> {
  try {
    const line = (item: unknown) => `${JSON.stringify(item) ?? "null"}\n`;
    const { ms, beat } = beating(options.heartbeat, 0, "\n", line);
    yield* withHeartbeat(source, ms, beat, line);
  } catch (error) {
    if (options.errorLine === false) throw error;
    yield `${JSON.stringify({ error: publicMessage(error) })}\n`;
  }
}

function ndjsonResponse(source: AsyncIterable<unknown>, options: NdjsonOptions = {}): YerdResponse {
  // Checked here, where the mistake is: inside the stream it would surface after the headers went out.
  beating(options.heartbeat, 0, "", String);
  return new YerdResponse(200, { "content-type": "application/x-ndjson; charset=utf-8", ...STREAM_HEADERS }, ndjsonLines(source, options));
}

// ── SSE ──

const EVENT: unique symbol = Symbol.for("yerd.sse.event");

/**
 * The fields of one Server-Sent Event, for event(). Name the type when a
 * helper builds events for several streams.
 *
 * ```ts
 * export function progress(done: number, total: number): SseEventInit {
 *   return { event: "progress", data: { done, total } };
 * }
 *
 * yield event(progress(1, 3));
 * ```
 */
export interface SseEventInit {
  /**
   * Payload. Strings are sent as-is; anything else as JSON. Multi-line
   * strings become several `data:` lines, which EventSource joins back.
   *
   * ```ts
   * yield event({ data: { online: 3 } }); // data: {"online":3}
   * ```
   */
  data?: unknown;
  /**
   * Event name (`addEventListener(name)` on the client). Without one the
   * client's `onmessage` gets it.
   *
   * ```ts
   * yield event({ event: "user", data: { name: "ada" } }); // source.addEventListener("user", ...)
   * ```
   */
  event?: string;
  /**
   * Last-Event-ID for reconnects: the browser sends the last one it saw in a
   * `Last-Event-ID` header when it reconnects, so the stream can resume.
   *
   * ```ts
   * yield event({ event: "done", id: "3", data: "finished" });
   * ```
   */
  id?: string;
  /**
   * Reconnect delay hint for the client, in ms.
   *
   * ```ts
   * yield event({ retry: 10_000 });
   * ```
   */
  retry?: number;
  /**
   * A comment line; ignored by EventSource. Useful for debugging with curl.
   *
   * ```ts
   * yield event({ comment: "cache warmed" });
   * ```
   */
  comment?: string;
}

/** An event built with event(), sent with its fields rather than as plain data. */
export interface SseEvent extends SseEventInit {
  /** Brand that marks an event() result. */
  readonly [EVENT]: true;
}

/**
 * A named or id'd event. Anything else yielded from an SSE stream is sent as
 * plain `data`.
 *
 * ```ts
 * @route("/events")
 * export class Events {
 *   @get @sse async *feed() {
 *     yield "hello";                                                  // data: hello
 *     yield event({ event: "user", id: "7", data: { name: "ada" } }); // event: user, id: 7
 *   }
 * }
 * ```
 */
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
  /**
   * Keep the connection alive while the source is quiet, so proxies don't
   * drop it. A number of ms sends a comment (`: ping`) that often;
   * `{ every, send }` sends `send` instead, written like any item: `event()`
   * for a named event the client can listen for, a plain value as a message.
   * 0 disables. Default 15000.
   *
   * ```ts
   * @get @sse({ heartbeat: 30_000 }) feed() { return this.channels.subscribe(news, this.stop); }
   * @get @sse({ heartbeat: { every: 20_000, send: ({ count }) => event({ event: "ping", data: { count } }) } }) live() { ... }
   * ```
   */
  heartbeat?: Heartbeat;
  /**
   * Reconnect delay hint sent once at the start, in ms.
   *
   * ```ts
   * @get @sse({ retry: 5_000 }) async *ticks() { yield "tick"; }
   * ```
   */
  retry?: number;
  /**
   * If the source throws, send `event: error` with the message before closing. Default true.
   *
   * ```ts
   * return sse(updates(this.stop), { errorEvent: false }); // just close on failure
   * ```
   */
  errorEvent?: boolean;
}

async function* sseEvents(source: AsyncIterable<unknown>, options: SseOptions): AsyncGenerator<string> {
  if (options.retry !== undefined && Number.isFinite(options.retry)) yield `retry: ${Math.max(0, Math.floor(options.retry))}\n\n`;
  try {
    const { ms, beat } = beating(options.heartbeat, 15000, ": ping\n\n", formatEvent);
    yield* withHeartbeat(source, ms, beat, formatEvent);
  } catch (error) {
    if (options.errorEvent === false) throw error;
    yield formatEvent(event({ event: "error", data: { error: publicMessage(error) } }));
  }
}

function sseResponse(source: AsyncIterable<unknown>, options: SseOptions = {}): YerdResponse {
  beating(options.heartbeat, 15000, "", String);
  return new YerdResponse(200, { "content-type": "text/event-stream; charset=utf-8", ...STREAM_HEADERS }, sseEvents(source, options));
}

// ── helper + decorator entry points ──

type StreamMethod = (this: any, ...args: any[]) => AsyncIterable<unknown>;
type StreamDecorator = <M extends StreamMethod>(method: M, context: ClassMethodDecoratorContext) => M;


function wrapMethod(method: StreamMethod, respond: (source: AsyncIterable<unknown>) => YerdResponse): StreamMethod {
  return function (this: unknown, ...args: unknown[]) {
    return respond(method.apply(this, args)) as unknown as AsyncIterable<unknown>;
  };
}

/**
 * Newline-delimited JSON (`application/x-ndjson`), one JSON value per line.
 *
 * ```ts
 * return ndjson(source);                                          // respond with a stream
 * @get @ndjson async *rows() { yield { id: 1 }; }                   // decorate a generator method
 * @get @ndjson({ heartbeat: 10_000 }) feed() { return this.channels.subscribe(orders, this.stop); } // ...with options
 * ```
 */
export function ndjson(source: AsyncIterable<unknown>, options?: NdjsonOptions): YerdResponse;
export function ndjson<M extends StreamMethod>(method: M, context: ClassMethodDecoratorContext): M;
export function ndjson(options?: NdjsonOptions): StreamDecorator;
export function ndjson(a?: unknown, b?: unknown): unknown {
  if (isAsyncIterable(a)) return ndjsonResponse(a, b as NdjsonOptions | undefined);
  if (typeof a === "function" && isDecoratorContext(b, "method")) return wrapMethod(a as StreamMethod, (s) => ndjsonResponse(s));
  return (method: StreamMethod) => wrapMethod(method, (s) => ndjsonResponse(s, a as NdjsonOptions | undefined));
}

/**
 * Server-Sent Events (`text/event-stream`, read in the browser with
 * EventSource). Same three forms as ndjson(): decorate a generator method,
 * decorate with options, or return `sse(source, options)`. Yield plain values
 * for `data`, or `event({ event, id, data })` for named events. Pass the
 * request's `@signal` to anything the source waits on, so a disconnect ends
 * it straight away.
 *
 * ```ts
 * @route("/news/events")
 * export class NewsEvents {
 *   @inject(Channels) accessor channels!: Channels;
 *   @signal accessor stop!: AbortSignal;
 *
 *   @get feed() {
 *     return sse(this.channels.subscribe(news, this.stop), { retry: 5_000 });
 *   }
 * }
 * ```
 */
export function sse(source: AsyncIterable<unknown>, options?: SseOptions): YerdResponse;
export function sse<M extends StreamMethod>(method: M, context: ClassMethodDecoratorContext): M;
export function sse(options?: SseOptions): StreamDecorator;
export function sse(a?: unknown, b?: unknown): unknown {
  if (isAsyncIterable(a)) return sseResponse(a, b as SseOptions | undefined);
  if (typeof a === "function" && isDecoratorContext(b, "method")) return wrapMethod(a as StreamMethod, (s) => sseResponse(s));
  return (method: StreamMethod) => wrapMethod(method, (s) => sseResponse(s, a as SseOptions | undefined));
}
