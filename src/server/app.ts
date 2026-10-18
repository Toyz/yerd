import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, extname, join } from "node:path";
import { ACCESSORS, ARGS, type Resolver } from "../decorators/kit.js";
import { ACCEPTS, METHOD_LAYOUTS, NO_LAYOUT, PRERENDER, applyLayouts, joinLayouts, resetRouteRegistry, type When, VERBS, resolveRoute, routeRegistry, type LayoutProps, type PageMeta, type RouteDef, type Verb } from "../decorators/route.js";
import { choose, expandType, isNegotiated } from "../respond/negotiate.js";
import { Container, Scope, ServiceCollection, currentServices, keyName, runWithServices, type Lifetime, type Registration } from "../di/container.js";

const currentScope = () => currentServices()?.scope;
import {
  EVERY, INJECTS, ON_BOOT, ON_SHUTDOWN, lifetimeOf, registrationFor, resetServiceRegistry, serviceRegistry,
  type HostedService,
} from "../di/decorators.js";
import { jsx, type Component } from "../jsx/jsx-runtime.js";
import { coerce, type Outgoing } from "../respond/coerce.js";
import { HttpError } from "../respond/response.js";
import { LONG_LIVED } from "../respond/stream.js";
import { Channels } from "../live/channels.js";
import { EventTransport, Events, HANDLES, ON_EVENT, eventName } from "../events/events.js";
import { ACTIONS, ActionForm, CSRF_FIELD, checkActionToken, fillHoles, resolveSecrets, safeBack, verifyAction } from "../actions/action.js";
import { CLASS_GUARDS, METHOD_GUARDS, guardRegistry, isGuardRef, resetGuardRegistry, type GuardSpec } from "../decorators/guards.js";
import { SessionManager, checkSessionOptions, type LoadedSession } from "../session/manager.js";
import type { SessionOptions } from "../session/session.js";
import { parseCookies } from "./cookies.js";
import { RUNTIME_PATH } from "../actions/components.js";
import { runtimeSource } from "../client/runtime.js";
import { attributesSource, resetAttributeRegistry } from "../attributes/attribute.js";
import { isYerdNode } from "../jsx/jsx-runtime.js";
import { YerdResponse, isBare } from "../respond/response.js";
import { Router, paramNames } from "../router/trie.js";
import { DEFAULT_BODY_LIMIT, readBody, readNdjson, type ParsedBody } from "./body.js";
import { acceptsEncoding, createMount, serveStatic, type StaticMount, type StaticOptions } from "./static.js";
import { useManifest } from "../assets.js";
import { runWithContext, type RouteInfo, type YerdContext } from "./context.js";
import { RequestContext, splitTarget, type RequestEnv } from "./request-context.js";
import { CATCHES, METHOD_RESPONSE } from "../decorators/response.js";
import { ConsoleLogger } from "../log/console.js";
import { LogFilter, defaultFilter } from "../log/filter.js";
import { ILogger } from "../log/ilogger.js";
import { Logger } from "../log/logger.js";
import { REQUEST_SPAN, bindLogging, endRequestSpan, startRequestSpan, type LogBinding } from "../log/span.js";

/** yerd's own log targets. */
const lifecycleLog = new Logger("yerd::lifecycle");
const requestLog = new Logger("yerd::request");

/** Options for {@link yerd} / `new YerdApp()`. Every field is optional. */
export interface YerdOptions {
  /** Only serve these route classes. Defaults to every class decorated with @route. */
  routes?: Function[];
  /** Only register these @service / @hosted classes. Defaults to all of them. */
  services?: Function[];
  /** Largest request body read, in bytes. Bigger bodies get a 413. Default 1 MiB. */
  bodyLimit?: number;
  /** How long close() waits for in-flight requests and background work, in ms. Default 10000. */
  shutdownTimeout?: number;
  /** Close gracefully on SIGINT / SIGTERM. Default true. */
  handleSignals?: boolean;
  /**
   * Signs action tokens and seals sessions. At least 32 bytes each; a list
   * rotates (newest first). Defaults to YERD_SECRET (comma separated), else a
   * random per-process secret.
   */
  secret?: string | string[];
  /** How long a rendered action form stays valid, in seconds. Default 86400 (a day). */
  actionTtl?: number;
  /**
   * Cross-site protection for unsafe methods (POST, PUT, PATCH, DELETE): a
   * browser request from another site is refused with 403, judged by
   * Sec-Fetch-Site, Origin, then Referer. Requests with none of those (curl,
   * server-to-server) pass. Default true.
   */
  csrf?: boolean;
  /** Other origins allowed to send unsafe requests, e.g. ["https://admin.example.com"]. */
  trustedOrigins?: string[];
  /** Behind a reverse proxy: believe X-Forwarded-Host for the origin check. Default false. */
  trustProxy?: boolean;
}

/** Options for app.logging(): which records are written, and how. */
export interface LoggingOptions {
  /** Directives like YERD_LOG ("info,UserRepo=debug"). Default: YERD_LOG, else info (warn under tests). */
  filter?: string;
  /** ConsoleLogger format. Default: pretty on a terminal outside production, else json. */
  format?: "pretty" | "json";
}

interface Handler {
  def: RouteDef;
  lifetime: Lifetime;
  method: string | symbol;
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
}

/** Middleware wraps guards and the handler (or action) for every routed request. */
export type Middleware = (ctx: YerdContext, next: () => Promise<Outgoing>) => Promise<Outgoing>;

interface ResolvedGuard {
  label: string;
  run: (ctx: YerdContext) => unknown;
}

/** Every handler for one pattern + verb: a default and/or @accepts variants. */
type HandlerGroup = Handler[];

