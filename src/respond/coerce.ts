/**
 * The "return anything" table. Handlers return whatever they like; this turns
 * it into a status, headers and a body.
 */

import { isYerdNode, jsx, type Child, type Component } from "../jsx/jsx-runtime.js";
import { applyLayouts, type LayoutProps, type PageMeta } from "../decorators/route.js";
import { renderToStream } from "../render/render.js";
import { isBare, YerdResponse, type HeaderInit } from "./response.js";
import { choose, expandType, isNegotiated, type Negotiated } from "./negotiate.js";

export type Body = null | string | Uint8Array | AsyncIterable<string | Uint8Array>;

/**
 * A response as the pipeline carries it, before it's written: what
 * middleware gets from `next()` and returns.
 *
 * ```ts
 * const poweredBy: Middleware = async (ctx, next) => {
 *   const out: Outgoing = await next();
 *   return { ...out, headers: { ...(out.headers as Record<string, string>), "x-powered-by": "yerd" } };
 * };
 * ```
 */
export interface Outgoing {
  status: number;
  headers: HeaderInit;
  body: Body;
  /** Set-Cookie values (several are allowed, so they don't fit in `headers`). */
  cookies?: string[];
  /** The handler chose this status (res() or a number), so defaults like @status leave it alone. */
  explicitStatus?: boolean;
}

export interface CoerceOptions {
  /** Layouts to wrap JSX in, outermost first. */
  layouts: readonly Component<LayoutProps>[];
  /** Passed to every layout. The same object for the whole request, so setMeta() calls show up. */
  meta?: PageMeta;
  /** How <Dynamic> parts render (see RenderOptions.dynamic). */
  dynamic?: "fallback" | "only";
  /** The request's Accept header, for picking a negotiate() variant. */
  accept?: string;
}

const HTML = "text/html; charset=utf-8";
const TEXT = "text/plain; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";
const BYTES = "application/octet-stream";

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function";
}

function isPlainData(value: unknown): boolean {
  if (typeof value === "boolean" || Array.isArray(value)) return true;
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) return true;
  // Things that say how they serialize (Date, URL, anything with toJSON).
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return true;
  // Instances of your own classes (a validated DTO, a domain object) are their
  // own enumerable fields. Built-ins whose data lives in internal slots would
  // serialize as {} and are refused instead.
  return !NOT_JSON.some((type) => value instanceof type);
}

const NOT_JSON: Function[] = [
  Map, Set, WeakMap, WeakSet, Promise, RegExp, Error, ArrayBuffer, DataView,
  // Web platform objects, all "{}" through JSON.stringify.
  Response, Request, Headers, Blob, FormData, URLSearchParams, WeakRef,
];

function wrapInLayouts(node: Child, layouts: readonly Component<LayoutProps>[], meta: PageMeta): Child {
  let wrapped = node;
  for (let i = layouts.length - 1; i >= 0; i--) wrapped = jsx(layouts[i]!, { children: wrapped, meta });
  return wrapped;
}

async function* streamChunks(source: AsyncIterable<unknown>): AsyncGenerator<string | Uint8Array> {
  for await (const chunk of source) {
    if (typeof chunk === "string" || chunk instanceof Uint8Array) yield chunk;
    else if (chunk !== null && chunk !== undefined) yield String(chunk);
  }
}

/**
 * Run the negotiate() variant the Accept header picks and coerce its result
 * as that type: a string from the json variant is JSON, a string from the
 * csv one is text/csv. Explicit responses (res(), redirect(), a status
 * number) say what they are themselves and are left alone.
 */
async function coerceNegotiated(value: Negotiated, options: CoerceOptions): Promise<Outgoing> {
  const keys = Object.keys(value.variants);
  // With a default (the first key), choose() always picks something.
  const chosen = choose(keys.map((k) => [expandType(k)]), options.accept, true);
  const key = chosen === "default" || chosen === undefined ? keys[0]! : keys[chosen]!;
  const type = expandType(key);
  const result = await (value.variants as Record<string, () => unknown>)[key]!();
  const out = await coerce(result, options);
  const explicit = result instanceof YerdResponse || typeof result === "number";
  if (!explicit && type === "application/json") {
    // Strings and nulls are JSON here too, not text or 204.
    if (!out.headers["content-type"]?.startsWith("application/json")) {
      out.body = JSON.stringify(result ?? null);
      out.headers["content-type"] = JSON_TYPE;
      if (out.status === 204) out.status = 200;
    }
  } else if (!explicit && type !== "text/html" && (typeof out.body === "string" || out.body instanceof Uint8Array)) {
    out.headers["content-type"] = type.startsWith("text/") ? `${type}; charset=utf-8` : type;
  }
  const vary = out.headers.vary;
  if (!vary) out.headers.vary = "accept";
  else if (!vary.toLowerCase().split(/\s*,\s*/).includes("accept")) out.headers.vary = `${vary}, accept`;
  return out;
}

export async function coerce(value: unknown, options: CoerceOptions): Promise<Outgoing> {
  if (value instanceof Promise) value = await value;

  if (isNegotiated(value)) return coerceNegotiated(value, options);

  if (value instanceof YerdResponse) {
    const inner = value.body === null || value.body === undefined
      ? { status: value.status, headers: {}, body: null }
      : await coerce(value.body, value.layout ? { ...options, layouts: applyLayouts(options.layouts, value.layout) } : options);
    const out: Outgoing = { status: value.status, headers: { ...inner.headers, ...value.headers }, body: inner.body, explicitStatus: true };
    if (inner.cookies || value.cookies) out.cookies = [...(inner.cookies ?? []), ...(value.cookies ?? [])];
    return out;
  }

  if (isBare(value)) {
    return { status: 200, headers: { "content-type": HTML }, body: renderToStream(value.node, { dynamic: options.dynamic }) };
  }

  if (isYerdNode(value)) {
    const page = wrapInLayouts(value, options.layouts, options.meta ?? {});
    return {
      status: 200,
      headers: options.dynamic === "only" ? { "content-type": HTML, "cache-control": "no-store" } : { "content-type": HTML },
      body: renderToStream(page, { document: true, dynamic: options.dynamic }),
    };
  }

  if (typeof value === "string") return { status: 200, headers: { "content-type": TEXT }, body: value };

  if (typeof value === "number") {
    // 1xx are interim responses: sent as the answer, the client would wait for a final one.
    if (!Number.isInteger(value) || value < 200 || value > 599) {
      throw new TypeError(`A handler returned ${value}, which isn't an HTTP status code`);
    }
    return { status: value, headers: {}, body: null, explicitStatus: true };
  }

  if (value === undefined || value === null) return { status: 204, headers: {}, body: null };

  if (value instanceof Uint8Array) return { status: 200, headers: { "content-type": BYTES }, body: value };

  if (isAsyncIterable(value)) {
    return { status: 200, headers: { "content-type": TEXT }, body: streamChunks(value) };
  }

  if (isPlainData(value)) {
    return { status: 200, headers: { "content-type": JSON_TYPE }, body: JSON.stringify(value) };
  }

  const what = value instanceof Map || value instanceof Set
    ? `a ${value.constructor.name} (JSON can't represent it; convert it, e.g. Object.fromEntries(map) or [...set])`
    : value instanceof Error
      ? "an Error (throw it, or throw an HttpError, instead of returning it)"
      : value instanceof Response
        ? "a fetch Response (return its body, e.g. res(await response.text(), { status: response.status }))"
        : Object.prototype.toString.call(value);
  throw new TypeError(`A handler returned ${what}, which yerd doesn't know how to send as a response`);
}
