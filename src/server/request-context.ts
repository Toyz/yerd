/**
 * The per-request YerdContext. A class rather than an object literal so its
 * getters live on the prototype (no closures allocated per request), and
 * everything a handler might not touch (URL object, query, abort signal,
 * memo, cookies, body) is created on first use.
 */

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { PageMeta } from "../decorators/route.js";
import type { Container, Scope } from "../di/container.js";
import type { LoadedSession, SessionManager } from "../session/manager.js";
import type { Session } from "../session/session.js";
import { CSRF_FIELD, csrfTag, signAction, type TokenPayload } from "../actions/action.js";
import { randomBytes } from "node:crypto";
import { readBody, readNdjson, type ParsedBody } from "./body.js";
import type { RouteInfo, YerdContext } from "./context.js";
import { parseCookies, serializeCookie, type CookieOptions } from "./cookies.js";
import type { Outgoing } from "../respond/coerce.js";
import { assertStatus, checkHeader } from "../respond/response.js";
import type { ResponseDefaults } from "../decorators/response.js";
import { REQUEST_SPAN, newSpanId, type Span } from "../log/span.js";
import { HttpError } from "../respond/response.js";
import { abortOnClose, forwarded, mergeVary, requestIdFrom, requestIsHttps } from "./http.js";

export interface RequestEnv {
  secrets: readonly string[];
  bodyLimit: number;
  sessions: SessionManager | undefined;
  container: Container;
  /** How long action tokens stay valid, in seconds. */
  actionTtl: number;
  /** Believe X-Forwarded-Proto / X-Forwarded-Host (behind a reverse proxy). */
  trustProxy: boolean;
}

/** What a request's context is made from. */
export interface RequestContextInit {
  req: IncomingMessage;
  res: ServerResponse;
  /** The request target, split into path and query string. */
  target: { path: string; search: string };
  method: string;
  params: Readonly<Record<string, string>>;
  route: RouteInfo;
  /** This request's own copy: setMeta() writes to it. */
  meta: PageMeta;
  /** Rendering a @prerender route at build time. Default false. */
  prerendering?: boolean;
  scope: Scope;
  env: RequestEnv;
}

export class RequestContext implements YerdContext {
  readonly path: string;
  /** DI for this request; read by currentServices() so one async context serves both. */
  readonly services: { container: Container; scope: Scope };
  loadedSession: LoadedSession | undefined;
  /** @status / @setHeader of the handler or action that ran. */
  declared: ResponseDefaults | undefined;

  #search: string;
  #url: URL | undefined;
  #query: URLSearchParams | undefined;
  #abort: AbortController | undefined;
  #memo: Map<unknown, unknown> | undefined;
  #cookies: Record<string, string> | undefined;
  #body: Promise<ParsedBody> | undefined;
  #lines: AsyncIterable<unknown> | undefined;
  #requestId: string | undefined;
  #outHeaders: Record<string, string> | undefined;
  #outCookies: string[] | undefined;
  #status: number | undefined;

  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly params: Readonly<Record<string, string>>;
  readonly route: RouteInfo;
  readonly meta: PageMeta;
  readonly prerendering: boolean;
  readonly env: RequestEnv;

  constructor(init: RequestContextInit) {
    this.req = init.req;
    this.res = init.res;
    this.method = init.method;
    this.params = init.params;
    this.route = init.route;
    this.meta = init.meta;
    this.prerendering = init.prerendering ?? false;
    this.env = init.env;
    this.path = init.target.path;
    this.#search = init.target.search;
    this.services = { container: init.env.container, scope: init.scope };
  }

