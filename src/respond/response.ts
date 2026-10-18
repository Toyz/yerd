import type { Child, Component } from "../jsx/jsx-runtime.js";
import type { LayoutProps, LayoutSpec } from "../decorators/route.js";
import { serializeCookie, type CookieOptions } from "../server/cookies.js";

export type HeaderInit = Record<string, string>;

/**
 * An explicit response: status, headers and a body that is itself coerced.
 * Header names are lowercased here, so `Content-Type` replaces the default
 * `content-type` instead of going out next to it.
 */
export class YerdResponse {
  readonly headers: HeaderInit;

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
      // Node refuses these too, but only once the status line is half written.
      if (/[\r\n\0]/.test(value)) throw new TypeError(`Header ${name} contains a line break or NUL`);
      lower[name.toLowerCase()] = value;
    }
    this.headers = lower;
  }
}

export interface ResponseInit {
  status?: number;
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

export function redirect(location: string, status: 301 | 302 | 303 | 307 | 308 = 303): YerdResponse {
  return new YerdResponse(status, { location }, null);
}

/**
 * Throw to send a status. `message` is shown to the client when `expose` is
 * true. With `details`, the response is JSON: `{ error: message, ...details }`.
 */
export class HttpError extends Error {
  readonly expose: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    readonly status: number,
    message?: string,
    options: { expose?: boolean; cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(message ?? `HTTP ${status}`, { cause: options.cause });
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

export function bare(node: Child): Bare {
  return { [BARE]: true, node };
}

export function isBare(value: unknown): value is Bare {
  return typeof value === "object" && value !== null && (value as Bare)[BARE] === true;
}