/** The handler for a request among those without a `when` test: the default, or an @accepts variant. */
function pickHandler(all: HandlerGroup, accept: string | undefined): Handler | undefined {
  const group = all.some((h) => h.when) ? all.filter((h) => !h.when) : all;
  if (group.length === 0) return undefined;
  if (group.length === 1 && !group[0]!.accepts) return group[0];
  const fallback = group.find((h) => !h.accepts);
  const variants = group.filter((h) => h.accepts);
  const chosen = choose(variants.map((h) => h.accepts!), accept, fallback !== undefined);
  if (chosen === "default") return fallback;
  return chosen === undefined ? undefined : variants[chosen];
}

/** Props for app.errorPage(). */
export interface ErrorPageProps {
  /** The HTTP status being sent, e.g. 404 or 500. */
  status: number;
  /** A message safe to show: the HttpError's message when it's exposed, else the status text. */
  message: string;
  /**
   * What was thrown: an HttpError (a 404 for an unknown path is one), or
   * whatever a handler threw. For logging, or for showing details in
   * development; `message` is what's safe to show everyone, since a crash's
   * own message and stack can leak internals.
   *
   * ```tsx
   * function ErrorPage({ status, message, error }: ErrorPageProps) {
   *   return (
   *     <main>
   *       <h1>{status}</h1>
   *       <p>{message}</p>
   *       {process.env.NODE_ENV !== "production" && error instanceof Error ? <pre>{error.stack}</pre> : null}
   *     </main>
   *   );
   * }
   * ```
   */
  error: unknown;
}

type Next = (error?: unknown) => void;

/** What app.listen() resolves to once the server is accepting connections. */
export interface RunningServer {
  /** The underlying node:http server. */
  readonly server: Server;
  /** The base URL, `http://<host>:<port>`, with the real port when listening on port 0. Host defaults to localhost. */
  readonly url: string;
  /** Graceful: stop accepting, end streams, let requests finish, stop background work, dispose services. */
  close(): Promise<void>;
}

