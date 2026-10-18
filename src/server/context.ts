import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { ParsedBody } from "./body.js";
import type { PageMeta } from "../decorators/route.js";
import type { Session } from "../session/session.js";
import type { CookieOptions } from "./cookies.js";

/**
 * The route that matched a request, as seen on `ctx.route` and by accessor
 * validators at boot. The pattern is the low-cardinality name for a request,
 * good for metrics and log fields:
 *
 * ```ts
 * const perRoute: Middleware = async (ctx, next) => {
 *   const started = performance.now();
 *   try {
 *     return await next();
 *   } finally {
 *     metrics.observe(ctx.route.pattern, performance.now() - started); // "/users/:id", not one series per id
 *   }
 * };
 * ```
 */
export interface RouteInfo {
  /** The full pattern, group prefixes included, e.g. "/admin/users/:id". */
  readonly pattern: string;
  /** The pattern's `:param` and `*splat` names, in order. */
  readonly paramNames: readonly string[];
  /** The route class's name, for messages. */
  readonly className: string;
  /**
   * false when the route (or its group) opted out of sessions with
   * `session: false`: ctx.session throws there, and auth sees nobody signed in.
   */
  readonly session?: boolean;
}

/**
 * What decorators, handlers and components can see about the current
 * request. Guards, middleware and onError get it as an argument; anywhere
 * else in the request (a service, a component) currentContext() returns it.
 * In a route, prefer the accessor decorators (@query, @param, @body, ...),
 * which validate and type what they read.
 *
 * ```ts
 * @service
 * class Audit {
 *   @inject(Db) accessor db!: Db;
 *
 *   record(action: string) {
 *     const ctx: YerdContext = currentContext();
 *     this.db.audit.add({ action, path: ctx.path, requestId: ctx.requestId, ip: ctx.request.socket.remoteAddress });
 *   }
 * }
 * ```
 */
