import { STATUS_CODES, createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, extname, join } from "node:path";
import { ACCESSORS, ARGS, type Resolver } from "../decorators/kit.js";
import { ACCEPTS, METHOD_LAYOUTS, NO_LAYOUT, PRERENDER, applyLayouts, joinLayouts, resetRouteRegistry, type When, VERBS, resolveRoute, routeRegistry, type LayoutProps, type PageMeta, type ResolvedRoute, type RouteDef, type Verb } from "../decorators/route.js";
import { choose, expandType } from "../respond/negotiate.js";
import { Container, Scope, ServiceCollection, currentServices, keyName, runWithServices, type Lifetime, type Registration } from "../di/container.js";
import {
  EVERY, INJECTS, ON_BOOT, ON_SHUTDOWN, lifetimeOf, registrationFor, resetServiceRegistry, serviceRegistry,
  type HostedService,
} from "../di/decorators.js";
import { jsx, type Component } from "../jsx/jsx-runtime.js";
import { coerce, type Outgoing } from "../respond/coerce.js";
import { BadRequest, Forbidden, jsonBody, MethodNotAllowed, NotAcceptable, NotFound, YerdError } from "../respond/errors.js";
import { LONG_LIVED, STREAMING, sse } from "../respond/stream.js";
import { SITEMAP, Sitemap, type SitemapEntry, type SitemapOptions, type SitemapRoute } from "../seo/sitemap.js";
import { Channels } from "../live/channels.js";
import { CLOCK_PATH, CUES_PATH, Cues, DEFAULT_ROOM, isPublicRoom, validRoom, type CuesOptions } from "../live/cues.js";
import { TestClient, answer } from "./in-process.js";
import { compilePath } from "../log/paths.js";
import { cssBundleClasses, cssBundleHash, cssBundleText, resetCss, resetCssBundle, useCssBundle } from "../render/css.js";
import { EventTransport, Events, HANDLES, ON_EVENT, eventName } from "../events/events.js";
import { ACTIONS, ActionForm, checkActionToken, fillHoles, resolveSecrets, safeBack, verifyAction } from "../actions/action.js";
import { CLASS_GUARDS, METHOD_GUARDS, guardRegistry, isGuardRef, resetGuardRegistry, type GuardSpec } from "../decorators/guards.js";
import { SessionManager, checkSessionOptions } from "../session/manager.js";
import type { SessionOptions } from "../session/session.js";
import { RUNTIME_CHUNK_PREFIX, RUNTIME_PATH } from "../actions/components.js";
import { OUTDATED_CHUNK, chunkSource, chunkVersion, runtimeSource } from "../client/runtime.js";
import { attributesSource, moduleAttributes, resetAttributeRegistry } from "../attributes/attribute.js";
import { lazyRegistry, resetLazyElements } from "../render/lazy.js";
import { isYerdNode } from "../jsx/jsx-runtime.js";
import { YerdResponse, isBare, redirect } from "../respond/response.js";
import { Router, paramNames } from "../router/trie.js";
import { DEFAULT_BODY_LIMIT, mediaTypeOf } from "./body.js";
import { metadataOf } from "../decorators/keys.js";
import { acceptsEncoding, createMount, serveStatic, type StaticMount, type StaticOptions } from "./static.js";
import { useManifest } from "../assets.js";
import { runWithContext, type RouteInfo, type YerdContext } from "./context.js";
import { RequestContext, type RequestEnv } from "./request-context.js";
import { abortOnClose, forwarded, isStreamBody, mergeVary, splitTarget, wantsPage } from "./http.js";
import { CATCHES, METHOD_RESPONSE, type CatchEntry, type ResponseDefaults } from "../decorators/response.js";
import { ConsoleLogger } from "../log/console.js";
import { LogFilter, defaultFilter } from "../log/filter.js";
import { ILogger } from "../log/ilogger.js";
import { Logger } from "../log/logger.js";
import { REQUEST_SPAN, bindLogging, endRequestSpan, startRequestSpan, type LogBinding } from "../log/span.js";

/** yerd's own log targets. */
const lifecycleLog = new Logger("yerd::lifecycle");
const cueLog = new Logger("yerd::cues");
const requestLog = new Logger("yerd::request");

/**
 * Options for {@link yerd} / `new YerdApp()`. Every field is optional.
 *
 * ```ts
 * const app = yerd({
 *   bodyLimit: 10 * 1024 * 1024, // photo uploads
 *   trustProxy: true,            // behind nginx, which sets X-Forwarded-*
 *   trustedOrigins: ["https://admin.example.com"],
 * });
 * ```
 */
export interface YerdOptions {
  /**
   * Only serve these route classes. Defaults to every class decorated with
   * @route. Tests list theirs, so routes imported for other reasons stay out.
   *
   * ```ts
   * const server = await yerd({ routes: [Hello], services: [], handleSignals: false }).listen(0, "127.0.0.1");
   * ```
   */
  routes?: Function[];
  /** Only register these @service / @hosted classes. Defaults to all of them. */
  services?: Function[];
  /** Largest request body read, in bytes. Bigger bodies get a 413. Default 1 MiB. */
  bodyLimit?: number;
  /** How long close() waits for in-flight requests and background work, in ms. Default 10000. */
  shutdownTimeout?: number;
  /**
   * Close gracefully on SIGINT / SIGTERM, then exit. Default true. Turn it
   * off when something else owns the process's signals.
   *
   * ```ts
   * yerd({ handleSignals: false }); // under a test runner, Ctrl-C stays the runner's
   * ```
   */
  handleSignals?: boolean;
  /**
   * Signs action tokens and seals sessions. At least 32 bytes each; a list
   * rotates (newest first). Defaults to YERD_SECRET (comma separated), else a
   * random per-process secret.
   *
   * ```ts
   * // Rotating: new tokens use the first, old ones still verify with the second.
   * yerd({ secret: [process.env.NEW_SECRET!, process.env.OLD_SECRET!] });
   * ```
   */
  secret?: string | string[];
  /** How long a rendered action form stays valid, in seconds. Default 86400 (a day). */
  actionTtl?: number;
  /**
   * Cross-site protection for unsafe methods (POST, PUT, PATCH, DELETE): a
   * browser request from another site is refused with 403, judged by
   * Sec-Fetch-Site, Origin, then Referer. Requests with none of those (curl,
   * server-to-server) pass. Default true.
   *
   * It's the first line of CSRF defense, for every unsafe request. Action
   * tokens add a signature, an expiry and, for a visitor with a session, a
   * binding to that session; a form rendered for a visitor without one
   * carries an unbound token, which only this check (and SameSite cookies)
   * keeps another site from posting. `false` turns the check off: plain
   * POST handlers, and actions posted by a visitor without a session (a
   * login form: login CSRF) or with a prerendered token, are then open to
   * cross-site posts. An action posted for a visitor with a session still
   * needs a token bound to that session, which another site can't get.
   */
  csrf?: boolean;
  /** Other origins allowed to send unsafe requests, e.g. ["https://admin.example.com"]. */
  trustedOrigins?: string[];
  /** Behind a reverse proxy: believe X-Forwarded-Host for the origin check. Default false. */
  trustProxy?: boolean;
  /**
   * The built-in cue stream: which rooms anyone may listen to (see Cues).
   * Default `{ public: ["main"] }`.
   *
   * ```ts
   * yerd({ cues: { public: ["main", "rave"] } });
   * ```
   */
  cues?: CuesOptions;
}

/** Options for app.logging(): which records are written, and how. */
export interface LoggingOptions {
  /** Directives like YERD_LOG ("info,UserRepo=debug"). Default: YERD_LOG, else info (warn under tests). */
  filter?: string;
  /** ConsoleLogger format. Default: pretty on a terminal outside production, else json. */
  format?: "pretty" | "json";
  /**
   * Field paths to mask as "[redacted]" in every record (fields and span
   * fields), on top of the secret-looking keys yerd always masks. `*` is any
   * one key, `**` any depth.
   *
   * ```ts
   * yerd().logging({ redact: ["**.ssn", "card.number", "headers.authorization", "*.email"] });
   * ```
   */
  redact?: string[];
}

/** A route method and what runs before it, resolved at boot: a handler, or an action on a handler's class. */
interface Call {
  method: string | symbol;
  /** Its guards as functions, outermost first. */
  runs: readonly GuardRun[];
  /** What @status / @setHeader declared for it. */
  declared: ResponseDefaults | undefined;
}

interface Handler extends Call {
  def: RouteDef;
  lifetime: Lifetime;
  info: RouteInfo;
  layouts: Component<LayoutProps>[];
  meta: PageMeta;
  args: readonly Resolver[] | undefined;
  /** Mime types from @accepts; undefined for the default handler. */
  accepts: string[] | undefined;
  /** Every guard in front of this handler, outermost first. */
  guards: GuardSpec[];
  /** `@get(when)`: a variant that serves only requests the test accepts. */
  when: { test: When; vary: string | undefined } | undefined;
  /** The guards in front of every handler and action of the class (app, group, class), without method guards. */
  classGuards: GuardSpec[];
  /** `guards` as functions; filled in once boot has found every named guard. */
  runs: GuardRun[];
  /** The class's @catches methods, in declaration order. */
  catches: readonly CatchEntry[];
}

/** An @action method, ready to run on the class of `owner` (the pattern's first handler from that class). */
interface ActionCall extends Call {
  owner: Handler;
  method: string;
  runs: GuardRun[];
}

/** A route kept at boot for the sitemap, with what its def alone doesn't say. */
interface MappedRoute {
  def: RouteDef;
  pattern: string;
  lifetime: Lifetime;
  sitemap: ResolvedRoute["sitemap"];
}

/** A handler's or action's result, or the answer of a guard that turned the request away first. */
type Invoked = { blocked: Outgoing; result?: undefined } | { blocked?: undefined; result: unknown };

/**
 * Middleware wraps guards and the handler (or action) for every routed
 * request. Call `next()` to run them and get the response, which you may
 * change before returning it, or throw (a YerdError, say) to answer
 * without running them. Install it with app.use().
 *
 * ```ts
 * // How long the app took, as a Server-Timing header (shown in the browser's dev tools).
 * const timing: Middleware = async (ctx, next) => {
 *   const started = performance.now();
 *   const out = await next();
 *   out.headers["server-timing"] = `app;dur=${(performance.now() - started).toFixed(1)}`;
 *   return out;
 * };
 *
 * yerd().use(timing);
 * ```
 */
export type Middleware = (ctx: YerdContext, next: () => Promise<Outgoing>) => Promise<Outgoing>;

/** A guard as it runs: a createGuard() ref's own function, or a named @guard method on its service. */
type GuardRun = (ctx: YerdContext) => unknown;

/**
 * Every handler for one pattern + verb (a default, @accepts variants,
 * `@get(when)` variants), and what picking among them needs, worked out at
 * boot rather than per request.
 */
interface RouteGroup {
  handlers: readonly Handler[];
  /** `@get(when)` variants, tried in order once the request context exists. */
  variants: readonly Handler[];
  /** Some variant has no @accepts, so it can answer any type. */
  variantFallback: boolean;
  /** Every variant's `vary`, merged: the response depends on what their tests read, whichever answers. */
  vary: string | undefined;
  /** The plain (no `when`) handler without @accepts: the default. */
  fallback: Handler | undefined;
  /** The plain @accepts handlers, and their types for choose(). */
  accepting: readonly Handler[];
  acceptLists: readonly string[][];
  /** Picked by Accept, so the response varies by it. */
  negotiated: boolean;
  node: RouteNode;
}

/** One pattern's handlers across its verbs, worked out at boot. */
interface RouteNode {
  /** The first handler: the route a request is reported under when no verb's handler serves it (an action post). */
  first: Handler;
  /** The @action methods of the pattern's classes, by class name, then action name: what a token names. */
  actions: ReadonlyMap<string, ReadonlyMap<string, ActionCall>>;
  /** The Allow header for a 405. */
  allow: string[];
}

/** What routing picked for a request (see resolveRequest). */
interface Routed {
  /** The verb's handlers; undefined when only an action can answer (a form post with no @post). */
  group: RouteGroup | undefined;
  /** The plain handler the Accept header picked, if any. */
  handler: Handler | undefined;
  node: RouteNode;
  /** A form post to a pattern with actions: dispatched as one if it carries a token. */
  mayBeAction: boolean;
  error?: undefined;
}