/** Thrown by boot validation; lists every problem at once. */
export class BootError extends Error {
  /** `problems`: one message per thing that's wrong; the error message lists them all. */
  constructor(readonly problems: string[]) {
    super(`yerd refused to start:\n  - ${problems.join("\n  - ")}`);
    this.name = "BootError";
  }
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
  405: "Method Not Allowed", 406: "Not Acceptable", 413: "Content Too Large", 500: "Internal Server Error",
};

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
  readonly #streams = new Set<RequestContext>();
  #router: Router<HandlerGroup> | undefined;
  #container: Container | undefined;
  #secrets: string[] = [];
  #sessions: SessionManager | undefined;
  #sessionOptions: SessionOptions | undefined;
  readonly #middleware: Middleware[] = [];
  readonly #appGuards: GuardSpec[] = [];
  readonly #namedGuards = new Map<string, ResolvedGuard>();
  readonly #trustedOrigins: ReadonlySet<string>;
  /** Shared by every request's context; built at boot. */
  #env: RequestEnv | undefined;
  /** Whether any route has @action methods (only then do page requests need a CSRF nonce). */
  #hasActions = false;
  #loggingOptions: LoggingOptions = {};
  #onError: ((error: unknown, ctx: YerdContext) => unknown) | undefined;
  /** This app's sink and filter; set at boot. */
  #log: LogBinding | undefined;
  #started: Promise<void> | undefined;
  #stopping: Promise<void> | undefined;
  #tornDown: Promise<void> | undefined;
  #lifecycle: { abort: AbortController; hosted: Promise<unknown>[]; periodic: Periodic[]; shutdown: Array<() => unknown> } | undefined;

  /** Prefer {@link yerd}, which does the same. Throws if a `trustedOrigins` entry isn't a valid URL. */
  constructor(options: YerdOptions = {}) {
    this.#options = options;
    this.#trustedOrigins = new Set((options.trustedOrigins ?? []).map((o) => new URL(o).origin));
  }

  /** Root layout(s), outermost first, wrapping every JSX response (outside group and route layouts). */
  layout(component: Component<LayoutProps>): this {
    if (this.#router) throw new Error("layout() must be called before the app starts");
    this.#layouts.push(component);
    return this;
  }

  /** Turn on sessions (cookie store by default). See SessionOptions. */
  sessions(options: SessionOptions = {}): this {
    if (this.#router) throw new Error("sessions() must be called before the app starts");
    checkSessionOptions(options);
    this.#sessionOptions = options;
    return this;
  }

  /**
   * Middleware around every routed request (inside guards' error handling,
   * outside guards and handlers). Accepts a function or anything with a
   * `middleware` function, like the object createAuth() returns.
   */
  use(middleware: Middleware | { middleware: Middleware }): this {
    this.#middleware.push(typeof middleware === "function" ? middleware : middleware.middleware);
    return this;
  }

  /** Guards in front of every route, before group and route guards. */
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
   * Use a Vite client build: serve its files from `/` and resolve assetUrl() /
   * <Stylesheet> through its manifest. The generated production server calls
   * this; you rarely need to.
   */
  clientBuild(dir: string, manifest: string | URL): this {
    useManifest(manifest);
    const mount = createMount("/", dir);
    const list = join(dir, ".yerd", "prerendered.json");
    if (existsSync(list)) {
      const paths = JSON.parse(readFileSync(list, "utf8")) as Record<string, string>;
      for (const [path, file] of Object.entries(paths)) this.#prerendered.set(path, { mount: createMount("/", dir), file });
    }
    this.#mounts.push(mount);
    return this;
  }

  /**
   * Render every @prerender route to `outDir` (the client build directory).
   * The yerd Vite plugin calls this after `vite build`. Returns the paths written.
   */
  async prerender(outDir: string): Promise<string[]> {
    await this.boot();
    const allowed = this.#options.routes ? new Set(this.#options.routes) : undefined;
    const defs = routeRegistry.filter((d) => PRERENDER.from(d.metadata) && (!allowed || allowed.has(d.ctor)));
    if (defs.length === 0) return [];
    const manifest = join(outDir, ".vite", "manifest.json");
    if (existsSync(manifest)) useManifest(manifest);

    this.#prerenderToken = randomBytes(16).toString("hex");
    const server = await this.listen(0, "127.0.0.1", { handleSignals: false });
    const written: Record<string, string> = {};
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
          const match = this.#router!.match(path);
          if (!match || ![...match.handlers.values()].flat().some((h) => h.def === def)) {
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
      await mkdir(join(outDir, ".yerd"), { recursive: true });
      await writeFile(join(outDir, ".yerd", "prerendered.json"), JSON.stringify(written, null, 2));
    } finally {
      this.#prerenderToken = undefined;
      await server.close();
    }
    return Object.keys(written);
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
   * Render errors (404s, thrown HttpErrors, crashes) as an HTML page inside the
   * root layouts, for requests that accept HTML. API clients still get text or
   * JSON. Internal error messages are never shown.
   */
  errorPage(component: Component<ErrorPageProps>): this {
    if (this.#router) throw new Error("errorPage() must be called before the app starts");
    this.#errorPage = component;
    return this;
  }

  async #errorOut(error: unknown, req: IncomingMessage, meta: PageMeta = {}): Promise<Outgoing> {
    const plain = errorResponse(error);
    const accept = req.headers.accept ?? "";
    if (!this.#errorPage || !accept.includes("text/html") || req.headers["yx"] !== undefined) return plain;
    const message =
      error instanceof HttpError && error.expose ? error.message : STATUS_TEXT[plain.status] ?? `HTTP ${plain.status}`;
    try {
      const page = await coerce(jsx(this.#errorPage, { status: plain.status, message, error } satisfies ErrorPageProps), {
        layouts: this.#layouts,
        meta: { ...meta, title: message },
      });
      return { ...page, status: plain.status };
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
   */
  resetRegistries(): void {
    resetRouteRegistry();
    resetServiceRegistry();
    resetGuardRegistry();
    resetAttributeRegistry();
  }

  /** The DI container. Available after boot(). */
  get container(): Container {
    if (!this.#container) throw new Error("The app hasn't booted yet");
    return this.#container;
  }

  /** Run `fn` inside a fresh DI scope (scoped services resolve), disposed afterwards. For scripts and tests. */
  async scope<T>(fn: () => T | Promise<T>): Promise<T> {
    await this.boot();
    const scope = new Scope();
    try {
      return await runWithServices(this.#container!, scope, fn);
    } finally {
      await scope.dispose();
    }
  }

  /** Build the route table and the container, and validate both. Runs once; later calls are no-ops. */
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
    const router = new Router<HandlerGroup>();
    const groups = new Map<string, Map<Verb, HandlerGroup>>();
    const referencedGuards: Array<[where: string, name: string]> = [];

    for (const def of defs) {
      let resolved;
      try {
        resolved = resolveRoute(def);
      } catch (e) {
        problems.push(`${def.className}: ${(e as Error).message}`);
        continue;
      }
      const info: RouteInfo = { pattern: resolved.pattern, paramNames: paramNames(resolved.pattern), className: def.className };
      const lifetime = lifetimeOf({ lifetime: def.options.lifetime, metadata: def.metadata }, "scoped");
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
        const byVerb = groups.get(info.pattern) ?? new Map<Verb, HandlerGroup>();
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
        });
      }
    }

    // Named guards: each @guard method belongs to a service. Only this app's
    // services count (the registry is process-wide), and a guard declared on a
    // base class works through a registered subclass.
    const namedGuards = new Map<string, ResolvedGuard>();
    const registrations = [...container.registrations()];
    for (const named of guardRegistry) {
      const registration = registrations.find((r) => r.impl && metadataChain(r.impl).includes(named.metadata));
      if (!registration) continue;
      if (namedGuards.has(named.name)) {
        problems.push(`Duplicate guard name "${named.name}"`);
        continue;
      }
      const key = registration.key;
      namedGuards.set(named.name, {
        label: named.name,
        run: (ctx) => {
          const instance = container.get(key, currentScope()) as Record<string | symbol, (ctx: YerdContext) => unknown>;
          return instance[named.method]!.call(instance, ctx);
        },
      });
    }

    for (const [pattern, byVerb] of groups) {
      for (const [verb, group] of byVerb) {
        for (const handler of group) {
          for (const spec of handler.guards) {
            if (typeof spec === "string") referencedGuards.push([`${handler.def.className}.${String(handler.method)}`, spec]);
          }
        }
        try {
          router.add(pattern, verb, group);
        } catch (e) {
          problems.push(`${group[0]!.def.className}: ${(e as Error).message}`);
        }
      }
    }

    const answering = new Map<string, string>();
    for (const registration of container.registrations()) {
      if (!registration.impl) continue;
      const metadata = metadataOfClass(registration.impl);
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
    const sinkRegistration = container.registration(ILogger);
    if (sinkRegistration && sinkRegistration.lifetime !== "singleton") problems.push("ILogger must be a singleton service");

    if (problems.length > 0) throw new BootError(problems);
    const envFormat = process.env.YERD_LOG_FORMAT;
    const format = envFormat === "pretty" || envFormat === "json" ? envFormat : this.#loggingOptions.format;
    const sink = sinkRegistration ? container.get(ILogger) : new ConsoleLogger({ format });
    this.#log = { sink, filter: filter! };
    bindLogging(container, this.#log);
    for (const [name, guard] of namedGuards) this.#namedGuards.set(name, guard);
    this.#secrets = resolveSecrets(this.#options.secret);
    if (this.#sessionOptions) {
      const options = { trustProxy: this.#options.trustProxy, ...this.#sessionOptions };
      this.#sessions = new SessionManager(options, this.#secrets);
    }
    this.#hasActions = defs.some((d) => (ACTIONS.from(d.metadata)?.size ?? 0) > 0);
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
  }

  /**
   * Boot, run @onBoot hooks, start @hosted services and @every timers.
   * listen() calls this; call it yourself to run background work without HTTP.
   */
  start(): Promise<void> {
    if (this.#stopping) return Promise.reject(new Error("This app was stopped; create a new one to start again"));
    // A failed start tears down whatever it got running (timers, hosted
    // services, singletons) and stays failed: there's no half-started app.
    this.#started ??= this.#start().catch(async (error) => {
      // The start failure is the error to report; a cleanup failure is only logged.
      await this.#teardown().catch((cleanup: unknown) => lifecycleLog.error("cleaning up after a failed start failed", { error: cleanup }));
      throw error;
    });
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

    await runWithServices(container, undefined, async () => {
      for (const registration of singletons) {
        const metadata = metadataOfClass(registration.impl!);
        const boot = ON_BOOT.from(metadata) ?? [];
        const shutdown = ON_SHUTDOWN.from(metadata) ?? [];
        const periodic = EVERY.from(metadata) ?? [];
        const ons = ON_EVENT.from(metadata) ?? [];
        const answers = HANDLES.from(metadata) ?? [];
        if (boot.length === 0 && shutdown.length === 0 && periodic.length === 0 && ons.length === 0 && answers.length === 0) continue;
        const instance = container.get(registration.key) as Record<string | symbol, (...a: unknown[]) => unknown>;
        if (ons.length || answers.length) container.get(Events).wire(container, instance, registration.impl!.name, ons, answers);
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
   * progress. An app can't be started again after it stops.
   */
  stop(): Promise<void> {
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
    const timeout = this.#options.shutdownTimeout ?? 10_000;
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

  #routeInstance(handler: Handler, scope: Scope): Record<string | symbol, unknown> {
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
   * Node request handler. With `next` (connect-style middleware, e.g. Vite's
   * dev server), unmatched paths are passed on instead of answered with 404.
   */
  handle = async (req: IncomingMessage, res: ServerResponse, next?: Next): Promise<void> => {
    try {
      await this.start();
    } catch (e) {
      if (next) return next(e);
      throw e;
    }
    // The request's root span: request id, trace context, and on the way
    // out the access log line. Nothing is created when request logging is off.
    const rawUrl = req.url ?? "/";
    const q = rawUrl.indexOf("?");
    const span = startRequestSpan(this.#log!, req, req.method ?? "GET", q === -1 ? rawUrl : rawUrl.slice(0, q));
    if (!span) return this.#serve(req, res, next);
    (req as unknown as Record<symbol, unknown>)[REQUEST_SPAN] = span;
    res.setHeader("x-request-id", span.id);
    try {
      await this.#serve(req, res, next);
    } finally {
      endRequestSpan(this.#log!, span, res.statusCode);
    }
  };

  async #serve(req: IncomingMessage, res: ServerResponse, next: Next | undefined): Promise<void> {
    const router = this.#router!;
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
        return send(res, errorResponse(400), method === "HEAD", undefined);
      }
    }
    const url = { pathname: target.path };

    if (url.pathname === RUNTIME_PATH && (method === "GET" || method === "HEAD")) {
      return send(res, runtimeResponse(req), method === "HEAD", undefined);
    }

    // Prerendered at build time: the file, not the handler. The runtime's own
    // requests go to the handler: `yx-dynamic` fills <Dynamic> parts, and a
    // boosted navigation or refresh wants the page whole, not its skeletons.
    const prebuilt =
      (method === "GET" || method === "HEAD") &&
      this.#prerenderToken === undefined &&
      req.headers["yx-dynamic"] === undefined &&
      req.headers["yx-boost"] === undefined
        ? this.#prerendered.get(url.pathname)
        : undefined;
    if (prebuilt) {
      const file = await serveStatic(prebuilt.mount, `/${prebuilt.file}`, {
        "if-none-match": req.headers["if-none-match"],
        "accept-encoding": req.headers["accept-encoding"],
      });
      if (file) return send(res, file, method === "HEAD", undefined);
    }

    const match = router.match(url.pathname);

    if (!match) {
      if (method === "GET" || method === "HEAD") {
        for (const mount of this.#mounts) {
          const file = await serveStatic(mount, url.pathname, {
            "if-none-match": req.headers["if-none-match"],
            "accept-encoding": req.headers["accept-encoding"],
          });
          if (file) return send(res, file, method === "HEAD", undefined);
        }
      }
      if (next) return next();
      return this.#sendError(new HttpError(404, "Not Found"), req, res, target, method);
    }

    if (this.#options.csrf !== false && UNSAFE_METHODS.has(method)) {
      const refused = crossSiteReason(req, this.#trustedOrigins, this.#options.trustProxy ?? false);
      if (refused) return this.#sendError(new HttpError(403, refused), req, res, target, method);
    }

    const group =
      match.handlers.get(method) ??
      (method === "HEAD" ? match.handlers.get("GET") : undefined) ??
      match.handlers.get("ALL");
    // `@get(when)` variants are tested once the request context exists; the rest is picked now.
    const variants = group ? group.filter((h) => h.when) : [];
    const plain = variants.length && group ? group.filter((h) => !h.when) : group;
    const negotiated = plain !== undefined && (plain.length > 1 || plain[0]?.accepts !== undefined);
    const handler = group && pickHandler(group, req.headers.accept);
    if (group && !handler && variants.length === 0) return this.#sendError(new HttpError(406, "Not Acceptable"), req, res, target, method, { vary: "accept" });
    const candidates = [...new Set([...match.handlers.values()].flat())];
    const mayBeAction =
      method === "POST" &&
      isFormBody(req.headers["content-type"]) &&
      candidates.some((h) => (ACTIONS.from(h.def.metadata)?.size ?? 0) > 0);

    if (!handler && !mayBeAction && variants.length === 0) {
      const allow = [...match.handlers.keys()].filter((v) => v !== "ALL");
      if (allow.includes("GET") && !allow.includes("HEAD")) allow.push("HEAD");
      return this.#sendError(new HttpError(405, "Method Not Allowed"), req, res, target, method, { allow: allow.join(", ") });
    }
    const base = handler ?? variants[0] ?? candidates[0]!;

    const sessions = this.#sessions;
    const prerendering = this.#prerenderToken !== undefined && req.headers["x-yerd-prerender"] === this.#prerenderToken;
    const scope = new Scope();
    const container = this.#container!;
    const context = new RequestContext(req, res, target, method, match.params, base.info, { ...base.meta }, prerendering, scope, this.#env!);
    // <Dynamic> parts: skeletons while prerendering, only them for the runtime's fill-in request.
    const dynamic: "fallback" | "only" | undefined = prerendering ? "fallback" : req.headers["yx-dynamic"] !== undefined ? "only" : undefined;
    // One async context for the request and its DI scope (currentServices() reads context.services).
    const inRequest = <T>(fn: () => T): T => runWithContext(context, fn);

    try {
      let out: Outgoing;
      // A crash (not an HttpError) skips the session commit, so a half-done
      // login or update doesn't stick.
      let crashed = false;
      try {
        if (sessions && !prerendering) {
          context.loadedSession = await sessions.load(req, context.cookies);
          // Pages that may render action forms get their CSRF nonce now, while
          // the session can still be committed (see RequestContext.csrfNonce).
          if (this.#hasActions && wantsPage(req)) context.csrfNonce();
        }
        out = await inRequest(() => this.#runMiddleware(context, async () => {
          if (mayBeAction) {
            const fromAction = await this.#dispatchAction(candidates, context, scope);
            if (fromAction) return fromAction;
          }
          // The first `@get(when)` variant whose test passes serves the request;
          // otherwise the default does. Prerendering has no request to test.
          let chosen = handler;
          if (variants.length > 0 && !prerendering) {
            for (const variant of variants) {
              if (variant.accepts && choose([variant.accepts], req.headers.accept, false) === undefined) continue;
              if (await this.#matches(variant.when!.test, context)) {
                chosen = variant;
                break;
              }
            }
          }
          if (!chosen) throw new HttpError(variants.length > 0 ? 404 : 405, variants.length > 0 ? "Not Found" : "Method Not Allowed");
          const serving = chosen;
          const blocked = await this.#runGuards(serving.guards, serving.layouts, context);
          if (blocked) return blocked;
          context.declared = METHOD_RESPONSE.from(serving.def.metadata)?.get(serving.method);
          const instance = this.#routeInstance(serving, scope);
          const fn = instance[serving.method] as ((...args: unknown[]) => unknown) | undefined;
          if (typeof fn !== "function") throw new Error(`${serving.def.className}.${String(serving.method)} is not a method`);
          const args = serving.args ? await Promise.all(serving.args.map((r) => r.resolve(context))) : [];
          let result = await fn.apply(instance, args);
          if (isNegotiated(result)) {
            const keys = Object.keys(result.variants);
            const chosen = choose(keys.map((k) => [expandType(k)]), req.headers.accept, true);
            if (chosen === undefined) throw new HttpError(406, "Not Acceptable");
            const key = chosen === "default" ? keys[0]! : keys[chosen]!;
            const type = expandType(key);
            result = await (result.variants as Record<string, () => unknown>)[key]!();
            const out = await coerce(result, { layouts: serving.layouts, meta: context.meta, dynamic });
            if (type === "application/json") {
              // Strings and nulls are JSON here too, not text or 204.
              if (!out.headers["content-type"]?.startsWith("application/json")) {
                out.body = JSON.stringify(result ?? null);
                out.headers["content-type"] = "application/json; charset=utf-8";
                if (out.status === 204) out.status = 200;
              }
            } else if (type !== "text/html" && (typeof out.body === "string" || out.body instanceof Uint8Array)) {
              out.headers["content-type"] = type.startsWith("text/") ? `${type}; charset=utf-8` : type;
            }
            addVary(out.headers, "accept");
            return out;
          }
          const out = await coerce(result, { layouts: serving.layouts, meta: context.meta, dynamic });
          if (negotiated) addVary(out.headers, "accept");
          return out;
        }));
        // Whichever handler answered, the response depended on what the variants' tests read.
        for (const variant of variants) if (variant.when!.vary) addVary(out.headers, variant.when!.vary);
        // Render up to the first chunk now, so an error at the top of the page
        // (a layout, an early component) still becomes the error page.
        if (isPageStream(out)) out = await inRequest(() => primeStream(out));
        out = context.finish(out, false);
        // The handler succeeded: what it emitted goes out now (see Events).
        this.#container!.get(Events).release(context);
      } catch (error) {
        this.#container!.get(Events).discard(context);
        if (prerendering) this.#prerenderErrors.set(url.pathname, error instanceof Error ? error.message : String(error));
        // The route's @catches, then app.onError, then the error page.
        const recovered = prerendering ? undefined : await inRequest(() => this.#recover(error, base, context, scope, dynamic));
        if (recovered) out = recovered;
        else {
          crashed = !(error instanceof HttpError);
          out = await inRequest(() => this.#errorOut(error, req, context.meta));
        }
        out = context.finish(out, true);
      }
      // fetch() follows redirects on its own; scripted requests get told where to go instead.
      if (req.headers["yx"] !== undefined && out.status >= 300 && out.status < 400 && out.headers.location) {
        out = { status: 200, headers: { "yx-location": out.headers.location }, body: null, cookies: out.cookies };
      }
      if (sessions && context.loadedSession && !crashed) {
        try {
          await sessions.commit(context.loadedSession, out);
        } catch (error) {
          out = errorResponse(error);
        }
      }
      // A page for someone with a session shows their state (signed in, a cart):
      // a shared cache, or Back from the browser's HTTP cache, mustn't replay it.
      if (
        context.loadedSession &&
        (context.loadedSession.payload !== undefined || (out.cookies?.length ?? 0) > 0) &&
        out.headers["cache-control"] === undefined &&
        (out.headers["content-type"] ?? "").startsWith("text/html")
      ) {
        out.headers["cache-control"] = "private, no-cache";
      }
      // Only streams need the abort signal (client gone, shutdown); plain bodies skip creating one.
      const streaming = out.body !== null && typeof out.body !== "string" && !(out.body instanceof Uint8Array);
      const longLived = out.headers[LONG_LIVED] !== undefined;
      if (longLived) this.#streams.add(context);
      try {
        await inRequest(() => send(res, out, method === "HEAD", streaming ? context.signal : undefined));
      } finally {
        if (longLived) this.#streams.delete(context);
      }
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

  /**
   * Answer a request that never reached a handler (404, 405, 406, a refused
   * cross-site post) with the error page, inside a request context and DI
   * scope so layouts can resolve services and read the session like any page.
   */
  async #sendError(
    error: HttpError,
    req: IncomingMessage,
    res: ServerResponse,
    target: { path: string; search: string },
    method: string,
    headers: Record<string, string> = {},
  ): Promise<void> {
    const scope = new Scope();
    const info: RouteInfo = { pattern: "", paramNames: [], className: "" };
    const context = new RequestContext(req, res, target, method, {}, info, {}, false, scope, this.#env!);
    try {
      await runWithContext(context, async () => {
        if (this.#sessions && this.#errorPage && wantsPage(req)) {
          try {
            context.loadedSession = await this.#sessions.load(req, context.cookies);
          } catch {
            // A broken session cookie shouldn't turn a 404 into a 500.
          }
        }
        let out = (await this.#recover(error, undefined, context, scope, undefined)) ?? (await this.#errorOut(error, req));
        for (const name in headers) {
          if (name === "vary") addVary(out.headers, headers[name]!);
          else out.headers[name] = headers[name]!;
        }
        try {
          out = await primeStream(out);
        } catch (renderError) {
          requestLog.error("the error page itself failed", { error: renderError });
          out = { ...errorResponse(error), headers: { ...errorResponse(error).headers, ...headers } };
        }
        // The error page's layouts may show the visitor's state, like any page (see #serve).
        if (context.loadedSession?.payload !== undefined && out.headers["cache-control"] === undefined && (out.headers["content-type"] ?? "").startsWith("text/html")) {
          out.headers["cache-control"] = "private, no-cache";
        }
        await send(res, out, method === "HEAD", undefined);
      });
    } finally {
      if (!scope.isEmpty) await scope.dispose().catch((error) => requestLog.error("failed to dispose request services", { error }));
    }
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
  async #recover(error: unknown, handler: Handler | undefined, context: RequestContext, scope: Scope, dynamic: "fallback" | "only" | undefined): Promise<Outgoing | undefined> {
    try {
      for (const entry of handler ? (CATCHES.from(handler.def.metadata) ?? []) : []) {
        if (entry.types.length > 0 && !entry.types.some((type) => error instanceof (type as new () => unknown))) continue;
        const instance = this.#routeInstance(handler!, scope);
        const result = await (instance[entry.method] as (error: unknown) => unknown).call(instance, error);
        if (result === undefined) continue;
        // A @catches naming the error's class handles it on purpose (debug);
        // a catch-all might be hiding a bug (warn).
        return await this.#recovered(error, result, handler!.layouts, context, dynamic, `${handler!.def.className}.${String(entry.method)}`, entry.types.length > 0 ? "debug" : "warn");
      }
      if (this.#onError) {
        const result = await this.#onError(error, context);
        if (result !== undefined) return await this.#recovered(error, result, this.#layouts, context, dynamic, "app.onError", "warn");
      }
    } catch (handlerError) {
      // The error handler failed too: the error page reports that one.
      requestLog.error("an error handler threw", { error: handlerError });
      return undefined;
    }
    return undefined;
  }

  async #recovered(
    error: unknown,
    result: unknown,
    layouts: Component<LayoutProps>[],
    context: RequestContext,
    dynamic: "fallback" | "only" | undefined,
    by: string,
    level: "debug" | "warn",
  ): Promise<Outgoing> {
    if (!(error instanceof HttpError)) requestLog.log(level, error instanceof Error ? error.message : "request failed", { handledBy: by }, error);
    // A returned res(..., { status }) or number says the status; otherwise it's the error's.
    let out = await coerce(result, { layouts, meta: context.meta, dynamic });
    if (!out.explicitStatus) out.status = error instanceof HttpError ? error.status : 500;
    if (isPageStream(out)) out = await primeStream(out);
    return out;
  }

  #runMiddleware(context: YerdContext, inner: () => Promise<Outgoing>): Promise<Outgoing> {
    const chain = this.#middleware;
    const step = (i: number): Promise<Outgoing> => (i < chain.length ? chain[i]!(context, () => step(i + 1)) : inner());
    return step(0);
  }

  /** Run a handler's guards; returns the response if one of them doesn't let the request through. */
  async #runGuards(guards: readonly GuardSpec[], layouts: Component<LayoutProps>[], context: YerdContext): Promise<Outgoing | undefined> {
    for (const spec of guards) {
      const resolved: ResolvedGuard = isGuardRef(spec) ? { label: spec.label, run: spec.run } : this.#namedGuards.get(spec)!;
      const result = await resolved.run(context);
      if (result === true || result === undefined) continue;
      if (result === false) throw new HttpError(403, "Forbidden");
      // Returning an error (e.g. `ok || new HttpError(403)`) is the same as throwing it.
      if (result instanceof Error) throw result;
      if (typeof result === "string") return coerce(new YerdResponse(303, { location: result }, null), { layouts: [] });
      return coerce(result, { layouts, meta: context.meta });
    }
    return undefined;
  }

  /**
   * Run an action if the posted form carries an action token. Returns undefined
   * for ordinary form posts, which then go to the route's @post handler.
   */
  async #dispatchAction(candidates: Handler[], context: YerdContext, scope: Scope): Promise<Outgoing | undefined> {
    const parsed = await context.body();
    if (parsed.kind !== "form") return undefined;
    // The last one wins: a submit button with formaction={action} carries its
    // own `_yx`, which comes after the form's hidden one in tree order.
    const raw = parsed.value._yx;
    const token = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    if (token === undefined) return undefined;

    // Cross-site posts were already refused before routing (see crossSiteReason);
    // the token must also be this app's, unexpired, and made for this session.
    let payload: ReturnType<typeof verifyAction>;
    let owner: (typeof candidates)[number] | undefined;
    try {
      payload = verifyAction(this.#secrets, token);
      const session = (context as RequestContext).loadedSession?.session;
      checkActionToken(payload, session?.get(CSRF_FIELD), this.#sessions !== undefined);
      owner = candidates.find((h) => h.def.className === payload.c && ACTIONS.from(h.def.metadata)?.has(payload.a));
      if (!owner) throw new HttpError(400, "Unknown action");
    } catch (error) {
      // The page is older than the server (a restart with a new secret, a
      // deploy, an expired or other-session token): tell the runtime, which
      // refreshes the page so the next try works.
      if (error instanceof HttpError && context.headers["yx"] !== undefined) {
        return { status: error.status, headers: { "yx-stale": "1", "content-type": "text/plain; charset=utf-8" }, body: error.message };
      }
      throw error;
    }
    // The class's guards (app, group, route) and the action's own method guards.
    const guards = [...owner.classGuards, ...(METHOD_GUARDS.from(owner.def.metadata)?.get(payload.a) ?? [])];
    const blocked = await this.#runGuards(guards, owner.layouts, context);
    if (blocked) return blocked;

    (context as RequestContext).declared = METHOD_RESPONSE.from(owner.def.metadata)?.get(payload.a);
    const instance = this.#routeInstance(owner, scope);
    const fn = instance[payload.a] as (args: unknown, form: ActionForm) => unknown;
    const args = fillHoles(payload.p, payload.h, parsed.value);
    const result = await fn.call(instance, args, new ActionForm(parsed.value, parsed.files));

    const fromScript = context.headers["yx"] !== undefined;
    if (fromScript) {
      // fetch() would follow a redirect itself; tell the runtime instead.
      if (result instanceof YerdResponse && result.status >= 300 && result.status < 400 && result.headers.location) {
        return { status: 200, headers: { "yx-location": result.headers.location }, body: null };
      }
      // Nothing returned: the runtime refreshes the page's regions.
      if (result === undefined || result === null) return { status: 204, headers: {}, body: null };
      // JSX comes back bare: just the regions, no layouts.
      return coerce(isYerdNode(result) ? result : result, { layouts: [], meta: context.meta });
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
    const timeout = this.#options.shutdownTimeout ?? 10_000;

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
  return new YerdResponse(303, { location: safeBack(back, safeBack(context.path, "/")) }, null);
}

/** A class's decorator metadata and its ancestors' (subclass metadata prototype-chains to the parent's). */
function metadataChain(cls: Function): object[] {
  const chain: object[] = [];
  for (let md: object | null = metadataOfClass(cls); md && md !== Object.prototype; md = Object.getPrototypeOf(md)) chain.push(md);
  return chain;
}

function metadataOfClass(cls: Function): DecoratorMetadataObject {
  return ((cls as unknown as Record<symbol, unknown>)[Symbol.metadata!] as DecoratorMetadataObject | undefined) ?? {};
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

function errorResponse(error: unknown): Outgoing {
  const status = typeof error === "number" ? error : error instanceof HttpError ? error.status : 500;
  if (typeof error !== "number" && !(error instanceof HttpError && error.expose)) {
    if (status >= 500) requestLog.error(error instanceof Error ? error.message : "request failed", { error });
  }
  const message =
    error instanceof HttpError && error.expose ? error.message : STATUS_TEXT[status] ?? `HTTP ${status}`;
  if (error instanceof HttpError && error.expose && error.details) {
    return {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: message, ...error.details }),
    };
  }
  return { status, headers: { "content-type": "text/plain; charset=utf-8" }, body: message };
}

// The runtime script (plus custom attributes' client halves), compressed once
// per distinct source: ~35 KB raw, ~8 KB brotli. `no-cache` with an ETag, so
// browsers revalidate (a 304) instead of downloading it on every page.
let runtimeAsset: { source: string; etag: string; br: Uint8Array; gzip: Uint8Array; raw: Uint8Array } | undefined;

function runtimeResponse(req: IncomingMessage): Outgoing {
  const source = runtimeSource() + attributesSource();
  if (runtimeAsset?.source !== source) {
    const raw = Buffer.from(source);
    runtimeAsset = {
      source,
      etag: `"${createHash("sha256").update(raw).digest("base64url").slice(0, 16)}"`,
      br: brotliCompressSync(raw),
      gzip: gzipSync(raw),
      raw,
    };
  }
  const asset = runtimeAsset;
  const headers: Record<string, string> = {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "no-cache",
    etag: asset.etag,
    vary: "accept-encoding",
  };
  const inm = req.headers["if-none-match"];
  if (inm && inm.split(",").some((tag) => tag.trim() === asset.etag || tag.trim() === `W/${asset.etag}`)) {
    return { status: 304, headers, body: null };
  }
  const accept = req.headers["accept-encoding"] ?? "";
  if (acceptsEncoding(accept, "br")) return { status: 200, headers: { ...headers, "content-encoding": "br" }, body: asset.br };
  if (acceptsEncoding(accept, "gzip")) return { status: 200, headers: { ...headers, "content-encoding": "gzip" }, body: asset.gzip };
  return { status: 200, headers, body: asset.raw };
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value?.split(",")[0]!.trim();
}

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
  const host = (trustProxy ? firstHeader(headers["x-forwarded-host"]) : undefined) ?? headers.host;
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
  if (!contentType) return false;
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return type === "application/x-www-form-urlencoded" || type === "multipart/form-data";
}

/** A browser page load or one of the runtime's own requests. */
function wantsPage(req: IncomingMessage): boolean {
  const headers = req.headers;
  return (headers.accept ?? "").includes("text/html") || headers["yx"] !== undefined || headers["yx-dynamic"] !== undefined;
}

/** Add to Vary instead of replacing what a handler already set. */
function addVary(headers: Record<string, string>, value: string): void {
  const existing = headers.vary;
  if (!existing) headers.vary = value;
  else if (!existing.toLowerCase().split(/\s*,\s*/).includes(value.toLowerCase())) headers.vary = `${existing}, ${value}`;
}

/**
 * Pull a page stream's first chunk now (errors surface here, while there is
 * still time to send the error page) and hand back a body that replays it.
 * Long-lived streams are left alone: their first item may be minutes away.
 */
function isPageStream(out: Outgoing): boolean {
  const body = out.body;
  return body !== null && typeof body !== "string" && !(body instanceof Uint8Array) && out.headers[LONG_LIVED] === undefined;
}

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

async function send(res: ServerResponse, out: Outgoing, headOnly: boolean, signal: AbortSignal | undefined): Promise<void> {
  // Copied rather than reused: handlers may hand back a headers object they share.
  const headers: Record<string, string | string[]> = { "x-content-type-options": "nosniff" };
  for (const name in out.headers) if (name !== LONG_LIVED) headers[name] = out.headers[name]!;
  const longLived = out.headers[LONG_LIVED] !== undefined;
  if (out.cookies?.length) headers["set-cookie"] = out.cookies;
  const { body } = out;

  if (body === null || typeof body === "string" || body instanceof Uint8Array) {
    if (body !== null) headers["content-length"] = String(typeof body === "string" ? Buffer.byteLength(body) : body.byteLength);
    res.writeHead(out.status, headers);
    res.end(headOnly || body === null ? undefined : body);
    return;
  }

  const iterator = body[Symbol.asyncIterator]();
  let first: IteratorResult<string | Uint8Array> | undefined;
  if (longLived) {
    // Long-lived streams (SSE, NDJSON): headers go out now, so the client is
    // connected even if the first item is a long way off.
    res.writeHead(out.status, headers);
    res.flushHeaders();
  } else {
    // Pages: pull the first chunk before committing headers, so an error in
    // the top of the page (layouts, early components) still becomes a 500.
    try {
      first = await iterator.next();
    } catch (error) {
      return send(res, errorResponse(error), headOnly, signal);
    }
    res.writeHead(out.status, headers);
  }
  if (headOnly) {
    await iterator.return?.();
    res.end();
    return;
  }

  // Client gone or server shutting down: stop pulling and let the source's
  // finally blocks run.
  const stopped = new Promise<"stopped">((resolve) => {
    if (signal?.aborted) resolve("stopped");
    signal?.addEventListener("abort", () => resolve("stopped"), { once: true });
  });

  try {
    let next = first ?? (await Promise.race([iterator.next(), stopped]));
    while (next !== "stopped" && !next.done) {
      if (!res.write(next.value)) {
        const drained = await Promise.race([once(res, "drain").then(() => "drained" as const), stopped]);
        if (drained === "stopped") break;
      }
      next = await Promise.race([iterator.next(), stopped]);
    }
    if (signal?.aborted) {
      void iterator.return?.();
      res.end();
    } else {
      res.end();
    }
  } catch (error) {
    // Headers are already out; the best we can do is log and cut the response.
    requestLog.error("response failed after headers were sent", { error });
    res.destroy(error as Error);
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
