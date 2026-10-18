import type { Child, Component } from "../jsx/jsx-runtime.js";
import type { LayoutProps, LayoutSpec } from "../decorators/route.js";
import { serializeCookie, type CookieOptions } from "../server/cookies.js";

export type HeaderInit = Record<string, string>;

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Throw a TypeError for a header Node would refuse: a name that isn't an
 * HTTP token, or a value with a line break, NUL, another control character
 * or a character above U+00FF. Node only refuses them once the response is
 * being written, past the point where @catches, onError or the error page
 * can answer; checked here, the mistake is an ordinary error.
 */
export function checkHeader(name: string, value: string, where = `Header ${name}`): void {
  if (!TOKEN.test(name)) throw new TypeError(`${JSON.stringify(name)} isn't a valid header name`);
  const text = String(value);
  if (/[\r\n\0]/.test(text)) throw new TypeError(`${where} contains a line break or NUL`);
  if (/[^\t\x20-\x7e\x80-\xff]/.test(text)) throw new TypeError(`${where} contains a control character or a character above U+00FF`);
}

/**
 * An explicit response: status, headers and a body that is itself coerced.
 * Header names are lowercased here, so `Content-Type` replaces the default
 * `content-type` instead of going out next to it.
 */
export class YerdResponse {
  /** Response headers, names lowercased. */
  readonly headers: HeaderInit;

  /**
   * Usually built with res() or redirect(). Throws a TypeError for a status
   * outside 200-599 or a header Node would refuse (see checkHeader).
   */
  constructor(
    readonly status: number,
    headers: HeaderInit,
    readonly body: unknown,
    /** Layouts for a JSX body, applied on top of (or, isolated, instead of) the route's. */
    readonly layout?: LayoutSpec,
    /** Set-Cookie values. */
    readonly cookies?: string[],
  ) {
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      throw new TypeError(`${status} isn't a status a response can have (200-599)`);
    }
    const lower: HeaderInit = {};
    for (const name in headers) {
      const value = headers[name]!;
      checkHeader(name, value);
      lower[name.toLowerCase()] = value;
    }
    this.headers = lower;
  }
}

/** Options for res(). */
export interface ResponseInit {
  /** Default 200. Must be 200-599. */
  status?: number;
  /** Extra headers; they replace the defaults coercion would set (names are case-insensitive). */
  headers?: HeaderInit;
  /**
   * Layout(s) for a JSX body, outermost first, innermost in the chain (inside
   * the app's, groups' and the route's). Chosen at return time, so a handler
   * can pick its chrome per result. One already in the chain isn't repeated.
   */
  layout?: Component<LayoutProps> | Component<LayoutProps>[];
  /** false: `layout` is the whole chain, nothing inherited. */
  inherit?: boolean;
  /** Cookies to set: `[{ name: "theme", value: "dark", maxAge: 31536000 }]`. */
  cookies?: Array<{ name: string; value: string } & CookieOptions>;
}

/**
 * Escape hatch from the coercion defaults. The body still goes through the
 * coercion table, so `res(<Page />, { status: 201 })` is HTML with a 201.
 *
 * ```tsx
 * return res(<Receipt order={order} />, { layout: PrintLayout, inherit: false });
 * ```
 */
export function res(body?: unknown, init: ResponseInit = {}): YerdResponse {
  const layouts = init.layout === undefined ? [] : Array.isArray(init.layout) ? init.layout : [init.layout];
  const layout = layouts.length > 0 || init.inherit === false ? { layouts, isolated: init.inherit === false } : undefined;
  const cookies = init.cookies?.map(({ name, value, ...options }) => serializeCookie(name, value, options));
  return new YerdResponse(init.status ?? 200, init.headers ?? {}, body, layout, cookies);
}

/**
 * A redirect to `location`. The default 303 makes the browser follow up with
 * a GET, which is what you want after a form POST; use 307 / 308 to keep the
 * method. The location is sent as given, apart from non-ASCII characters,
 * which are percent-encoded as UTF-8; so check user-supplied targets.
 *
 * ```ts
 * @post save() { ...; return redirect("/todos"); }
 * ```
 */
export function redirect(location: string, status: 301 | 302 | 303 | 307 | 308 = 303): YerdResponse {
  // A header carries bytes, not text: "/café" would go out as Latin-1 (and
  // "/日本" not at all), while browsers read Location as UTF-8.
  return new YerdResponse(status, { location: location.replace(/[^\x00-\x7f]+/g, encodeURI) }, null);
}

/**
 * Throw to send a status. `message` is shown to the client when `expose` is
 * true. With `details`, the response is JSON: `{ error: message, ...details }`.
 */
export class HttpError extends Error {
  /** Whether `message` (and `details`) reach the client. Default: true below 500, false for 5xx. */
  readonly expose: boolean;
  /** Extra fields merged into the JSON error body when exposed. */
  readonly details: Record<string, unknown> | undefined;

  /**
   * `message` defaults to "HTTP <status>". An unexposed error is answered
   * with the status text instead (and logged, when 5xx). Throws a TypeError
   * for a status outside 200-599.
   *
   * ```ts
   * throw new HttpError(404, "No such todo");
   * throw new HttpError(422, "Invalid order", { details: { field: "qty" } });
   * ```
   */
  constructor(
    readonly status: number,
    message?: string,
    options: { expose?: boolean; cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(message ?? `HTTP ${status}`, { cause: options.cause });
    // Caught here rather than when the response is written: a 1xx would be sent
    // as an interim response with no final one after it, and anything outside
    // 100-999 makes Node throw past every error handler.
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      throw new TypeError(`new HttpError(${status}): not a response status (200-599)`);
    }
    this.name = "HttpError";
    this.expose = options.expose ?? status < 500;
    this.details = options.details;
  }
}

const BARE: unique symbol = Symbol.for("yerd.bare");

/** JSX that skips layouts, for partials. */
export interface Bare {
  readonly [BARE]: true;
  readonly node: Child;
}

/**
 * Return JSX without any layouts, for fragments a client swaps into a page.
 * Like @noLayout, but chosen per result.
 *
 * ```tsx
 * @get row() { return bare(<TodoRow todo={this.todo} />); }
 * ```
 */
export function bare(node: Child): Bare {
  return { [BARE]: true, node };
}

export function isBare(value: unknown): value is Bare {
  return typeof value === "object" && value !== null && (value as Bare)[BARE] === true;
}
