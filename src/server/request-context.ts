/**
 * The per-request YerdContext. A class rather than an object literal so its
 * getters live on the prototype (no closures allocated per request), and
 * everything a handler might not touch (URL object, query, abort signal,
 * memo, cookies, body, session) is created on first use.
 */

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { PageMeta } from "../decorators/route.js";
import type { Container, Scope } from "../di/container.js";
import type { LoadedSession, SessionManager } from "../session/manager.js";
import type { Session } from "../session/session.js";
import { CSRF_FIELD, csrfTag, signAction, type TokenPayload } from "../actions/action.js";
import { readBody, readNdjson, type ParsedBody } from "./body.js";
import type { RouteInfo, YerdContext } from "./context.js";
import { parseCookies, serializeCookie, type CookieOptions } from "./cookies.js";
import type { Outgoing } from "../respond/coerce.js";
import { assertStatus, checkHeader } from "../respond/response.js";
import type { ResponseDefaults } from "../decorators/response.js";
import { REQUEST_SPAN, newSpanId, type Span } from "../log/span.js";
import { BadRequest } from "../respond/errors.js";
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
  /** The session, once something opened it. */
  #session: LoadedSession | undefined;
  /** Why the up-front read of the session failed; thrown again at its first use. */
  #sessionFailure: { error: unknown } | undefined;

  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly params: Readonly<Record<string, string>>;
  /** Swapped by the app for the variant or action that ends up serving the request. */
  route: RouteInfo;
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
        throw new BadRequest("Malformed Host header");
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

  /**
   * The session, opened on first use: nothing is unsealed or read from the
   * store for a request that never asks. Opening is synchronous for the
   * cookie store and `sync` stores; other stores were read before
   * middleware ran (readsUpFront).
   */
  get session(): Session {
    this.#noRequestData("the session");
    return this.#openSession().session;
  }

  /** The session if something opened it; never opens it (the commit, and the Cache-Control rule, read this). */
  get loadedSession(): LoadedSession | undefined {
    return this.#session;
  }

  #openSession(): LoadedSession {
    if (this.#session) return this.#session;
    const sessions = this.env.sessions;
    if (!sessions) throw new Error("Sessions are off; call app.sessions() to turn them on");
    if (this.route.session === false) {
      throw new Error(`${this.route.className} (${this.route.pattern}) has \`session: false\`, so it has no session; drop the option (on the route or its group) to use one there`);
    }
    if (this.#sessionFailure) throw this.#sessionFailure.error;
    const loaded = sessions.load(this.req, this.cookies);
    if (loaded instanceof Promise) {
      // Only reached where the up-front read didn't happen (an error page for
      // a non-HTML request): the async read can't be waited for here.
      void loaded.catch(() => {});
      throw new Error("The session store reads asynchronously and this request's session wasn't read up front, so it can't be used here");
    }
    return (this.#session = loaded);
  }

  /**
   * Read the session now when it can't be read on first use: a store whose
   * get() may return a promise, for a request carrying a session cookie.
   * The app calls this as soon as the request is routed and awaits it
   * before middleware runs, so every later use is synchronous. Undefined
   * (nothing to wait for) for cookie and `sync` stores, requests without a
   * session cookie, and `session: false` routes. A failed read is kept and
   * thrown at the first use, as well as from the promise.
   */
  readsUpFront(): Promise<void> | undefined {
    const sessions = this.env.sessions;
    if (!sessions || this.#session || this.prerendering || this.route.session === false || sessions.readsOnUse) return undefined;
    if (!sessions.hasCookie(this.req, this.cookies)) return undefined;
    let loaded: LoadedSession | Promise<LoadedSession>;
    try {
      loaded = sessions.load(this.req, this.cookies);
    } catch (error) {
      this.#sessionFailure = { error };
      return Promise.reject(error);
    }
    if (!(loaded instanceof Promise)) {
      this.#session = loaded;
      return undefined;
    }
    return loaded.then(
      (session) => {
        this.#session = session;
      },
      (error: unknown) => {
        this.#sessionFailure = { error };
        throw error;
      },
    );
  }

  /** Whether the request has (or, unopened, carries a cookie for) a session: a page for it is per-visitor. */
  get holdsSession(): boolean {
    if (this.#session) return this.#session.payload !== undefined;
    const sessions = this.env.sessions;
    return sessions !== undefined && !this.prerendering && this.route.session !== false && sessions.hasCookie(this.req, this.cookies);
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

  /**
   * The CSRF nonce of this request's session, or undefined when it has no
   * session (no cookie, or one that doesn't open to a live session), on a
   * `session: false` route, or with sessions off. Never creates one: a
   * session gets its nonce when it's first written (see CSRF_FIELD), so
   * rendering a form for a visitor without a session starts nothing, and
   * however a page streams, it never sets a cookie because of its forms.
   */
  csrfNonce(): string | undefined {
    const sessions = this.env.sessions;
    if (!sessions || this.prerendering || this.route.session === false) return undefined;
    // Nothing open and no cookie to open: no session, and no need to make an empty one.
    if (!this.#session && !sessions.hasCookie(this.req, this.cookies)) return undefined;
    const nonce = this.#openSession().session.get(CSRF_FIELD);
    return typeof nonce === "string" ? nonce : undefined;
  }

  /**
   * Sign an action token for a form on this page: bound to the session's
   * nonce when the visitor has one, unbound otherwise (see checkActionToken).
   */
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