/** The handler for a request among those without a `when` test: the default, or an @accepts variant. */
function pickHandler(group: RouteGroup, accept: string | undefined): Handler | undefined {
  if (group.accepting.length === 0) return group.fallback;
  const chosen = choose(group.acceptLists, accept, group.fallback !== undefined);
  if (chosen === "default") return group.fallback;
  return chosen === undefined ? undefined : group.accepting[chosen];
}

/**
 * Pick what serves a matched request: the verb's group (HEAD falls back to
 * GET, then ALL) and the handler Accept picks, or the 406 / 405 to answer
 * with (carrying its Vary or Allow header).
 */
function resolveRequest(
  handlers: ReadonlyMap<Verb, RouteGroup>,
  method: Verb,
  headers: IncomingHttpHeaders,
): Routed | { error: YerdError } {
  const group = handlers.get(method) ?? (method === "HEAD" ? handlers.get("GET") : undefined) ?? handlers.get("ALL");
  const node = (group ?? handlers.values().next().value!).node;
  // `@get(when)` variants are tested once the request context exists; the rest is picked now.
  const handler = group && pickHandler(group, headers.accept);
  const variants = group?.variants.length ?? 0;
  if (group && !handler && variants === 0) return { error: new NotAcceptable(undefined, { headers: { vary: "accept" } }) };
  const mayBeAction = method === "POST" && node.actions.size > 0 && isFormBody(headers["content-type"]);
  if (!handler && !mayBeAction && variants === 0) return { error: new MethodNotAllowed(undefined, { allow: node.allow }) };
  return { group, handler, node, mayBeAction };
}

/** A pattern's node: its actions, each behind its class's guards and its own, and its Allow header. */
function routeNode(byVerb: ReadonlyMap<Verb, readonly Handler[]>, pendingRuns: Array<[GuardRun[], readonly GuardSpec[]]>): RouteNode {
  const candidates = [...new Set([...byVerb.values()].flat())];
  const actions = new Map<string, Map<string, ActionCall>>();
  for (const owner of candidates) {
    const names = ACTIONS.from(owner.def.metadata);
    if (!names?.size) continue;
    let byName = actions.get(owner.def.className);
    if (!byName) actions.set(owner.def.className, (byName = new Map()));
    const methodGuards = METHOD_GUARDS.from(owner.def.metadata);
    const declared = METHOD_RESPONSE.from(owner.def.metadata);
    for (const name of names) {
      // Two handlers of one class (GET and POST) share its actions: the first found runs them.
      if (byName.has(name)) continue;
      const call: ActionCall = { owner, method: name, runs: [], declared: declared?.get(name) };
      pendingRuns.push([call.runs, [...owner.classGuards, ...(methodGuards?.get(name) ?? [])]]);
      byName.set(name, call);
    }
  }
  const allow = [...byVerb.keys()].filter((v) => v !== "ALL");
  if (allow.includes("GET") && !allow.includes("HEAD")) allow.push("HEAD");
  return { first: candidates[0]!, actions, allow };
}

function routeGroup(handlers: readonly Handler[], node: RouteNode): RouteGroup {
  const variants = handlers.filter((h) => h.when);
  const plain = handlers.filter((h) => !h.when);
  const accepting = plain.filter((h) => h.accepts);
  let vary: string | undefined;
  for (const variant of variants) if (variant.when!.vary) vary = mergeVary(vary, variant.when!.vary);
  return {
    handlers,
    variants,
    variantFallback: variants.some((v) => !v.accepts),
    vary,
    fallback: plain.find((h) => !h.accepts),
    accepting,
    acceptLists: accepting.map((h) => h.accepts!),
    negotiated: accepting.length > 0,
    node,
  };
}

/** The route a request that never reached a handler is reported under. */
const NO_ROUTE: RouteInfo = { pattern: "", paramNames: [], className: "" };

/**
 * Props for app.errorPage().
 *
 * ```tsx
 * function ErrorPage({ status, message }: ErrorPageProps) {
 *   return (
 *     <main class="error">
 *       <h1>{status === 404 ? "Nothing here" : "Something went wrong"}</h1>
 *       <p>{message}</p>
 *     </main>
 *   );
 * }
 *
 * yerd().layout(RootLayout).errorPage(ErrorPage);
 * ```
 */
export interface ErrorPageProps {
  /** The HTTP status being sent, e.g. 404 or 500. */
  status: number;
  /** A message safe to show: the YerdError's message when it's exposed, else the status text. */
  message: string;
  /**
   * What was thrown: a YerdError (an unknown path is a NotFound), or
   * whatever a handler threw. For `instanceof` checks, logging, or showing
   * details in development; `message` is what's safe to show everyone.
   *
   * ```tsx
   * function ErrorPage({ status, message, error }: ErrorPageProps) {
   *   return (
   *     <main>
   *       <h1>{status}</h1>
   *       <p>{error instanceof Unauthorized ? <a href="/login">Sign in</a> : message}</p>
   *       {process.env.NODE_ENV !== "production" && error instanceof Error ? <pre>{error.stack}</pre> : null}
   *     </main>
   *   );
   * }
   * ```
   */
  error: unknown;
}

type Next = (error?: unknown) => void;

/**
 * What app.listen() resolves to once the server is accepting connections.
 * Tests keep one per file:
 *
 * ```ts
 * let server: RunningServer;
 * server = await yerd({ routes: [Hello], services: [], handleSignals: false }).listen(0, "127.0.0.1");
 * const res = await fetch(`${server.url}/hello`);
 * await server.close();
 * ```
 */
export interface RunningServer {
  /**
   * The underlying node:http server, for settings and events yerd doesn't wrap.
   *
   * ```ts
   * server.server.requestTimeout = 30_000;
   * ```
   */
  readonly server: Server;
  /** The base URL, `http://<host>:<port>`, with the real port when listening on port 0. Host defaults to localhost. */
  readonly url: string;
  /**
   * Graceful: stop accepting, end streams, let requests finish, stop
   * background work, dispose services. listen() already does this on SIGINT
   * and SIGTERM unless `handleSignals` is false; then it's yours to call.
   *
   * ```ts
   * const server = await yerd({ handleSignals: false }).listen(3000);
   * process.on("SIGTERM", async () => {
   *   await server.close();
   *   process.exit(0);
   * });
   * ```
   */
  close(): Promise<void>;
}

/**
 * Thrown by boot validation (app.boot(), and so the first listen(), start()
 * or request); lists every problem at once: unknown guards, missing
 * services, captive dependencies, @param names the pattern lacks, duplicate
 * routes.
 *
 * ```ts
 * try {
 *   await app.boot();
 * } catch (error) {
 *   if (error instanceof BootError) for (const problem of error.problems) console.error(problem);
 *   process.exit(1);
 * }
 * ```
 */
export class BootError extends Error {
  /** `problems`: one message per thing that's wrong; the error message lists them all. */
  constructor(readonly problems: string[]) {
    super(`yerd refused to start:\n  - ${problems.join("\n  - ")}`);
    this.name = "BootError";
  }
}

/**
 * The text an unexposed error is answered with: Node's list, except 413,
 * which Node still calls by its old name ("Payload Too Large") where
 * RFC 9110 says "Content Too Large".
 */
function statusText(status: number): string {
  return status === 413 ? "Content Too Large" : (STATUS_CODES[status] ?? `HTTP ${status}`);
}

/** How long close() and stop() wait for in-flight work by default, in ms. */
const DEFAULT_SHUTDOWN_MS = 10_000;

async function importDirectory(dir: URL): Promise<void> {
  const root = fileURLToPath(dir);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && /\.(m?js)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name))
    .sort();
  for (const file of files) await import(/* @vite-ignore */ pathToFileURL(file).href);
}

function withTimeout(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([work.then(() => true, () => true), timeout]).finally(() => clearTimeout(timer));
}

interface Periodic {
  stop(): Promise<void>;
}

function startPeriodic(run: (signal: AbortSignal) => unknown, ms: number, immediate: boolean, signal: AbortSignal, label: string): Periodic {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<unknown> | undefined;
  const tick = () => {
    if (signal.aborted) return;
    running = Promise.resolve()
      .then(() => run(signal))
      .catch((error) => lifecycleLog.error(`@every ${label} failed`, { error }))
      .finally(() => {
        running = undefined;
        if (!signal.aborted) timer = setTimeout(tick, ms);
      });
  };
  timer = setTimeout(tick, immediate ? 0 : ms);
  return {
    async stop() {
      clearTimeout(timer);
      await running;
    },
  };
}

/** Vite's `base` as a prefix for URLs: "/" (the default), "/app/", or a full URL ending in "/". "./" (relative) counts as "/". */
function publicBase(base: string | undefined): string {
  if (!base || base === "./" || base === ".") return "/";
  return base.endsWith("/") ? base : `${base}/`;
}

/** Where the client build's files are mounted: the base's path, or "/" for a full URL (a CDN pulls from there). */
function mountPath(base: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(base) ? "/" : base;
}

/** Read .yerd/css.json: `file` (current) or an older `href`, under the base. */
function useCssRecord(path: string, base: string): void {
  const record = JSON.parse(readFileSync(path, "utf8")) as { file?: string; href?: string; classes: string[] };
  useCssBundle(record.file !== undefined ? base + record.file : record.href!, record.classes);
}

/**
 * A yerd application: routes, layouts, services and the server around them.
 * Create one with {@link yerd}; the configuration methods return the app, so
 * they chain, and most must be called before the app starts. Boot happens on
 * the first listen(), start(), boot() or request.
 *
 * ```ts
 * const app = yerd({ bodyLimit: 4 * 1024 * 1024 })
 *   .layout(RootLayout)
 *   .sessions()
 *   .static("/assets", "./public");
 *
 * const server = await app.listen(3000);
 * ```
 */
export class YerdApp {
  readonly #options: YerdOptions;
  readonly #layouts: Component<LayoutProps>[] = [];
  readonly #mounts: StaticMount[] = [];
  /** Prerendered paths -> files, served before routing in production. */
  readonly #prerendered = new Map<string, { mount: StaticMount; file: string }>();
  #prerenderToken: string | undefined;
  readonly #prerenderErrors = new Map<string, string>();
  #errorPage: Component<ErrorPageProps> | undefined;
  readonly #pending: Promise<void>[] = [];
  readonly #configure: Array<(services: ServiceCollection) => void> = [];
  readonly #singletonRoutes = new Map<RouteDef, object>();
  /** Long-lived responses to end at shutdown: stream routes' request contexts, and the runtime's cue streams. */
  readonly #streams = new Set<{ abort(reason: unknown): void }>();
  /** Private cue rooms someone asked /_yerd/cues for: warned about once each. */
  readonly #warnedRooms = new Set<string>();
  #router: Router<RouteGroup> | undefined;
  #container: Container | undefined;
  /** The container's Events, looked up once at boot: every request releases or discards what it emitted. */
  #events: Events | undefined;
  #secrets: string[] = [];
  #sessions: SessionManager | undefined;
  #sessionOptions: SessionOptions | undefined;
  readonly #middleware: Middleware[] = [];
  readonly #appGuards: GuardSpec[] = [];
  readonly #trustedOrigins: ReadonlySet<string>;
  /** Shared by every request's context; built at boot. */
  #env: RequestEnv | undefined;
  #loggingOptions: LoggingOptions = {};
  #sitemap: Sitemap | undefined;
  #onError: ((error: unknown, ctx: YerdContext) => unknown) | undefined;
  /** This app's sink and filter; set at boot. */
  #log: LogBinding | undefined;
  #started: Promise<void> | undefined;
  /** Started and not stopping: requests skip waiting on #started. */
  #running = false;
  #stopping: Promise<void> | undefined;
  #tornDown: Promise<void> | undefined;
  #lifecycle: { abort: AbortController; hosted: Promise<unknown>[]; periodic: Periodic[]; shutdown: Array<() => unknown> } | undefined;

  /**
   * Prefer {@link yerd}, which does the same. Throws if a `trustedOrigins` entry isn't a valid URL.
   *
   * ```ts
   * const app = new YerdApp({ bodyLimit: 2 * 1024 * 1024 }); // same as yerd({ ... })
   * ```
   */
  constructor(options: YerdOptions = {}) {
    this.#options = options;
    this.#trustedOrigins = new Set((options.trustedOrigins ?? []).map((o) => new URL(o).origin));
  }

