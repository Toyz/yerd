import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { ParsedBody } from "./body.js";
import type { PageMeta } from "../decorators/route.js";
import type { Session } from "../session/session.js";
import type { CookieOptions } from "./cookies.js";

export interface RouteInfo {
  readonly pattern: string;
  readonly paramNames: readonly string[];
  readonly className: string;
}

/** What decorators, handlers and components can see about the current request. */
export interface YerdContext {
  readonly request: IncomingMessage;
  readonly method: string;
  readonly url: URL;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;
  /** Request cookies, parsed. */
  readonly cookies: Readonly<Record<string, string>>;
  /** The session (needs app.sessions(...)). */
  readonly session: Session;
  readonly route: RouteInfo;
  /** Aborts when the client disconnects or the server shuts down. Pass it to fetch, timers, streams. */
  readonly signal: AbortSignal;
  /** The parsed request body. Read once, on first call; later calls share the result. */
  body(): Promise<ParsedBody>;
  /**
   * The body as a stream of NDJSON values, parsed line by line as they arrive.
   * A body can be read whole (body()) or streamed (lines()), not both.
   */
  lines(): AsyncIterable<unknown>;
  /**
   * True while a @prerender route is being rendered at build time. Request
   * data (query, headers, cookies, session, body, request) throws then.
   */
  readonly prerendering: boolean;
  /** Page metadata for layouts: group and route meta, plus whatever setMeta() added. */
  readonly meta: PageMeta;
  /** Sign an action token with the app secret (used when rendering action forms). */
  signAction(payload: { c: string; a: string; p: unknown }): string;
  /** Per-request memo for accessor values. */
  readonly memo: Map<unknown, unknown>;
  /**
   * This request's id: the access log's, echoed as `x-request-id`. Taken from
   * a well-formed incoming `x-request-id`, else generated.
   */
  readonly requestId: string;
  /** Set a response header (replaces one the result set). */
  setHeader(name: string, value: string): void;
  /** Add a Set-Cookie to the response. Defaults: Path=/, HttpOnly, SameSite=Lax. */
  setCookie(name: string, value: string, options?: CookieOptions): void;
  /** Expire a cookie (same path/domain as it was set with). */
  deleteCookie(name: string, options?: CookieOptions): void;
  /** The status for the result when it would otherwise be the default 200 / 204. */
  status(code: number): void;
}

const storage = new AsyncLocalStorage<YerdContext>();

export function runWithContext<T>(context: YerdContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): YerdContext {
  const context = storage.getStore();
  if (!context) {
    throw new Error("No yerd request context: request data was read outside of a request");
  }
  return context;
}

export function maybeContext(): YerdContext | undefined {
  return storage.getStore();
}

/** Add to this request's page meta, e.g. a title known only after loading data. Layouts see it. */
export function setMeta(meta: Partial<PageMeta>): void {
  Object.assign(currentContext().meta, meta);
}