export interface YerdContext {
  /** The raw node:http request. */
  readonly request: IncomingMessage;
  /** The request method, upper case ("GET", "POST", ...). */
  readonly method: string;
  /**
   * The full request URL, built from the Host header (localhost when there is none).
   *
   * ```ts
   * const shareLink = new URL(`/p/${id}`, ctx.url.origin).href;
   * ```
   */
  readonly url: URL;
  /** The request path as sent, without the query string and not percent-decoded. */
  readonly path: string;
  /**
   * Route params by name, percent-decoded. A splat holds the rest of the path, slashes included.
   *
   * ```ts
   * const ownProfile = createGuard("ownProfile", (ctx) => ctx.params.user === ctx.cookies.user);
   * ```
   */
  readonly params: Readonly<Record<string, string>>;
  /**
   * The query string, parsed.
   *
   * ```ts
   * const page = Number(ctx.query.get("page") ?? 1);
   * const tags = ctx.query.getAll("tag"); // ?tag=a&tag=b
   * ```
   */
  readonly query: URLSearchParams;
  /**
   * Request headers, lower-cased names (node:http's IncomingHttpHeaders).
   *
   * ```ts
   * const fromScript = ctx.headers["yx"] !== undefined; // sent by yerd's client runtime
   * ```
   */
  readonly headers: IncomingHttpHeaders;
  /**
   * Request cookies, parsed.
   *
   * ```ts
   * const theme = ctx.cookies.theme === "dark" ? "dark" : "light";
   * ```
   */
  readonly cookies: Readonly<Record<string, string>>;
  /**
   * The session (needs app.sessions(...)), plain: typed by the app-wide
   * SessionData, empty unless augmented. `as(Shape)` or `as<T>()` gives a
   * typed view; in a route, `@session accessor session!: Session<T>` types
   * it per class. Opened the first time it's read, so a request that never
   * reads it costs nothing; throws on a `session: false` route.
   *
   * ```ts
   * const notice = ctx.session.flash("notice") as string | undefined;
   * const cart = ctx.session.as(Cart); // methods and defaults, like @session(Cart)
   * ```
   */
  readonly session: Session;
  /** The route that matched. */
  readonly route: RouteInfo;
  /**
   * Aborts when the client disconnects or the server shuts down. Pass it to fetch, timers, streams.
   *
   * ```ts
   * const upstream = await fetch("https://api.example.com/report", { signal: ctx.signal });
   * ```
   */
  readonly signal: AbortSignal;
  /**
   * The parsed request body. Read once, on first call; later calls share the
   * result. In a route, @body / @field are the validated way to read it.
   *
   * ```ts
   * const parsed = await ctx.body();
   * if (parsed.kind !== "json") throw new UnsupportedMediaType("Send JSON");
   * ```
   */
  body(): Promise<ParsedBody>;
  /**
   * The body as a stream of NDJSON values, parsed line by line as they arrive.
   * A body can be read whole (body()) or streamed (lines()), not both. In a
   * route, `@args(ndjsonBody(Dto))` validates each line too.
   *
   * ```ts
   * let count = 0;
   * for await (const row of ctx.lines()) {
   *   await db.rows.insert(row);
   *   count++;
   * }
   * ```
   */
  lines(): AsyncIterable<unknown>;
  /**
   * True while a @prerender route is being rendered at build time. Request
   * data (query, headers, cookies, session, body, request) throws then.
   * Components shared by prerendered and live pages check it first.
   *
   * ```tsx
   * function Greeting() {
   *   const ctx = currentContext();
   *   return ctx.prerendering ? <span>Welcome</span> : <span>Welcome back, {ctx.cookies.name ?? "friend"}</span>;
   * }
   * ```
   */
  readonly prerendering: boolean;
  /**
   * Page metadata for layouts: group and route meta, plus whatever setMeta()
   * added. Change it with setMeta(); any component can read it.
   *
   * ```tsx
   * function Breadcrumb() {
   *   return <nav>Home / {currentContext().meta.title}</nav>;
   * }
   * ```
   */
  readonly meta: PageMeta;
  /** Sign an action token with the app secret (used when rendering action forms). */
  signAction(payload: { c: string; a: string; p: unknown; h?: string[][] }): string;
  /** Per-request memo for accessor values. */
  readonly memo: Map<unknown, unknown>;
  /**
   * This request's id: the access log's, echoed as `x-request-id`. Taken from
   * a well-formed incoming `x-request-id`, else generated. Pass it on to
   * the services you call, so their logs line up with yours.
   *
   * ```ts
   * await fetch("https://billing.internal/charge", { method: "POST", headers: { "x-request-id": ctx.requestId } });
   * ```
   */
  readonly requestId: string;
  /**
   * Set a response header (replaces one the result set; Vary is added to
   * instead). Unlike headers on the result, it also goes out on an error response.
   *
   * ```ts
   * currentContext().setHeader("cache-control", "private, max-age=60");
   * ```
   */
  setHeader(name: string, value: string): void;
  /**
   * Add a Set-Cookie to the response. Defaults: Path=/, HttpOnly, SameSite=Lax.
   * It goes out even if the handler later throws.
   *
   * ```ts
   * currentContext().setCookie("seen", "yes", { maxAge: 60 * 60 * 24 });
   * ```
   */
  setCookie(name: string, value: string, options?: CookieOptions): void;
  /**
   * Expire a cookie (same path/domain as it was set with).
   *
   * ```ts
   * currentContext().deleteCookie("prefs", { path: "/account" });
   * ```
   */
  deleteCookie(name: string, options?: CookieOptions): void;
  /**
   * The status for the result when it would otherwise be the default 200 /
   * 204: @status decided at run time. A returned number or res() status wins.
   *
   * ```ts
   * @post enqueue() {
   *   currentContext().status(202);
   *   return { queued: true };
   * }
   * ```
   */
  status(code: number): void;
}

const storage = new AsyncLocalStorage<YerdContext>();

export function runWithContext<T>(context: YerdContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Run with no current request, e.g. background work that a request started. */
export function outsideRequest<T>(fn: () => T): T {
  return storage.exit(fn);
}

/**
 * The current request's context, from anywhere in the request's async call
 * chain (handlers, services, components, guards). Throws outside a request.
 *
 * ```tsx
 * // Whether this request came from yerd's client runtime rather than a plain form post.
 * export function fromScript(): boolean {
 *   return currentContext().headers["yx"] !== undefined;
 * }
 *
 * // A component reading the session: as() types the plain one.
 * export function CartBadge() {
 *   return <span class="badge">{currentContext().session.as(Cart).items.length}</span>;
 * }
 * ```
 */
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

/**
 * Add to this request's page meta, e.g. a title known only after loading
 * data. Layouts see it; keys you set override group and route meta.
 *
 * ```tsx
 * @route("/posts/:slug", { meta: { title: "Blog" } })
 * class Post {
 *   @param("slug") accessor slug!: string;
 *
 *   @get async page() {
 *     const post = await loadPost(this.slug);
 *     setMeta({ title: post.title, description: post.summary });
 *     return <article>{post.body}</article>;
 *   }
 * }
 * ```
 */
export function setMeta(meta: Partial<PageMeta>): void {
  Object.assign(currentContext().meta, meta);
}