  /**
   * Add a root layout, wrapping every JSX response (outside group and route
   * layouts). Call it again for more: the first call is outermost.
   *
   * ```ts
   * yerd().layout(RootLayout);
   * ```
   */
  layout(component: Component<LayoutProps>): this {
    if (this.#router) throw new Error("layout() must be called before the app starts");
    this.#layouts.push(component);
    return this;
  }

  /**
   * Turn on sessions: until this is called, `@session` and `ctx.session`
   * throw. With no options, data is sealed into the cookie (CookieStore,
   * 14 days idle, 30 at most); see SessionOptions for stores, lifetimes and
   * cookie settings. Session ids come from `generateId` when given (an id
   * store only, like MemoryStore; it may be async), else 32 random bytes.
   * Options that can't work (`generateId` with a cookie store, an invalid
   * cookie name) throw here rather than on the first request.
   *
   * ```ts
   * import { randomUUID } from "node:crypto";
   *
   * export const app = yerd().sessions({
   *   store: new MemoryStore({ maxSize: 10_000 }),
   *   generateId: () => `sess_${randomUUID()}`,
   *   maxAge: 2 * 60 * 60 * 1000, // two idle hours
   * });
   * ```
   */
  sessions(options: SessionOptions = {}): this {
    if (this.#router) throw new Error("sessions() must be called before the app starts");
    checkSessionOptions(options);
    this.#sessionOptions = options;
    return this;
  }

  /**
   * Serve a sitemap at /sitemap.xml (and, with `robots`, a /robots.txt
   * pointing at it), built from the routes: every public GET page without
   * params, plus the URLs @sitemap methods list. It's cached for `maxAge`,
   * and a build writes it into the client output when `origin` is set.
   * Bad options throw here.
   *
   * ```ts
   * yerd().sitemap({ origin: "https://shop.example", exclude: ["/api/**"], robots: true });
   * ```
   */
  sitemap(options: SitemapOptions = {}): this {
    if (this.#router) throw new Error("sitemap() must be called before the app starts");
    this.#sitemap = new Sitemap(options);
    return this;
  }

  /**
   * The sitemap's entries, with absolute URLs, as /sitemap.xml lists them:
   * for tests, or to write the file yourself. URLs start with `origin`, else
   * the one given to app.sitemap(). Boots the app without starting it:
   * call start() first if @sitemap methods need what @onBoot hooks load.
   *
   * ```ts
   * const entries = await app.sitemapEntries();
   * expect(entries.map((e) => e.loc)).toContain("https://shop.example/about");
   * ```
   */
  async sitemapEntries(origin?: string): Promise<SitemapEntry[]> {
    if (!this.#sitemap) throw new Error("sitemapEntries() needs app.sitemap() first");
    const base = origin === undefined ? this.#sitemap.origin : new URL(origin).origin;
    if (!base) throw new Error("sitemapEntries() needs an origin: pass one, or set app.sitemap({ origin })");
    await this.boot();
    return this.#sitemap.entries(base);
  }

  /**
   * Middleware around every routed request (inside guards' error handling,
   * outside guards and handlers). Accepts a function or anything with a
   * `middleware` function, like the object createAuth() returns. Several run
   * in the order added, the first outermost.
   *
   * ```ts
   * yerd().sessions().use(timing).use(auth);
   * ```
   */
  use(middleware: Middleware | { middleware: Middleware }): this {
    this.#middleware.push(typeof middleware === "function" ? middleware : middleware.middleware);
    return this;
  }

  /**
   * Guards in front of every route (and action), before group and route guards.
   *
   * ```ts
   * const readOnlyMode = createGuard("readOnlyMode", (ctx) =>
   *   ctx.method === "GET" || ctx.method === "HEAD" || new ServiceUnavailable("Read-only for a moment", { retryAfter: 60 }),
   * );
   *
   * yerd().guard(readOnlyMode);
   * ```
   */
  guard(...specs: GuardSpec[]): this {
    if (this.#router) throw new Error("guard() must be called before the app starts");
    this.#appGuards.push(...specs);
    return this;
  }

  /**
   * Serve files from `dir` under `prefix`. Routes always win; files fill the
   * URLs no route matched. Hashed filenames get long-lived immutable caching.
   *
   * ```ts
   * app.static("/", "public");
   * app.static("/src", "src", { extensions: [".css"] });
   * ```
   */
  static(prefix: string, dir: string, options?: StaticOptions): this {
    this.#mounts.push(createMount(prefix, dir, options));
    return this;
  }

  /**
   * Use a Vite client build: serve its files and resolve assetUrl() /
   * <Stylesheet> / <Styles /> through its manifest. The generated production
   * server calls this (with Vite's `base`); you rarely need to.
   *
   * `base` is where the files are served from: a path ("/app/") mounts them
   * there; a full URL (a CDN) is used for links while the files are still
   * served from "/", for the CDN to pull.
   *
   * ```ts
   * yerd().clientBuild("dist/client", "dist/client/.vite/manifest.json");
   * yerd().clientBuild("dist/client", "dist/client/.vite/manifest.json", { base: "/app/" });
   * ```
   */
  clientBuild(dir: string, manifest: string | URL, options: { base?: string } = {}): this {
    const base = publicBase(options.base);
    useManifest(manifest, base);
    // css`` rules the build collected into one stylesheet (see prerender).
    const cssList = join(dir, ".yerd", "css.json");
    if (existsSync(cssList)) useCssRecord(cssList, base);
    else resetCssBundle();
    // A build's files never change while it's served: look each one up once.
    const mount = createMount(mountPath(base), dir, {}, true);
    const list = join(dir, ".yerd", "prerendered.json");
    if (existsSync(list)) {
      const paths = JSON.parse(readFileSync(list, "utf8")) as Record<string, string>;
      const pages = createMount("/", dir, {}, true);
      for (const [path, file] of Object.entries(paths)) this.#prerendered.set(path, { mount: pages, file });
    }
    this.#mounts.push(mount);
    return this;
  }

  /**
   * Every css`` rule the app registered (its modules are all loaded by now),
   * as one hashed stylesheet in the client build, recorded in .yerd/css.json
   * for clientBuild(). Pages then link it through <Styles /> instead of
   * inlining rules. Nothing is written when the app has no css``.
   */
  #writeCssBundle(outDir: string, base: string): void {
    const text = cssBundleText();
    if (!text) {
      // No css in this app: nothing to link, whatever an earlier build in this process left.
      resetCssBundle();
      return;
    }
    const file = `assets/yerd-${cssBundleHash(text)}.css`;
    mkdirSync(join(outDir, "assets"), { recursive: true });
    mkdirSync(join(outDir, ".yerd"), { recursive: true });
    writeFileSync(join(outDir, file), text);
    // The file, not a URL: where it's served from is the running server's base.
    const record = { file, classes: cssBundleClasses() };
    writeFileSync(join(outDir, ".yerd", "css.json"), JSON.stringify(record));
    useCssBundle(base + file, record.classes);
  }

  /**
   * Render every @prerender route to `outDir` (the client build directory),
   * plus the sitemap and robots.txt when app.sitemap() has an origin. The
   * yerd Vite plugin calls this after `vite build`. Returns the paths written.
   *
   * ```ts
   * const written = await app.prerender("dist/client"); // ["/about", "/docs/intro", ...]
   * ```
   */
  async prerender(outDir: string, options: { base?: string } = {}): Promise<string[]> {
    await this.boot();
    const base = publicBase(options.base);
    this.#writeCssBundle(outDir, base);
    const allowed = this.#options.routes ? new Set(this.#options.routes) : undefined;
    const defs = routeRegistry.filter((d) => PRERENDER.from(d.metadata) && (!allowed || allowed.has(d.ctor)));
    // The sitemap is generated with the app started, as it is when served:
    // services filled in by @onBoot hooks (a catalog, say) have their data.
    const sitemap = this.#sitemap?.origin ? this.#sitemap : undefined;
    if (defs.length === 0 && !sitemap) return (await this.#sitemap?.write(outDir)) ?? [];
    const manifest = join(outDir, ".vite", "manifest.json");
    if (existsSync(manifest)) useManifest(manifest, base);

    this.#prerenderToken = randomBytes(16).toString("hex");
    const server = await this.listen(0, "127.0.0.1", { handleSignals: false });
    const written: Record<string, string> = {};
    const extra: string[] = [];
    try {
      for (const def of defs) {
        const options = PRERENDER.from(def.metadata)!;
        const pattern = resolveRoute(def).pattern;
        const hasParams = paramNames(pattern).length > 0;
        const source = options.paths;
        const paths = source === undefined
          ? hasParams ? undefined : [pattern]
          : typeof source === "function" ? await runWithServices(this.#container!, undefined, source) : source;
        if (!paths) throw new Error(`@prerender ${def.className}: ${pattern} has params, so it needs { paths: [...] }`);

        for (const path of paths) {
          // fetch() resolves dot segments (literal or %2e) and the file is written
          // at join(outDir, path), so "/blog/../../x" would render one page and
          // write it outside the build. Paths often come from content (slugs).
          if (!path.startsWith("/") || /[?#]/.test(path) || path.split("/").some((s) => /^(\.|%2e){1,2}$/i.test(s))) {
            throw new Error(`@prerender ${def.className}: ${JSON.stringify(path)} isn't a plain path (it must start with "/", with no . or .. segments, query or fragment)`);
          }
          const match = this.#router!.match(path);
          if (!match || ![...match.handlers.values()].some((g) => g.handlers.some((h) => h.def === def))) {
            throw new Error(`@prerender ${def.className}: ${path} doesn't match ${pattern}`);
          }
          this.#prerenderErrors.delete(path);
          const response = await fetch(server.url + path, {
            headers: { accept: "text/html,*/*;q=0.1", "x-yerd-prerender": this.#prerenderToken },
            redirect: "manual",
          });
          if (response.status !== 200) {
            const reason = this.#prerenderErrors.get(path) ?? (response.headers.get("location") ? `redirects to ${response.headers.get("location")}` : await response.text());
            throw new Error(`@prerender ${def.className} ${path}: HTTP ${response.status}: ${reason}`);
          }
          const html = (response.headers.get("content-type") ?? "").startsWith("text/html");
          let file: string;
          if (html) file = path === "/" ? "index.html" : `${path.slice(1).replace(/\/$/, "")}/index.html`;
          else if (extname(path)) file = path.slice(1);
          else throw new Error(`@prerender ${def.className} ${path}: non-HTML output needs a file extension in the path (e.g. ${path}.json) so it's served with the right type`);
          const target = join(outDir, file);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, Buffer.from(await response.arrayBuffer()));
          written[path] = file;
        }
      }
      if (defs.length > 0) {
        await mkdir(join(outDir, ".yerd"), { recursive: true });
        await writeFile(join(outDir, ".yerd", "prerendered.json"), JSON.stringify(written, null, 2));
      }
      if (sitemap) extra.push(...(await sitemap.write(outDir)));
    } finally {
      this.#prerenderToken = undefined;
      await server.close();
    }
    return [...Object.keys(written), ...extra];
  }

  /**
   * Logging setup. The sink is the ILogger service if one is registered, else
   * yerd's ConsoleLogger. Every request gets a root span (request id, trace
   * id) and one access log line at `yerd::request`.
   *
   * ```ts
   * yerd().logging({ filter: "info,UserRepo=debug", format: "json" });
   * ```
   */
  logging(options: LoggingOptions): this {
    if (this.#router) throw new Error("logging() must be called before the app starts");
    this.#loggingOptions = options;
    return this;
  }

  /**
   * Handle any error a route's own @catches didn't: return a response (JSX
   * renders in the root layouts, and keeps the error's status unless you
   * return `res(..., { status })` or a number), or undefined for the error
   * page. Sees 404s and other errors that never reached a handler too.
   *
   * ```ts
   * app.onError((error) => error instanceof DbDown ? res(<Maintenance />, { status: 503 }) : undefined);
   * ```
   */
  onError(handler: (error: unknown, ctx: YerdContext) => unknown): this {
    if (this.#router) throw new Error("onError() must be called before the app starts");
    this.#onError = handler;
    return this;
  }

  /**
   * Render errors (404s, thrown YerdErrors, crashes) as an HTML page inside the
   * root layouts, for requests that accept HTML. API clients still get text or
   * JSON. Internal error messages are never shown.
   *
   * ```tsx
   * function ErrorPage({ status, message }: ErrorPageProps) {
   *   return <main><h1>{status}</h1><p>{message}</p></main>;
   * }
   *
   * yerd().layout(RootLayout).errorPage(ErrorPage);
   * ```
   */
  errorPage(component: Component<ErrorPageProps>): this {
    if (this.#router) throw new Error("errorPage() must be called before the app starts");
    this.#errorPage = component;
    return this;
  }

  /**
   * The error page for page requests (text or JSON otherwise). Its first
   * chunk is rendered here, so an error page that fails itself becomes the
   * plain error instead of a cut-off response.
   */
  async #errorOut(error: unknown, context: RequestContext): Promise<Outgoing> {
    const plain = errorResponse(error);
    const req = context.req;
    const accept = req.headers.accept ?? "";
    if (!this.#errorPage || !accept.includes("text/html") || req.headers["yx"] !== undefined) return plain;
    const message =
      error instanceof YerdError && error.expose ? error.message : statusText(plain.status);
    try {
      const page = await coerce(jsx(this.#errorPage, { status: plain.status, message, error } satisfies ErrorPageProps), {
        layouts: this.#layouts,
        meta: { ...context.meta, title: message },
      });
      return await this.#prime({ ...page, status: plain.status });
    } catch (renderError) {
      requestLog.error("the error page itself failed", { error: renderError });
      return plain;
    }
  }

  /**
   * Register services in code: tokens, third-party classes, factories, test
   * fakes. These override @service registrations for the same key.
   *
   * ```ts
   * app.services((s) => s.singleton(Mailer, SmtpMailer).scoped(Db, (c) => c.get(Pool).connect()));
   * ```
   */
  services(configure: (services: ServiceCollection) => void): this {
    if (this.#router) throw new Error("services() must be called before the app starts");
    this.#configure.push(configure);
    return this;
  }

  /**
   * Import route modules so their decorators register. Accepts a directory URL
   * (every .js file under it, recursively) or the object returned by
   * `import.meta.glob(..., { eager: true })`, whose modules are already loaded.
   *
   * ```ts
   * yerd().discover(import.meta.glob("./routes/*.tsx", { eager: true })); // with Vite
   * yerd().discover(new URL("./routes/", import.meta.url));             // compiled with tsc, recursive
   * ```
   */
  discover(source: URL | Record<string, unknown>): this {
    if (source instanceof URL) this.#pending.push(importDirectory(source));
    return this;
  }

  /**
   * Forget every registered route, service, guard and custom attribute, in
   * the copy of yerd this app comes from. For dev servers between reloads
   * (the Vite plugin calls it): a bundler may load yerd once for the app's
   * code and again for its own, so the app is the reliable way to reach the
   * registries the routes actually wrote to.
   *
   * ```ts
   * app.resetRegistries();
   * await import(`./routes/index.js?t=${Date.now()}`); // re-registers into a clean slate
   * ```
   */
  resetRegistries(): void {
    resetRouteRegistry();
    resetServiceRegistry();
    resetGuardRegistry();
    resetAttributeRegistry();
    resetLazyElements();
    // Rules re-register as the modules re-run: an edited or removed css.global doesn't linger.
    resetCss();
  }

  /**
   * The DI container. Available after boot(); throws before. Inside a
   * request, prefer @inject or resolve().
   *
   * ```ts
   * await app.boot();
   * const mailer = app.container.get(Mailer);
   * ```
   */
  get container(): Container {
    if (!this.#container) throw new Error("The app hasn't booted yet");
    return this.#container;
  }

  /**
   * Run `fn` inside a fresh DI scope (scoped services resolve), disposed
   * afterwards. For scripts and tests. Boots the app, but doesn't start it:
   * no @onBoot hooks run unless you call start() first.
   *
   * ```ts
   * const todos = await app.scope(() => resolve(Db).todos.all());
   * ```
   */
  async scope<T>(fn: () => T | Promise<T>): Promise<T> {
    await this.boot();
    const scope = new Scope();
    try {
      return await runWithServices(this.#container!, scope, fn);
    } finally {
      await scope.dispose();
    }
  }

  /**
   * Build the route table and the container, and validate both, throwing a
   * BootError that lists every problem. Runs once; later calls are no-ops.
   * One test that boots the app catches wiring mistakes before a deploy.
   *
   * ```ts
   * it("boots", async () => {
   *   await app.boot();
   * });
   * ```
   */
  async boot(): Promise<void> {
    if (this.#router) return;
    await Promise.all(this.#pending);
    if (this.#router) return;

    const problems: string[] = [];
    const container = new Container();
    const allowedServices = this.#options.services ? new Set(this.#options.services) : undefined;
    // Built-ins first, so @service classes and app.services() can override them.
    container.register({
      key: Channels,
      lifetime: "singleton",
      impl: Channels,
      create: (c) => c.construct(Channels, undefined, "singleton"),
    });
    container.register({
      key: Cues,
      lifetime: "singleton",
      impl: Cues,
      create: (c) => c.construct(Cues, undefined, "singleton"),
    });
    container.register({
      key: Events,
      lifetime: "singleton",
      create: (c) => new Events(c.registration(EventTransport) ? c.get(EventTransport) : undefined),
    });
    container.register({ key: Logger, lifetime: "singleton", create: () => new Logger("app") });
    const services = serviceRegistry.filter((d) => !allowedServices || allowedServices.has(d.cls));
    for (const def of services) container.register(registrationFor(def));
    const collection = new ServiceCollection((r: Registration) => container.register(r));
    for (const configure of this.#configure) configure(collection);

    const allowedRoutes = this.#options.routes ? new Set(this.#options.routes) : undefined;
    const defs = routeRegistry.filter((d) => !allowedRoutes || allowedRoutes.has(d.ctor));
    const router = new Router<RouteGroup>();
    const groups = new Map<string, Map<Verb, Handler[]>>();
    const referencedGuards: Array<[where: string, name: string]> = [];
    const mapped: MappedRoute[] = [];

    for (const def of defs) {
      let resolved;
      try {
        resolved = resolveRoute(def);
      } catch (e) {
        problems.push(`${def.className}: ${(e as Error).message}`);
        continue;
      }
      const info: RouteInfo = { pattern: resolved.pattern, paramNames: paramNames(resolved.pattern), className: def.className, session: resolved.session };
      const lifetime = lifetimeOf({ lifetime: def.options.lifetime, metadata: def.metadata }, "scoped");
      if (this.#sitemap) mapped.push({ def, pattern: info.pattern, lifetime, sitemap: resolved.sitemap });
      const verbs = VERBS.from(def.metadata) ?? [];
      if (verbs.length === 0) problems.push(`${def.className} (${info.pattern}) has no verb methods (@get, @post, ...)`);

      for (const accessor of ACCESSORS.from(def.metadata) ?? []) {
        const message = accessor.validate?.(info, ...(accessor.args as never[]));
        if (message) problems.push(`${def.className}.${accessor.field} (@${accessor.name}): ${message}`);
      }
      const argsByMethod = ARGS.from(def.metadata);
      for (const [method, resolvers] of argsByMethod ?? []) {
        resolvers.forEach((resolver, i) => {
          const message = resolver.validate?.(info, ...(resolver.args as never[]));
          if (message) problems.push(`${def.className}.${String(method)} @args[${i}] (@${resolver.name}): ${message}`);
        });
      }
      checkInjections(def.className, lifetime, def.metadata, container, problems);
      for (const hookKey of [ON_BOOT, ON_SHUTDOWN, EVERY]) {
        if ((hookKey.from(def.metadata) ?? []).length > 0) {
          problems.push(`${def.className}: lifecycle hooks (@onBoot, @onShutdown, @every) belong on singleton services, not routes`);
          break;
        }
      }

      const layouts = resolved.isolated ? resolved.layouts : joinLayouts(this.#layouts, resolved.layouts);
      const methodLayouts = METHOD_LAYOUTS.from(def.metadata);
      const classGuards = [...this.#appGuards, ...resolved.guards, ...(CLASS_GUARDS.from(def.metadata) ?? [])];
      // Actions run behind the class's guards plus their own method guards.
      for (const name of ACTIONS.from(def.metadata)?.keys() ?? []) {
        for (const spec of [...classGuards, ...(METHOD_GUARDS.from(def.metadata)?.get(name) ?? [])]) {
          if (typeof spec === "string") referencedGuards.push([`${def.className}.${name}`, spec]);
        }
      }
      const bareMethods = NO_LAYOUT.from(def.metadata);
      const acceptsByMethod = ACCEPTS.from(def.metadata);
      for (const { verb, method, when } of verbs) {
        const byVerb = groups.get(info.pattern) ?? new Map<Verb, Handler[]>();
        groups.set(info.pattern, byVerb);
        const group = byVerb.get(verb) ?? [];
        byVerb.set(verb, group);
        const accepts = acceptsByMethod?.get(method)?.map(expandType);
        const label = `${def.className}.${String(method)}`;
        // `@get(when)` variants sit beside the default; only plain handlers can clash.
        if (!when && !accepts && group.some((h) => !h.accepts && !h.when)) {
          const other = group.find((h) => !h.accepts && !h.when)!;
          problems.push(`Duplicate route: ${verb} ${info.pattern} (${label} and ${other.def.className}.${String(other.method)}; give one of them @accepts)`);
          continue;
        }
        const clash = !when && accepts && group.find((h) => !h.when && h.accepts?.some((t) => accepts.includes(t)));
        if (clash) {
          problems.push(`${label} and ${clash.def.className}.${String(clash.method)} both @accepts the same type for ${verb} ${info.pattern}`);
          continue;
        }
        group.push({
          def, lifetime, method, info,
          layouts: bareMethods?.has(method) ? [] : applyLayouts(layouts, methodLayouts?.get(method)),
          meta: resolved.meta,
          args: argsByMethod?.get(method),
          accepts,
          guards: [...classGuards, ...(METHOD_GUARDS.from(def.metadata)?.get(method) ?? [])],
          classGuards,
          when,
          runs: [],
          declared: METHOD_RESPONSE.from(def.metadata)?.get(method),
          catches: CATCHES.from(def.metadata) ?? [],
        });
      }
    }

    // Named guards: each @guard method belongs to a service. Only this app's
    // services count (the registry is process-wide), and a guard declared on a
    // base class works through a registered subclass.
    const namedGuards = new Map<string, GuardRun>();
    const registrations = [...container.registrations()];
    for (const named of guardRegistry) {
      const registration = registrations.find((r) => r.impl && metadataChain(r.impl).includes(named.metadata));
      if (!registration) continue;
      if (namedGuards.has(named.name)) {
        problems.push(`Duplicate guard name "${named.name}"`);
        continue;
      }
      const key = registration.key;
      namedGuards.set(named.name, (ctx) => {
        const instance = container.get(key, currentServices()?.scope) as Record<string | symbol, (ctx: YerdContext) => unknown>;
        return instance[named.method]!.call(instance, ctx);
      });
    }

    // Each handler's and action's guards, resolved to functions once every named guard is known.
    const pendingRuns: Array<[GuardRun[], readonly GuardSpec[]]> = [];
    for (const [pattern, byVerb] of groups) {
      const node = routeNode(byVerb, pendingRuns);
      for (const [verb, group] of byVerb) {
        for (const handler of group) {
          for (const spec of handler.guards) {
            if (typeof spec === "string") referencedGuards.push([`${handler.def.className}.${String(handler.method)}`, spec]);
          }
          pendingRuns.push([handler.runs, handler.guards]);
        }
        try {
          router.add(pattern, verb, routeGroup(group, node));
        } catch (e) {
          problems.push(`${group[0]!.def.className}: ${(e as Error).message}`);
        }
      }
    }

    const answering = new Map<string, string>();
    for (const registration of container.registrations()) {
      if (!registration.impl) continue;
      const metadata = metadataOf(registration.impl);
      const name = registration.impl.name || keyName(registration.key);
      checkInjections(name, registration.lifetime, metadata, container, problems);
      if (registration.lifetime !== "singleton") {
        for (const hookKey of [ON_BOOT, ON_SHUTDOWN, EVERY, ON_EVENT, HANDLES]) {
          if ((hookKey.from(metadata) ?? []).length > 0) {
            problems.push(`${name} (${registration.lifetime}): @onBoot, @onShutdown, @every, @on and @handles need a singleton service`);
            break;
          }
        }
      }
      for (const { type, method } of HANDLES.from(metadata) ?? []) {
        const call = eventName(type);
        const other = answering.get(call);
        if (other) problems.push(`${call} is answered twice: by ${other} and ${name}.${String(method)} (a call has one @handles)`);
        else answering.set(call, `${name}.${String(method)}`);
      }
    }

    for (const spec of this.#appGuards) if (typeof spec === "string") referencedGuards.push(["app.guard()", spec]);
    const unknown = new Set<string>();
    for (const [where, name] of referencedGuards) {
      if (namedGuards.has(name) || unknown.has(`${where}:${name}`)) continue;
      unknown.add(`${where}:${name}`);
      const elsewhere = guardRegistry.some((g) => g.name === name);
      problems.push(`${where}: unknown guard "${name}"${elsewhere ? " (its @guard class isn't one of this app's services)" : ""}`);
    }

    let filter: LogFilter | undefined;
    try {
      // YERD_LOG wins over code, so a deploy can turn logging up or down without a rebuild.
      filter = new LogFilter(process.env.YERD_LOG ?? this.#loggingOptions.filter ?? defaultFilter());
    } catch (error) {
      problems.push((error as Error).message);
    }
    const redact: string[][] = [];
    for (const path of this.#loggingOptions.redact ?? []) {
      try {
        redact.push(compilePath(path));
      } catch (error) {
        problems.push(`logging({ redact }): ${(error as Error).message}`);
      }
    }
    const sinkRegistration = container.registration(ILogger);
    if (sinkRegistration && sinkRegistration.lifetime !== "singleton") problems.push("ILogger must be a singleton service");

    if (problems.length > 0) throw new BootError(problems);
    const envFormat = process.env.YERD_LOG_FORMAT;
    const format = envFormat === "pretty" || envFormat === "json" ? envFormat : this.#loggingOptions.format;
    const sink = sinkRegistration ? container.get(ILogger) : new ConsoleLogger({ format });
    this.#log = { sink, filter: filter!, redact: redact.length ? redact : undefined };
    bindLogging(container, this.#log);
    for (const [runs, specs] of pendingRuns) {
      for (const spec of specs) runs.push(isGuardRef(spec) ? (ctx) => spec.run(ctx) : namedGuards.get(spec)!);
    }
    this.#secrets = resolveSecrets(this.#options.secret);
    if (this.#sessionOptions) {
      const options = { trustProxy: this.#options.trustProxy, ...this.#sessionOptions };
      this.#sessions = new SessionManager(options, this.#secrets);
    }
    this.#env = {
      secrets: this.#secrets,
      bodyLimit: this.#options.bodyLimit ?? DEFAULT_BODY_LIMIT,
      sessions: this.#sessions,
      container,
      actionTtl: this.#options.actionTtl ?? 86_400,
      trustProxy: this.#options.trustProxy ?? false,
    };
    this.#container = container;
    this.#router = router;
    this.#sitemap?.attach(mapped.map((m) => this.#sitemapRoute(m, groups.get(m.pattern)?.get("GET") ?? [])), (fn) => this.scope(fn));
    this.#events = container.get(Events);
    this.#events.wireWith(() => this.#wireEvents(container));
  }

  /**
   * Subscribe every singleton service's @on and @handles methods. Runs once:
   * at start, or on the bus's first use before that (a script in app.scope(),
   * a test calling app.request()), so events never go unheard just because
   * the app wasn't started.
   */
  #wireEvents(container: Container): void {
    const events = container.get(Events);
    for (const registration of container.registrations()) {
      if (!registration.impl || registration.lifetime !== "singleton") continue;
      const metadata = metadataOf(registration.impl);
      const ons = ON_EVENT.from(metadata) ?? [];
      const answers = HANDLES.from(metadata) ?? [];
      if (!ons.length && !answers.length) continue;
      const instance = runWithServices(container, undefined, () => container.get(registration.key)) as object;
      events.wire(container, instance, registration.impl.name, ons, answers);
    }
  }

  /**
   * Boot, run @onBoot hooks, start @hosted services and @every timers.
   * listen() calls this; call it yourself to run background work without HTTP.
   *
   * ```ts
   * // worker.ts: @hosted services and @every jobs, no server
   * const worker = yerd({ routes: [] });
   * await worker.start();
   * process.on("SIGTERM", async () => {
   *   await worker.stop();
   *   process.exit(0);
   * });
   * ```
   */
  start(): Promise<void> {
    if (this.#stopping) return Promise.reject(new Error("This app was stopped; create a new one to start again"));
    // A failed start tears down whatever it got running (timers, hosted
    // services, singletons) and stays failed: there's no half-started app.
    this.#started ??= this.#start().then(
      () => {
        this.#running = this.#stopping === undefined;
      },
      async (error) => {
        // The start failure is the error to report; a cleanup failure is only logged.
        await this.#teardown().catch((cleanup: unknown) => lifecycleLog.error("cleaning up after a failed start failed", { error: cleanup }));
        throw error;
      },
    );
    return this.#started;
  }

  async #start(): Promise<void> {
    await this.boot();
    const container = this.#container!;
    const abort = new AbortController();
    const lifecycle = { abort, hosted: [] as Promise<unknown>[], periodic: [] as Periodic[], shutdown: [] as Array<() => unknown> };
    this.#lifecycle = lifecycle;

    const allowed = this.#options.services ? new Set(this.#options.services) : undefined;
    const defs = serviceRegistry.filter((d) => !allowed || allowed.has(d.cls));
    const singletons = [...container.registrations()].filter((r) => r.impl && r.lifetime === "singleton");

    // Event handlers subscribe now, if nothing has used the bus yet (see #wireEvents).
    container.get(Events).subscribeHandlers();
    await runWithServices(container, undefined, async () => {
      for (const registration of singletons) {
        const metadata = metadataOf(registration.impl!);
        const boot = ON_BOOT.from(metadata) ?? [];
        const shutdown = ON_SHUTDOWN.from(metadata) ?? [];
        const periodic = EVERY.from(metadata) ?? [];
        if (boot.length === 0 && shutdown.length === 0 && periodic.length === 0) continue;
        const instance = container.get(registration.key) as Record<string | symbol, (...a: unknown[]) => unknown>;
        for (const method of boot) await instance[method]!.call(instance);
        for (const method of shutdown) lifecycle.shutdown.push(() => instance[method]!.call(instance));
        for (const { method, ms, immediate } of periodic) {
          const label = `${registration.impl!.name}.${String(method)}`;
          lifecycle.periodic.push(startPeriodic((signal) => instance[method]!.call(instance, signal), ms, immediate, abort.signal, label));
        }
      }
      for (const def of defs.filter((d) => d.hosted)) {
        const instance = container.get(def.provides) as HostedService;
        lifecycle.hosted.push(
          Promise.resolve()
            .then(() => instance.run(abort.signal))
            .catch((error) => lifecycleLog.error(`hosted service ${def.className} failed`, { error })),
        );
      }
    });
  }

  /**
   * Stop background work, end long-lived streams, run @onShutdown hooks
   * (newest first) and dispose singletons. Waits for a start that's still in
   * progress. An app can't be started again after it stops. Use it for an
   * app you start()ed yourself; a listen()ing app stops through close().
   *
   * ```ts
   * // A one-off script: run with @onBoot hooks done, then dispose everything.
   * await app.start();
   * await app.scope(() => resolve(Reports).sendNightly());
   * await app.stop();
   * ```
   */
  stop(): Promise<void> {
    this.#running = false;
    this.#stopping ??= (async () => {
      await this.#started?.catch(() => {});
      await this.#teardown();
    })();
    return this.#stopping;
  }

  #teardown(): Promise<void> {
    this.#tornDown ??= this.#stop();
    return this.#tornDown;
  }

  async #stop(): Promise<void> {
    const lifecycle = this.#lifecycle;
    const timeout = this.#options.shutdownTimeout ?? DEFAULT_SHUTDOWN_MS;
    for (const stream of this.#streams) stream.abort(new Error("server shutting down"));
    if (lifecycle) {
      lifecycle.abort.abort();
      const events = this.#container?.get(Events);
      const background = Promise.all([...lifecycle.hosted, ...lifecycle.periodic.map((p) => p.stop()), events?.stop(timeout)]);
      if (!(await withTimeout(background, timeout))) {
        lifecycleLog.warn(`background work didn't stop within ${timeout}ms; continuing shutdown`);
      }
      const container = this.#container!;
      await runWithServices(container, undefined, async () => {
        for (const hook of lifecycle.shutdown.reverse()) {
          try {
            await hook();
          } catch (error) {
            lifecycleLog.error("@onShutdown hook failed", { error });
          }
        }
      });
    }
    try {
      await this.#container?.dispose();
    } finally {
      // Even when a service fails to dispose: the sink may hold that very error.
      try {
        await this.#log?.sink.flush?.();
      } catch {
        // nowhere left to report it
      }
    }
  }

  /**
   * A route as the sitemap sees it. Its page is the GET handler that can
   * answer HTML (not an @sse / @ndjson stream, not @accepts without HTML),
   * preferring plain handlers over `@get(when)` variants; it counts as
   * guarded when that handler has guards beyond the app's own, which sit in
   * front of every route and say nothing about whether a page is public.
   */
  #sitemapRoute({ def, pattern, lifetime, sitemap }: MappedRoute, gets: readonly Handler[]): SitemapRoute {
    const streaming = STREAMING.from(def.metadata);
    const html = gets.filter(
      (h) => h.def === def && !streaming?.has(h.method) && (!h.accepts || h.accepts.some((t) => t === "text/html" || t === "text/*" || t === "*/*")),
    );
    const plain = html.filter((h) => !h.when);
    const page = plain.length > 0 ? plain : html;
    const method = SITEMAP.from(def.metadata);
    return {
      className: def.className,
      pattern,
      settings: sitemap,
      optedIn: typeof def.options.sitemap === "object",
      page: page.length > 0,
      guarded: !page.some((h) => h.guards.length === this.#appGuards.length),
      items:
        method === undefined
          ? undefined
          : () => {
              const instance = this.#routeInstance({ def, lifetime }, currentServices()!.scope!);
              const fn = instance[method];
              if (typeof fn !== "function") throw new Error(`${def.className}.${String(method)} (@sitemap) is not a method`);
              return (fn as () => unknown).call(instance);
            },
      paths: PRERENDER.from(def.metadata)?.paths,
    };
  }

  #routeInstance(handler: Pick<Handler, "def" | "lifetime">, scope: Scope): Record<string | symbol, unknown> {
    const container = this.#container!;
    const ctor = handler.def.ctor;
    if (handler.lifetime === "singleton") {
      let instance = this.#singletonRoutes.get(handler.def);
      if (!instance) {
        instance = container.construct(ctor, undefined, "singleton");
        this.#singletonRoutes.set(handler.def, instance);
      }
      return instance as Record<string | symbol, unknown>;
    }
    return container.construct(ctor, scope, handler.lifetime) as Record<string | symbol, unknown>;
  }

  /**
   * Answer a fetch Request in this process: the whole pipeline (middleware,
   * sessions, guards, actions, error pages, streaming), no HTTP server or
   * port. Resolves when the response starts, so streams can be read as they
   * go. Also the handler for runtimes that speak fetch.
   *
   * ```ts
   * const res = await app.fetch(new Request("http://localhost/todos", { headers: { accept: "application/json" } }));
   * ```
   */
  fetch = (request: Request): Promise<Response> => answer(this.handle, request);

  /**
   * app.fetch() for tests: a path (resolved against http://localhost) or a
   * URL, and fetch's options. Cookies are up to you: send them in
   * `headers.cookie`, read them from `res.headers.getSetCookie()`.
   *
   * ```ts
   * const app = yerd({ routes: [Todos], services: [] });
   * const res = await app.request("/todos", { method: "POST", body: JSON.stringify({ title: "milk" }), headers: { "content-type": "application/json" } });
   * expect(res.status).toBe(201);
   * ```
   */
  request(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? new Request(input, init) : new Request(new URL(input, "http://localhost"), init);
    return this.fetch(request);
  }

  /**
   * A test client over app.fetch(): keeps cookies between requests (sessions,
   * sign-in), sends a same-origin Origin on writes, and can submit the action
   * forms a page rendered.
   *
   * ```ts
   * const client = app.client();
   * await client.action("/login", { name: "ada", password: "secret" });
   * expect(await client.page("/account")).toContain("Signed in as ada");
   * ```
   */
  client(base = "http://localhost"): TestClient {
    return new TestClient(this.fetch, base);
  }

  /**
   * Node request handler. With `next` (connect-style middleware, e.g. Vite's
   * dev server), unmatched paths are passed on instead of answered with 404.
   * Starts the app on the first request. Prefer listen() for a server of
   * your own: it adds graceful shutdown.
   *
   * ```ts
   * import { createServer } from "node:http";
   *
   * createServer(app.handle).listen(3000);
   * ```
   */
  handle = async (req: IncomingMessage, res: ServerResponse, next?: Next): Promise<void> => {
    // Started once; after that a request doesn't wait on the start promise.
    if (!this.#running) {
      try {
        await this.start();
      } catch (e) {
        if (next) return next(e);
        throw e;
      }
    }
    // The request's root span: request id, trace context, and on the way
    // out the access log line. Nothing is created when request logging is off.
    const span = startRequestSpan(this.#log!, req, req.method ?? "GET", splitTarget(req.url ?? "/").path);
    if (!span) return this.#serve(req, res, next);
    (req as unknown as Record<symbol, unknown>)[REQUEST_SPAN] = span;
    res.setHeader("x-request-id", span.id);
    try {
      await this.#serve(req, res, next);
    } finally {
      endRequestSpan(this.#log!, span, res.statusCode);
    }
  };

  /** Built-in endpoints, prerendered files and static mounts, then routing. */
  async #serve(req: IncomingMessage, res: ServerResponse, next: Next | undefined): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase() as Verb;
    // The usual "/path?query" is split by hand; absolute-form targets (proxies) go through URL.
    const rawTarget = req.url ?? "/";
    let target: { path: string; search: string };
    if (rawTarget.startsWith("/")) {
      target = splitTarget(rawTarget);
    } else if (rawTarget === "*" && method === "OPTIONS") {
      // `OPTIONS *` asks about the server as a whole (scanners love it).
      return send(res, { status: 204, headers: { allow: "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS" }, body: null }, false, undefined);
    } else {
      try {
        const parsed = new URL(rawTarget);
        target = { path: parsed.pathname, search: parsed.search };
      } catch {
        return send(res, errorResponse(new BadRequest()), method === "HEAD", undefined);
      }
    }
    const path = target.path;
    const reading = method === "GET" || method === "HEAD";

    if (path === RUNTIME_PATH && reading) return send(res, runtimeResponse(req), method === "HEAD", undefined);
    // Its chunks, beside it (/_yerd/runtime-<name>.js). A name that isn't one is a 404 here, not a route's.
    if (reading && path.startsWith(RUNTIME_CHUNK_PREFIX) && path.endsWith(".js")) {
      return send(res, chunkResponse(req, path.slice(RUNTIME_CHUNK_PREFIX.length, -3), target.search), method === "HEAD", undefined);
    }
    // The server's clock, for pages lining up `sync` animations and cues.
    if (path === CLOCK_PATH && reading) {
      const body = JSON.stringify({ now: Date.now() });
      return send(res, { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body }, method === "HEAD", undefined);
    }
    if (path === CUES_PATH && method === "GET") return this.#serveCues(res, target.search);
    // The sitemap and robots.txt, when app.sitemap() turned them on.
    if (reading && this.#sitemap?.handles(path)) {
      const out = await this.#sitemap.serve(req, path, this.#options.trustProxy ?? false);
      if (out) return send(res, out, method === "HEAD", undefined);
    }

    // Prerendered at build time: the file, not the handler. The runtime's own
    // requests go to the handler: `yx-dynamic` fills <Dynamic> parts, and a
    // boosted navigation or refresh wants the page whole, not its skeletons.
    const prebuilt =
      reading &&
      this.#prerendered.size > 0 &&
      this.#prerenderToken === undefined &&
      req.headers["yx-dynamic"] === undefined &&
      req.headers["yx-boost"] === undefined
        ? this.#prerendered.get(path)
        : undefined;
    if (prebuilt) {
      const file = await serveStatic(prebuilt.mount, `/${prebuilt.file}`, conditional(req), method === "HEAD");
      if (file) return sendFile(res, file, method === "HEAD");
    }

    const match = this.#router!.match(path);

    if (!match) {
      if (reading && this.#mounts.length > 0) {
        const headers = conditional(req);
        for (const mount of this.#mounts) {
          const file = await serveStatic(mount, path, headers, method === "HEAD");
          if (file) return sendFile(res, file, method === "HEAD");
        }
      }
      if (next) return next();
      return this.#sendError(new NotFound(), req, res, target, method);
    }

    if (this.#options.csrf !== false && UNSAFE_METHODS.has(method)) {
      const refused = crossSiteReason(req, this.#trustedOrigins, this.#options.trustProxy ?? false);
      if (refused) return this.#sendError(new Forbidden(refused), req, res, target, method, { refused: true });
    }

    const routed = resolveRequest(match.handlers, method, req.headers);
    if (routed.error) return this.#sendError(routed.error, req, res, target, method);

    const base = routed.handler ?? routed.group?.variants[0] ?? routed.node.first;
    const prerendering = this.#prerenderToken !== undefined && req.headers["x-yerd-prerender"] === this.#prerenderToken;
    const scope = new Scope();
    const context = new RequestContext({ req, res, target, method, params: match.params, route: base.info, meta: { ...base.meta }, prerendering, scope, env: this.#env! });
    try {
      // One async context for the whole request and its DI scope (currentServices() reads context.services).
      await runWithContext(context, () => this.#answer(context, routed, base));
    } finally {
      if (!scope.isEmpty) {
        try {
          await scope.dispose();
        } catch (error) {
          requestLog.error("failed to dispose request services", { error });
        }
      }
    }
  }

  /** A routed request, inside its context: the session, middleware, the handler or action, and the answer sent. */
  async #answer(context: RequestContext, routed: Routed, base: Handler): Promise<void> {
    let out: Outgoing;
    let failed = false;
    // A crash (not a YerdError) skips the session commit, so a half-done
    // login or update doesn't stick.
    let crashed = false;
    try {
      // The session opens on first use, synchronously. A store that may answer
      // asynchronously can't be read then, so its read starts here, the moment
      // the route is known (a `session: false` route never starts it), and
      // middleware waits for it. Nothing to wait for otherwise.
      const reading = context.readsUpFront();
      if (reading) await reading;
      out = await this.#runMiddleware(context, () => this.#run(context, routed));
      // Whichever handler answered, the response depended on what the variants' tests read.
      if (routed.group?.vary) out.headers.vary = mergeVary(out.headers.vary, routed.group.vary);
      // Render up to the first chunk now, so an error at the top of the page
      // (a layout, an early component) still becomes the error page.
      out = await this.#prime(out);
      // The handler succeeded: what it emitted goes out now (see Events).
      this.#events!.release(context);
    } catch (error) {
      this.#events!.discard(context);
      if (context.prerendering) this.#prerenderErrors.set(context.path, error instanceof Error ? error.message : String(error));
      failed = true;
      ({ out, crashed } = await this.#failure(error, base, context));
    }
    out = await this.#finalize(context, out, { failed, commit: !crashed });
    const longLived = out.headers[LONG_LIVED] !== undefined;
    if (longLived) this.#streams.add(context);
    try {
      // Only streams need the abort signal (client gone, shutdown); plain bodies skip creating one.
      await send(context.res, out, context.method === "HEAD", isStreamBody(out.body) ? context.signal : undefined);
    } finally {
      if (longLived) this.#streams.delete(context);
    }
  }

  /** What runs inside middleware: a posted action, else the handler (a `@get(when)` variant or the default). */
  async #run(context: RequestContext, routed: Routed): Promise<Outgoing> {
    if (routed.mayBeAction) {
      const fromAction = await this.#dispatchAction(routed.node, context);
      if (fromAction) return fromAction;
    }
    const { group, handler } = routed;
    const variants = group?.variants ?? [];
    // The first `@get(when)` variant whose test passes serves the request;
    // otherwise the default does. Prerendering has no request to test.
    let chosen = handler;
    if (variants.length > 0 && !context.prerendering) {
      const accept = context.req.headers.accept;
      // An @accepts variant needs the type asked for by name while something
      // else could answer: a browser's `*/*;q=0.8` mustn't pick the JSON one.
      const fallback = handler !== undefined || group!.variantFallback;
      for (const variant of variants) {
        if (variant.accepts && choose([variant.accepts], accept, fallback) !== 0) continue;
        if (await this.#matches(variant.when!.test, context)) {
          chosen = variant;
          break;
        }
      }
    }
    if (!chosen) throw variants.length > 0 ? new NotFound() : new MethodNotAllowed(undefined, { allow: routed.node.allow });
    const serving = chosen;
    const invoked = await this.#invoke(context, serving, serving, () => (serving.args ? Promise.all(serving.args.map((r) => r.resolve(context))) : []));
    if (invoked.blocked) return invoked.blocked;
    const out = await coerce(invoked.result, { layouts: serving.layouts, meta: context.meta, dynamic: dynamicOf(context), accept: context.req.headers.accept });
    if (group?.negotiated) out.headers.vary = mergeVary(out.headers.vary, "accept");
    return out;
  }

  /**
   * Run a handler or an action: its guards, then the method on the route
   * instance with the arguments `args` makes (only once the guards let the
   * request through). A guard's own answer when one turns it away, else
   * what the method returned, not yet coerced.
   */
  async #invoke(context: RequestContext, owner: Handler, call: Call, args: () => unknown[] | Promise<unknown[]>): Promise<Invoked> {
    if (call.runs.length > 0) {
      const blocked = await this.#runGuards(call.runs, owner.layouts, context);
      if (blocked) return { blocked };
    }
    context.declared = call.declared;
    const instance = this.#routeInstance(owner, context.services.scope);
    const fn = instance[call.method] as ((...args: unknown[]) => unknown) | undefined;
    if (typeof fn !== "function") throw new Error(`${owner.def.className}.${String(call.method)} is not a method`);
    return { result: await fn.apply(instance, await args()) };
  }

  /** The runtime's cue stream: `GET /_yerd/cues?room=a&room=b` (no room: the default one). */
  async #serveCues(res: ServerResponse, search: string): Promise<void> {
    const asked = new URLSearchParams(search).getAll("room");
    const rooms = asked.length ? [...new Set(asked)] : [DEFAULT_ROOM];
    if (rooms.length > 32 || !rooms.every(validRoom)) return send(res, errorResponse(new BadRequest()), false, undefined);
    const closed = rooms.filter((room) => !isPublicRoom(this.#options.cues?.public, room));
    if (closed.length) {
      for (const room of closed) {
        if (this.#warnedRooms.has(room) || this.#warnedRooms.size > 100) continue;
        this.#warnedRooms.add(room);
        cueLog.warn(`cue room ${JSON.stringify(room)} isn't public, so /_yerd/cues refused it: list it in yerd({ cues: { public } }), or serve it from your own @sse route (cues.listen) and point the elements at it with cueFrom`);
      }
      return send(res, errorResponse(new Forbidden()), false, undefined);
    }
    const abort = abortOnClose(res);
    const stream = { abort: (reason: unknown) => abort.abort(reason) };
    this.#streams.add(stream);
    try {
      const out = sse(this.#container!.get(Cues).listen(rooms, abort.signal), { retry: 2000 });
      await send(res, { status: out.status, headers: out.headers, body: out.body as AsyncIterable<string> }, false, abort.signal);
    } finally {
      this.#streams.delete(stream);
    }
  }

  /**
   * Answer a request that never reached a handler (404, 405, 406, a refused
   * cross-site post) with the error page, inside a request context and DI
   * scope so layouts can resolve services and read the session like any
   * page. A `refused` request's session is left exactly as it came.
   */
  async #sendError(
    error: YerdError,
    req: IncomingMessage,
    res: ServerResponse,
    target: { path: string; search: string },
    method: string,
    options: { refused?: boolean } = {},
  ): Promise<void> {
    const scope = new Scope();
    const context = new RequestContext({ req, res, target, method, params: {}, route: NO_ROUTE, meta: {}, scope, env: this.#env! });
    try {
      await runWithContext(context, async () => {
        // The error page's layouts may read the session: an async store's
        // read has to be done before they render (see #answer).
        if (this.#errorPage && wantsPage(req.headers)) {
          try {
            await context.readsUpFront();
          } catch {
            // A broken session store shouldn't turn a 404 into a 500: only a
            // layout that reads the session fails (and the plain error goes out).
          }
        }
        let { out } = await this.#failure(error, undefined, context);
        out = await this.#finalize(context, out, { failed: true, commit: !options.refused });
        await send(res, out, method === "HEAD", isStreamBody(out.body) ? context.signal : undefined);
      });
    } finally {
      if (!scope.isEmpty) await scope.dispose().catch((error) => requestLog.error("failed to dispose request services", { error }));
    }
  }

  /**
   * The answer for an error: the route's @catches, then app.onError, then
   * the error page, with the error's headers on whichever answers. `crashed`
   * when nothing handled a crash (an error that isn't a YerdError), so the
   * session isn't saved.
   */
  async #failure(error: unknown, handler: Handler | undefined, context: RequestContext): Promise<{ out: Outgoing; crashed: boolean }> {
    const recovered = context.prerendering ? undefined : await this.#recover(error, handler, context);
    if (recovered) return { out: withErrorHeaders(recovered, error), crashed: false };
    return { out: withErrorHeaders(await this.#errorOut(error, context), error), crashed: !(error instanceof YerdError) };
  }

  /**
   * The steps every answer takes last, routed or not: what the handler
   * declared and the context set (headers, cookies, status) go on, a
   * scripted request's redirect becomes yx-location, the session is saved
   * (unless `commit` is false), and a page shown to someone with a session
   * is kept out of shared caches.
   */
  async #finalize(context: RequestContext, out: Outgoing, options: { failed: boolean; commit: boolean }): Promise<Outgoing> {
    out = context.finish(out, options.failed);
    // fetch() follows redirects on its own; scripted requests get told where to go instead.
    if (context.req.headers["yx"] !== undefined && out.status >= 300 && out.status < 400 && out.headers.location) {
      out = { status: 200, headers: { "yx-location": out.headers.location }, body: null, cookies: out.cookies };
    }
    // Only a session something opened is saved: one nothing read can't have
    // changed, and isn't refreshed or cleared of unread flash either (rolling
    // extends sessions that are used). The commit itself skips one that has
    // nothing to save.
    const loaded = context.loadedSession;
    if (this.#sessions && loaded && options.commit) {
      try {
        const rebound = await this.#sessions.commit(loaded, out);
        // An action that started (or rotated) the session: the page's other
        // forms carry tokens for no session, or the old one. The runtime
        // fetches the page again quietly so they're bound before the next
        // click, instead of that click coming back stale.
        if (rebound && context.req.headers["yx"] !== undefined && out.status < 400 && out.headers["yx-location"] === undefined) {
          out = { ...out, headers: { ...out.headers, "yx-rebind": "1" } };
        }
      } catch (error) {
        out = errorResponse(error);
      }
    }
    // A page for someone with a session shows their state (signed in, a cart),
    // and its action forms are bound to that session: a shared cache, or Back
    // from the browser's HTTP cache, mustn't replay it. A session not opened
    // yet counts when its cookie came in, since a part of the page still
    // streaming may read it. Forms for a visitor without one are unbound, so
    // they alone don't make a page private.
    if (
      this.#sessions &&
      !context.prerendering &&
      out.headers["cache-control"] === undefined &&
      (out.headers["content-type"] ?? "").startsWith("text/html") &&
      ((out.cookies?.length ?? 0) > 0 || context.holdsSession)
    ) {
      out.headers["cache-control"] = "private, no-cache";
    }
    return out;
  }

  /** Render a page stream's first chunk now (see primeStream); anything else as it is. */
  #prime(out: Outgoing): Promise<Outgoing> | Outgoing {
    return isPageStream(out) ? primeStream(out) : out;
  }

  /** Whether a `@get(when)` test accepts this request: a function's truthy result, or a guard letting it through. */
  async #matches(test: When, context: YerdContext): Promise<boolean> {
    if (isGuardRef(test)) {
      const result = await test.run(context);
      return result === true || result === undefined;
    }
    return Boolean(await test(context));
  }

  /**
   * Turn an error into a response with the route's @catches methods, then
   * app.onError. Undefined when neither handles it (the error page does).
   */
  async #recover(error: unknown, handler: Handler | undefined, context: RequestContext): Promise<Outgoing | undefined> {
    try {
      for (const entry of handler?.catches ?? []) {
        if (entry.types.length > 0 && !entry.types.some((type) => error instanceof (type as new () => unknown))) continue;
        const instance = this.#routeInstance(handler!, context.services.scope);
        const result = await (instance[entry.method] as (error: unknown) => unknown).call(instance, error);
        if (result === undefined) continue;
        // A @catches naming the error's class handles it on purpose (debug);
        // a catch-all might be hiding a bug (warn).
        return await this.#recovered(error, result, handler!.layouts, context, `${handler!.def.className}.${String(entry.method)}`, entry.types.length > 0 ? "debug" : "warn");
      }
      if (this.#onError) {
        const result = await this.#onError(error, context);
        if (result !== undefined) return await this.#recovered(error, result, this.#layouts, context, "app.onError", "warn");
      }
    } catch (handlerError) {
      // The error handler failed too (or its page did): the error page reports that one.
      requestLog.error("an error handler threw", { error: handlerError });
      return undefined;
    }
    return undefined;
  }

  async #recovered(error: unknown, result: unknown, layouts: Component<LayoutProps>[], context: RequestContext, by: string, level: "debug" | "warn"): Promise<Outgoing> {
    if (!(error instanceof YerdError)) requestLog.log(level, error instanceof Error ? error.message : "request failed", { handledBy: by }, error);
    // A returned res(..., { status }) or number says the status; otherwise it's the error's.
    const out = await coerce(result, { layouts, meta: context.meta, dynamic: dynamicOf(context), accept: context.req.headers.accept });
    if (!out.explicitStatus) out.status = error instanceof YerdError ? error.status : 500;
    return this.#prime(out);
  }

  #runMiddleware(context: YerdContext, inner: () => Promise<Outgoing>): Promise<Outgoing> {
    const chain = this.#middleware;
    if (chain.length === 0) return inner();
    const step = (i: number): Promise<Outgoing> => (i < chain.length ? chain[i]!(context, () => step(i + 1)) : inner());
    return step(0);
  }

  /** Run a handler's guards; returns the response if one of them doesn't let the request through. */
  async #runGuards(guards: readonly GuardRun[], layouts: Component<LayoutProps>[], context: RequestContext): Promise<Outgoing | undefined> {
    for (const run of guards) {
      const result = await run(context);
      if (result === true || result === undefined) continue;
      if (result === false) throw new Forbidden();
      // Returning an error (e.g. `ok || new Forbidden()`) is the same as throwing it.
      if (result instanceof Error) throw result;
      if (typeof result === "string") return coerce(redirect(result), { layouts: [] });
      return coerce(result, { layouts, meta: context.meta, accept: context.req.headers.accept });
    }
    return undefined;
  }

  /**
   * Run an action if the posted form carries an action token. Returns undefined
   * for ordinary form posts, which then go to the route's @post handler.
   */
  async #dispatchAction(node: RouteNode, context: RequestContext): Promise<Outgoing | undefined> {
    const parsed = await context.body();
    if (parsed.kind !== "form") return undefined;
    // The last one wins: a submit button with formaction={action} carries its
    // own `_yx`, which comes after the form's hidden one in tree order.
    const raw = parsed.value._yx;
    const token = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    if (token === undefined) return undefined;

    // Cross-site posts were already refused before routing (see crossSiteReason);
    // the token must also be this app's, unexpired, and made for this session
    // (or, unbound, for a visitor who still has none). A `session: false`
    // route has no session to bind to, like an app without sessions.
    let payload: ReturnType<typeof verifyAction>;
    let found: ActionCall | undefined;
    try {
      payload = verifyAction(this.#secrets, token);
      checkActionToken(payload, context.csrfNonce(), this.#sessions !== undefined && context.route.session !== false);
      found = node.actions.get(payload.c)?.get(payload.a);
      if (!found) throw new BadRequest("Unknown action");
    } catch (error) {
      // The page is older than the server (a restart with a new secret, a
      // deploy, an expired or other-session token): tell the runtime, which
      // refreshes the page so the next try works.
      if (error instanceof YerdError && context.headers["yx"] !== undefined) {
        return { status: error.status, headers: { "yx-stale": "1", "content-type": "text/plain; charset=utf-8" }, body: error.message };
      }
      throw error;
    }
    const { owner } = found;
    // The class's guards (app, group, route) and the action's own method guards.
    const invoked = await this.#invoke(context, owner, found, () => [fillHoles(payload.p, payload.h, parsed.value), new ActionForm(parsed.value, parsed.files)]);
    if (invoked.blocked) return invoked.blocked;
    const result = invoked.result;

    if (context.headers["yx"] !== undefined) {
      // Nothing returned: the runtime refreshes the page's regions.
      if (result === undefined || result === null) return { status: 204, headers: {}, body: null };
      // JSX comes back bare: just the regions, no layouts. A redirect is
      // coerced as it is: #finalize turns it into yx-location for every
      // scripted request, after the context's cookies and headers are on.
      return coerce(result, { layouts: [], meta: context.meta });
    }

    // No JavaScript: post/redirect/get back to the page the form was on.
    if (result === undefined || result === null || isYerdNode(result) || isBare(result)) {
      return coerce(redirectBack(context), { layouts: [] });
    }
    return coerce(result, { layouts: owner.layouts, meta: context.meta });
  }

  /**
   * Start the app (see start()) and serve HTTP on `port` (default 3000; 0
   * picks a free one). Unless `handleSignals` is false (here or in
   * YerdOptions), SIGINT and SIGTERM close the server gracefully and exit
   * the process. close() stops accepting, ends long-lived streams, waits up
   * to `shutdownTimeout` for in-flight requests, then calls stop().
   *
   * ```ts
   * const { url, close } = await yerd().listen(0, "127.0.0.1", { handleSignals: false });
   * await fetch(url);
   * await close();
   * ```
   */
  async listen(port = 3000, host?: string, options: { handleSignals?: boolean } = {}): Promise<RunningServer> {
    await this.start();
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        requestLog.error("unhandled error", { error });
        if (!res.headersSent) res.writeHead(500).end();
        else res.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    const timeout = this.#options.shutdownTimeout ?? DEFAULT_SHUTDOWN_MS;

    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        // Streams never finish on their own; end them so their requests can.
        for (const stream of this.#streams) stream.abort(new Error("server shutting down"));
        // Keep-alive sockets go idle as their last response finishes; close
        // them as they do, or server.close() waits out the whole timeout.
        server.closeIdleConnections();
        const sweep = setInterval(() => server.closeIdleConnections(), 25);
        try {
          if (!(await withTimeout(closed, timeout))) server.closeAllConnections();
        } finally {
          clearInterval(sweep);
        }
        await this.stop();
      })());
    const onSignal = () => {
      close().then(
        () => process.exit(0),
        (error) => {
          lifecycleLog.error("shutdown failed", { error });
          process.exit(1);
        },
      );
    };
    if (options.handleSignals ?? this.#options.handleSignals ?? true) {
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
    }

    const shown = host === undefined ? "localhost" : host.includes(":") ? `[${host}]` : host;
    return { server, url: `http://${shown}:${actualPort}`, close };
  }
}

function redirectBack(context: YerdContext): YerdResponse {
  let back: string | undefined;
  const referer = context.headers.referer;
  if (referer) {
    try {
      const ref = new URL(referer);
      if (ref.host === context.headers.host) back = ref.pathname + ref.search;
    } catch {
      back = undefined;
    }
  }
  // The fallback is the request path, which a client controls (`POST //evil.com`), so it's checked too.
  return new YerdResponse(303, { location: safeBack(back, safeBack(context.path)) }, null);
}

/** A class's decorator metadata and its ancestors' (subclass metadata prototype-chains to the parent's). */
function metadataChain(cls: Function): object[] {
  const chain: object[] = [];
  for (let md: object | null = metadataOf(cls); md && md !== Object.prototype; md = Object.getPrototypeOf(md)) chain.push(md);
  return chain;
}

function checkInjections(name: string, lifetime: Lifetime, metadata: DecoratorMetadataObject, container: Container, problems: string[]): void {
  for (const entry of INJECTS.from(metadata) ?? []) {
    const target = container.registration(entry.key);
    if (!target) {
      if (!entry.optional) problems.push(`${name}.${entry.field}: nothing is registered for ${keyName(entry.key)} (@service it, or app.services(...))`);
      continue;
    }
    if (lifetime === "singleton" && target.lifetime === "scoped") {
      problems.push(`${name} (singleton) -> ${keyName(entry.key)} (scoped): a singleton can't hold a per-request service`);
    }
  }
}

/**
 * The plain answer for an error: an exposed YerdError's JSON body (its
 * headers may set the content type) or message, else the status text. A
 * YerdError's headers go out either way.
 */
function errorResponse(error: unknown): Outgoing {
  // A thrown number is a status only when Node can send it as a final response;
  // `throw 1000` or `throw 100` is a crash like any other throw.
  const code = typeof error === "number" && Number.isInteger(error) && error >= 200 && error <= 599 ? error : undefined;
  const status = code ?? (error instanceof YerdError ? error.status : 500);
  if (code === undefined && !(error instanceof YerdError && error.expose)) {
    if (status >= 500) requestLog.error(error instanceof Error ? error.message : "request failed", { error });
  }
  if (error instanceof YerdError && error.expose) {
    const json = jsonBody(error);
    if (json !== undefined) return { status, headers: { "content-type": "application/json; charset=utf-8", ...error.headers }, body: json };
    return { status, headers: { ...error.headers, "content-type": "text/plain; charset=utf-8" }, body: error.message };
  }
  const headers = error instanceof YerdError ? { ...error.headers, "content-type": "text/plain; charset=utf-8" } : { "content-type": "text/plain; charset=utf-8" };
  return { status, headers, body: statusText(status) };
}

/**
 * A YerdError's headers on the answer to it (the error page, a @catches or
 * onError response): Vary merged, the rest where the answer didn't set its
 * own. Never Content-Type, which belongs to that answer's body.
 */
function withErrorHeaders(out: Outgoing, error: unknown): Outgoing {
  if (!(error instanceof YerdError)) return out;
  for (const name in error.headers) {
    if (name === "content-type") continue;
    if (name === "vary") out.headers.vary = mergeVary(out.headers.vary, error.headers.vary!);
    else out.headers[name] ??= error.headers[name]!;
  }
  return out;
}

// The runtime's core (plus custom attributes' client halves, and the app's
// lazy modules resolved to URLs for this server: source paths in dev, the
// build's files in production) and its chunks,
// each compressed once per distinct source (brotli and gzip, kept in memory)
// rather than per request. `no-cache` with an ETag, so browsers revalidate
// (a 304) instead of downloading them on every page.
const scriptAssets = new Map<string, { source: string; etag: string; br: Uint8Array; gzip: Uint8Array; raw: Uint8Array }>();

function runtimeResponse(req: IncomingMessage): Outgoing {
  return scriptResponse(req, "", runtimeSource({ chunks: "split", lazy: lazyRegistry(moduleAttributes()) }) + attributesSource());
}

/**
 * A chunk. The core asks for the version it was built with (`?v=`): that one
 * never changes, so it's cached for good. Any other version comes from a page
 * whose core predates this deploy, and gets a chunk that reloads the page.
 */
function chunkResponse(req: IncomingMessage, name: string, search: string): Outgoing {
  const source = chunkSource(name);
  if (source === undefined) return errorResponse(new NotFound());
  const asked = new URLSearchParams(search).get("v");
  if (asked === null) return scriptResponse(req, name, source);
  if (asked !== chunkVersion(name)) {
    return { status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }, body: OUTDATED_CHUNK };
  }
  return scriptResponse(req, name, source, "public, max-age=31536000, immutable");
}

/** A runtime script (`key`: "" for the core, else the chunk's name), from its compressed copies. */
function scriptResponse(req: IncomingMessage, key: string, source: string, cacheControl = "no-cache"): Outgoing {
  let asset = scriptAssets.get(key);
  if (asset?.source !== source) {
    const raw = Buffer.from(source);
    asset = {
      source,
      etag: `"${createHash("sha256").update(raw).digest("base64url").slice(0, 16)}"`,
      br: brotliCompressSync(raw),
      gzip: gzipSync(raw),
      raw,
    };
    scriptAssets.set(key, asset);
  }
  const headers: Record<string, string> = {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": cacheControl,
    etag: asset.etag,
    vary: "accept-encoding",
  };
  const inm = req.headers["if-none-match"];
  // `*` matches any current representation (RFC 9110 13.1.2), and there always is one.
  const etag = asset.etag;
  if (inm && inm.split(",").some((tag) => tag.trim() === "*" || tag.trim() === etag || tag.trim() === `W/${etag}`)) {
    return { status: 304, headers, body: null };
  }
  const accept = req.headers["accept-encoding"] ?? "";
  if (acceptsEncoding(accept, "br")) return { status: 200, headers: { ...headers, "content-encoding": "br" }, body: asset.br };
  if (acceptsEncoding(accept, "gzip")) return { status: 200, headers: { ...headers, "content-encoding": "gzip" }, body: asset.gzip };
  return { status: 200, headers, body: asset.raw };
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Why an unsafe request looks cross-site, or undefined if it doesn't.
 * Sec-Fetch-Site is the browser's own verdict; without it, Origin (or Referer)
 * is compared with the Host the request was sent to. A request with none of
 * these headers isn't from a browser page, so it can't carry a victim's
 * cookies by accident and passes.
 */
export function crossSiteReason(req: IncomingMessage, trusted: ReadonlySet<string>, trustProxy: boolean): string | undefined {
  const headers = req.headers;
  const origin = headers.origin;
  if (origin !== undefined && trusted.has(origin)) return undefined;
  const site = headers["sec-fetch-site"];
  if (site === "cross-site" || site === "same-site") return "Cross-site requests are refused";
  if (site === "same-origin" || site === "none") return undefined;
  if (origin === "null") return "Requests from an opaque origin are refused";
  const source = origin ?? headers.referer;
  if (source === undefined) return undefined;
  let from: URL;
  try {
    from = new URL(source);
  } catch {
    return "Malformed Origin header";
  }
  if (trusted.has(from.origin)) return undefined;
  const host = (trustProxy ? forwarded(headers["x-forwarded-host"]) : undefined) ?? headers.host;
  let expected: string;
  try {
    // Parsed with the origin's scheme so default ports compare equal (a:443 vs a).
    expected = new URL(`${from.protocol}//${host}`).host;
  } catch {
    return "Malformed Host header";
  }
  return from.host === expected ? undefined : "Cross-origin requests are refused";
}

function isFormBody(contentType: string | undefined): boolean {
  const type = mediaTypeOf(contentType);
  return type === "application/x-www-form-urlencoded" || type === "multipart/form-data";
}

/** A streamed body that isn't long-lived: a rendered page (or a handler's own iterable). */
function isPageStream(out: Outgoing): boolean {
  return isStreamBody(out.body) && out.headers[LONG_LIVED] === undefined;
}

/**
 * Pull a page stream's first chunk now (errors surface here, while there is
 * still time to send the error page) and hand back a body that replays it.
 * Long-lived streams are left alone: their first item may be minutes away.
 */
async function primeStream(out: Outgoing): Promise<Outgoing> {
  if (!isPageStream(out)) return out;
  const iterator = (out.body as AsyncIterable<string | Uint8Array>)[Symbol.asyncIterator]();
  const first = await iterator.next();
  let replayed = false;
  const primed: AsyncIterator<string | Uint8Array> = {
    next: () => {
      if (replayed) return iterator.next();
      replayed = true;
      return Promise.resolve(first);
    },
    return: (value?: unknown) => iterator.return?.(value) ?? Promise.resolve({ done: true, value: undefined }),
  };
  return { ...out, body: { [Symbol.asyncIterator]: () => primed } };
}

/** The headers a static file answer depends on. */
function conditional(req: IncomingMessage): { "if-none-match": string | undefined; "accept-encoding": string | undefined } {
  return { "if-none-match": req.headers["if-none-match"], "accept-encoding": req.headers["accept-encoding"] };
}

/** How <Dynamic> parts render: skeletons while prerendering, only them for the runtime's fill-in request. */
function dynamicOf(context: RequestContext): "fallback" | "only" | undefined {
  return context.prerendering ? "fallback" : context.req.headers["yx-dynamic"] !== undefined ? "only" : undefined;
}

/** A static file. Its first read happens before the headers go out, so a file gone since its stat is a 500, not a cut-off body. */
async function sendFile(res: ServerResponse, file: Outgoing, headOnly: boolean): Promise<void> {
  if (!headOnly && isStreamBody(file.body)) {
    try {
      file = await primeStream(file);
    } catch (error) {
      file = errorResponse(error);
    }
  }
  return send(res, file, headOnly, undefined);
}

/** What a wait in send() settles with when the response was aborted instead. */
const STOPPED: unique symbol = Symbol("stopped");

async function send(res: ServerResponse, out: Outgoing, headOnly: boolean, signal: AbortSignal | undefined): Promise<void> {
  // Copied rather than reused: handlers may hand back a headers object they share.
  const headers: Record<string, string | string[]> = { "x-content-type-options": "nosniff" };
  for (const name in out.headers) if (name !== LONG_LIVED) headers[name] = out.headers[name]!;
  const longLived = out.headers[LONG_LIVED] !== undefined;
  if (out.cookies?.length) headers["set-cookie"] = out.cookies;
  const { body } = out;
  // 204 and 304 never have a body (RFC 9110 6.4.1); a Content-Length promising
  // one would leave a keep-alive client waiting for bytes that never come.
  const bodiless = out.status === 204 || out.status === 304;

  if (!isStreamBody(body)) {
    if (body !== null && !bodiless) headers["content-length"] = String(typeof body === "string" ? Buffer.byteLength(body) : body.byteLength);
    res.writeHead(out.status, headers);
    res.end(headOnly || bodiless || body === null ? undefined : body);
    return;
  }

  // A page's first chunk was pulled before it got here (primeStream), so an
  // error at its top already became the error page. Long-lived streams (SSE,
  // NDJSON) send their headers now, so the client is connected even if the
  // first item is a long way off.
  res.writeHead(out.status, headers);
  if (longLived) res.flushHeaders();
  const iterator = body[Symbol.asyncIterator]();
  if (headOnly || bodiless) {
    await iterator.return?.();
    res.end();
    return;
  }

  // Client gone or server shutting down: stop pulling and let the source's
  // finally blocks run. One abort listener serves the whole response, and
  // each wait (the next chunk, a drain) gets a promise of its own that the
  // listener settles. Racing every chunk against one promise that settles
  // only on abort would leave a reaction on it per chunk, for as long as
  // the connection lives.
  let wake: (() => void) | undefined;
  const onAbort = () => wake?.();
  signal?.addEventListener("abort", onAbort, { once: true });
  const until = <T>(work: () => Promise<T>): Promise<T | typeof STOPPED> => {
    if (!signal) return work();
    if (signal.aborted) return Promise.resolve(STOPPED);
    return new Promise((resolve, reject) => {
      wake = () => resolve(STOPPED);
      work().then(resolve, reject);
    });
  };
  const pull = () => iterator.next();
  const drain = () => once(res, "drain");

  try {
    let next = await until(pull);
    while (next !== STOPPED && !next.done) {
      if (!res.write(next.value) && (await until(drain)) === STOPPED) break;
      next = await until(pull);
    }
    if (signal?.aborted) void iterator.return?.();
    res.end();
  } catch (error) {
    // Headers are already out; the best we can do is log and cut the response.
    requestLog.error("response failed after headers were sent", { error });
    res.destroy(error as Error);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Create an app. Routes are every class decorated with @route (or just
 * `options.routes`); nothing is served until listen(), or until you hand
 * app.handle to another server.
 *
 * ```tsx
 * @route("/")
 * class Home {
 *   @get page() { return <h1>hello</h1>; }
 * }
 *
 * await yerd().listen(3000);
 * ```
 */
export function yerd(options?: YerdOptions): YerdApp {
  return new YerdApp(options);
}