  #noRequestData(what: string): void {
    if (this.prerendering) {
      throw new Error(`${what} is request data, and ${this.route.className} is prerendered at build time, when there is no request`);
    }
  }

  /**
   * The full request URL. https when the connection is TLS, or (with
   * `trustProxy`) when X-Forwarded-Proto says so, in any case: the same
   * rule as the session cookie's Secure flag (see requestIsHttps). The host
   * comes from X-Forwarded-Host under `trustProxy`, else Host.
   */
  get url(): URL {
    if (!this.#url) {
      const headers = this.req.headers;
      const https = requestIsHttps(this.req, this.env.trustProxy);
      const host = (this.env.trustProxy ? forwarded(headers["x-forwarded-host"]) : undefined) ?? headers.host ?? "localhost";
      // Path and query are set on their own: resolved against a base, a request
      // for "//evil.com/x" (or "/\evil.com/x") would be read as a URL on evil.com.
      let url: URL;
      try {
        url = new URL(`${https ? "https" : "http"}://${host}`);
      } catch {
        // The client's own fault ("Host: a b"): a 400, not a crash logged as a server error.
        throw new HttpError(400, "Malformed Host header");
      }
      url.pathname = this.path;
      url.search = this.#search;
      this.#url = url;
    }
    return this.#url;
  }

  get query(): URLSearchParams {
    this.#noRequestData("the query string");
    return (this.#query ??= new URLSearchParams(this.#search));
  }

  get headers(): IncomingHttpHeaders {
    this.#noRequestData("headers");
    return this.req.headers;
  }

  get request(): IncomingMessage {
    this.#noRequestData("the request");
    return this.req;
  }

  get cookies(): Readonly<Record<string, string>> {
    this.#noRequestData("cookies");
    return (this.#cookies ??= parseCookies(this.req.headers.cookie));
  }

  get session(): Session {
    this.#noRequestData("the session");
    if (!this.env.sessions) throw new Error("Sessions are off; call app.sessions() to turn them on");
    if (!this.loadedSession) throw new Error("The session isn't loaded yet");
    return this.loadedSession.session;
  }

  /** Aborts when the client disconnects or the server shuts down. Created (and wired up) on first use. */
  get signal(): AbortSignal {
    return (this.#abort ??= abortOnClose(this.res)).signal;
  }

  /** End the request's work (graceful shutdown of long-lived streams). */
  abort(reason: unknown): void {
    if (!this.#abort) void this.signal;
    this.#abort!.abort(reason);
  }

  get requestId(): string {
    const span = (this.req as unknown as Record<symbol, Span | undefined>)[REQUEST_SPAN];
    if (span) return span.id;
    return (this.#requestId ??= requestIdFrom(this.req) ?? newSpanId());
  }

  setHeader(name: string, value: string): void {
    checkHeader(name, value);
    (this.#outHeaders ??= {})[name.toLowerCase()] = value;
  }

  setCookie(name: string, value: string, options?: CookieOptions): void {
    (this.#outCookies ??= []).push(serializeCookie(name, value, options));
  }

  deleteCookie(name: string, options: CookieOptions = {}): void {
    this.setCookie(name, "", { ...options, maxAge: 0, expires: new Date(0) });
  }

  status(code: number): void {
    assertStatus(code, "ctx.status()");
    this.#status = code;
  }

  /**
   * Put what the handler declared (@status, @setHeader) and set on the
   * context onto the outgoing response. A status only replaces the default
   * 200 / 204, and never on an error response; headers and cookies apply
   * either way (a cookie set before a redirect or a 401 still goes out).
   */
  finish(out: Outgoing, failed: boolean): Outgoing {
    // @status / @setHeader describe the handler's result, so an error response
    // doesn't get them; headers and cookies set on the context do apply.
    const defaults = failed ? undefined : this.declared;
    if (defaults) {
      for (const name in defaults.headers) {
        if (name === "vary") out.headers.vary = mergeVary(out.headers.vary, defaults.headers.vary!);
        else if (!(name in out.headers)) out.headers[name] = defaults.headers[name]!;
      }
    }
    // Vary adds up: replacing the `accept` or `user-agent` that negotiation and
    // variants put there would let a cache serve one variant to everyone.
    for (const name in this.#outHeaders) {
      out.headers[name] = name === "vary" ? mergeVary(out.headers.vary, this.#outHeaders.vary!) : this.#outHeaders[name]!;
    }
    if (this.#outCookies) out.cookies = [...(out.cookies ?? []), ...this.#outCookies];
    if (!failed && !out.explicitStatus && (out.status === 200 || out.status === 204)) {
      const code = this.#status ?? defaults?.status;
      if (code !== undefined) out.status = code;
    }
    return out;
  }

  get memo(): Map<unknown, unknown> {
    return (this.#memo ??= new Map());
  }

  body(): Promise<ParsedBody> {
    this.#noRequestData("the body");
    if (this.#lines) throw new Error("The request body is already being streamed with lines()");
    return (this.#body ??= readBody(this.req, this.env.bodyLimit));
  }

  lines(): AsyncIterable<unknown> {
    this.#noRequestData("the body");
    if (this.#body) throw new Error("The request body was already read whole with body()");
    return (this.#lines ??= readNdjson(this.req, this.env.bodyLimit));
  }

  /** Whether the session already holds a CSRF nonce (so signing a token won't change it). */
  get hasCsrfNonce(): boolean {
    return typeof this.loadedSession?.session.get(CSRF_FIELD) === "string";
  }

  /**
   * The session's CSRF nonce, created when the first action token is signed
   * for it, so a visitor who's never shown a form never gets a session (or
   * a store entry) for it. The nonce has to be in the session before the
   * session cookie goes out with the headers. A page renders everything it
   * can without waiting before the headers, so forms there sign in time;
   * if the page (or an event stream) still has parts to come when the
   * headers go, the app creates the nonce then, since a later part may
   * render a form (see YerdApp's #finalize).
   */
  csrfNonce(): string | undefined {
    const session = this.loadedSession?.session;
    if (!session) return undefined;
    let nonce = session.get(CSRF_FIELD);
    if (typeof nonce !== "string") {
      nonce = randomBytes(18).toString("base64url");
      session.set(CSRF_FIELD, nonce);
    }
    return nonce;
  }

  signAction(payload: { c: string; a: string; p: unknown; h?: string[][] }): string {
    const token: TokenPayload = { ...payload };
    // Prerendered pages are built for no one in particular, so their tokens
    // can't carry a session or a meaningful expiry.
    if (!this.prerendering) {
      token.e = Math.floor(Date.now() / 1000) + this.env.actionTtl;
      const nonce = this.csrfNonce();
      if (nonce !== undefined) token.s = csrfTag(nonce);
    }
    return signAction(this.env.secrets[0]!, token);
  }
}
