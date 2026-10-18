import type { Component } from "../jsx/jsx-runtime.js";
import { CLASS_GUARDS, type GuardRef, type GuardSpec } from "./guards.js";
import type { YerdContext } from "../server/context.js";
import { isMediaType, type MediaType } from "../respond/negotiate.js";
import { createKey, metadataOf } from "./keys.js";
import { assertPublicInstance, isDecoratorContext } from "./util.js";

/**
 * An HTTP method a handler can answer. "ALL" answers any method the route has
 * no specific handler for. `ctx.method` is a plain string (a client can send
 * any method), so compare against a Verb list rather than casting blindly:
 *
 * ```ts
 * const writes: Verb[] = ["POST", "PUT", "PATCH", "DELETE"];
 *
 * const maintenance: Middleware = async (ctx, next) => {
 *   if (writes.includes(ctx.method as Verb)) throw new HttpError(503, "Read-only during maintenance");
 *   return next();
 * };
 * ```
 */
export type Verb = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "ALL";

export interface VerbEntry {
  verb: Verb;
  method: string | symbol;
  /** Set by `@get(when)`: this handler serves only requests the test accepts. */
  when?: { test: When; vary: string | undefined };
}

/**
 * A test that picks a handler for a request: truthy means "this handler serves
 * it". If its answer depends on a request header, build it with varies() so
 * responses carry the matching Vary header (isBot is built that way).
 * A test that reads only the URL needs no Vary:
 *
 * ```tsx
 * const preview: WhenTest = (ctx) => ctx.query.has("preview");
 *
 * @route("/dashboard")
 * class Dashboard {
 *   @get(preview) next() { return <NewDashboard />; }
 *   @get page() { return <OldDashboard />; }
 * }
 * ```
 */
export type WhenTest = ((ctx: YerdContext) => unknown) & { readonly vary?: string };

/**
 * A request test for `@get(when)`: a function (truthy means match), or a
 * guard from createGuard() (letting the request through means match; a guard
 * that fails here turns nobody away, the next handler gets the request).
 *
 * ```tsx
 * const staff = createGuard("staff", (ctx) => ctx.headers["x-staff"] === "yes");
 *
 * @route("/report")
 * class Report {
 *   @get(staff) internal() { return <ReportPage withCosts />; }
 *   @get((ctx) => ctx.query.has("preview")) draft() { return <ReportPage full />; }
 *   @get page() { return <ReportPage />; }
 * }
 * ```
 */
export type When = WhenTest | GuardRef;

/**
 * A request test that depends on a request header. Caches (a CDN, the
 * browser) store one response per URL unless told otherwise; this tells them,
 * through `Vary: <header>` on every response from the route, to keep one per
 * value of that header, so the variant meant for some clients is never served
 * to others.
 *
 * ```tsx
 * const fromApp = varies("x-client", (ctx) => ctx.headers["x-client"] === "app");
 *
 * @get(fromApp) forApp() { return { feed }; }     // Vary: x-client
 * @get page() { return <Feed items={feed} />; }
 * ```
 */
export function varies(header: string, test: (ctx: YerdContext) => unknown): WhenTest {
  return Object.assign((ctx: YerdContext) => test(ctx), { vary: header.toLowerCase() });
}

/**
 * The type of every verb decorator (get, post, put, patch, del, head,
 * options, all): bare (`@get`) for the default handler, or called with a
 * request test (`@get(isBot)`) for a variant. It never takes a path.
 *
 * ```tsx
 * @route("/report")
 * class Report {
 *   @get page() { return <ReportPage />; }                         // bare: the default handler
 *   @get(isBot) crawlable() { return <ReportPage full />; }        // a request test
 *   @get(staffOnly) internal() { return <ReportPage withCosts />; } // a guard, used as a test
 * }
 * ```
 */
export interface VerbDecorator {
  // Order matters: the request-test form comes first so an inline test
  // (`@post(async (ctx) => ...)`) gets `ctx` typed from it.
  // The `never` second parameter keeps a bare `@get` (called with method and
  // context) from matching the test form.
  (when: (ctx: YerdContext) => unknown, _?: never): (method: Function, context: ClassMethodDecoratorContext) => void;
  (guard: GuardRef, _?: never): (method: Function, context: ClassMethodDecoratorContext) => void;
  // A value typed as the When union (either of the above), kept in a variable or passed around.
  (when: When, _?: never): (method: Function, context: ClassMethodDecoratorContext) => void;
  (method: Function, context: ClassMethodDecoratorContext): void;
}


/**
 * Page metadata, handed to every layout as `meta`. Merged root to leaf: group
 * meta, then route meta, then anything the handler sets with setMeta().
 * Extend it with declaration merging:
 *
 * ```ts
 * declare module "@toyz/yerd" { interface PageMeta { section?: string } }
 * ```
 */
export interface PageMeta {
  /** The page title; error pages set it to the error message. */
  title?: string;
  /** The page description, typically for a meta description tag. */
  description?: string;
  /** Anything else your layouts read. Prefer declaring named fields (see above) for type safety. */
  [key: string]: unknown;
}

/**
 * What every layout component receives: the page (or the next layout in) as
 * `children`, and the request's merged page metadata. Register a layout with
 * app.layout(), @layout, a group's `layout` option or `res(x, { layout })`.
 *
 * ```tsx
 * function DocsLayout({ children, meta }: LayoutProps) {
 *   return (
 *     <div class="docs">
 *       <h1>{meta.title ?? "Docs"}</h1>
 *       {children}
 *     </div>
 *   );
 * }
 * ```
 */
export interface LayoutProps {
  /** The page (or the next layout in) to wrap. */
  children: import("../jsx/jsx-runtime.js").Child;
  /** The request's merged page metadata. */
  meta: PageMeta;
}

/**
 * Options for @route, its second argument.
 *
 * ```tsx
 * @route("/users/:id", { group: Admin, meta: { title: "User" }, guards: [staffOnly] })
 * class AdminUser {
 *   @param("id") accessor id!: string;
 *   @get page() { return <h1>User {this.id}</h1>; } // GET /admin/users/:id, inside the group's layout
 * }
 * ```
 */
export interface RouteOptions {
  /**
   * Instance lifetime. Default "scoped": a fresh instance per request.
   * Request accessors (@param, @query, ...) are correct under any lifetime,
   * but plain fields on a singleton are shared by every request.
   *
   * ```tsx
   * @route("/health", { lifetime: "singleton" })
   * class Health {
   *   @get check() { return { ok: true }; }
   * }
   * ```
   */
  lifetime?: "singleton" | "scoped" | "transient";
  /** A @group class: its prefix, layout and meta apply to this route. */
  group?: Function;
  /** Page metadata for layouts; overrides group meta. */
  meta?: PageMeta;
  /** Guards (names or value guards) run before every handler and action of this route, after group guards. */
  guards?: GuardSpec[];
}

/**
 * Options for @group, its second argument.
 *
 * ```ts
 * @group("/admin", { layout: AdminDocument, inheritLayouts: false, guards: [staffOnly], meta: { section: "admin" } })
 * class Admin {}
 *
 * @group("/reports", { group: Admin }) // serves /admin/reports/..., still behind staffOnly
 * class Reports {}
 * ```
 */
export interface GroupOptions {
  /** Layout(s) wrapping every route in the group (inside outer groups' layouts), outermost first. */
  layout?: Component<LayoutProps> | Component<LayoutProps>[];
  /**
   * false: this group's layout starts the chain fresh, without the app's root
   * layouts or outer groups' layouts. For areas with a document of their own
   * (an admin with its own <head> and styles). Default true.
   */
  inheritLayouts?: boolean;
  /** Parent group, for nesting. Prefixes concatenate, layouts nest, meta merges. */
  group?: Function;
  /** Page metadata inherited by member routes. */
  meta?: PageMeta;
  /** Guards run before every member route, outer groups first. */
  guards?: GuardSpec[];
}


export interface GroupDef {
  className: string;
  prefix: string;
  options: GroupOptions;
}

export interface RouteDef {
  ctor: new () => object;
  className: string;
  pattern: string;
  options: RouteOptions;
  metadata: DecoratorMetadataObject;
}

export const VERBS = createKey<VerbEntry[]>("verbs");
/** Layouts declared with @layout on a class (route or group). */
export const LAYOUT = createKey<LayoutSpec>("layout");
/** Layouts declared with @layout on a handler method. */
export const METHOD_LAYOUTS = createKey<Map<string | symbol, LayoutSpec>>("layout:method");

/** A layout declaration: the layouts, outermost first, and whether they replace the inherited chain. */
export interface LayoutSpec {
  layouts: Component<LayoutProps>[];
  isolated: boolean;
}

export interface LayoutOptions {
  /**
   * false: these layouts are the whole chain, without the app's root layouts
   * or group layouts (a print view, an embed, a page with its own document).
   */
  inherit?: boolean;
}

/**
 * Put `inner` inside `outer`, skipping layouts the chain already has: wrapping
 * the same layout twice (two <html>s) is never what anyone wants, and it lets
 * a route spell out its whole chain, `@layout(RootLayout, MarketingLayout)`,
 * when the app already applies RootLayout.
 */
export function joinLayouts(outer: readonly Component<LayoutProps>[], inner: readonly Component<LayoutProps>[]): Component<LayoutProps>[] {
  if (inner.length === 0) return outer as Component<LayoutProps>[];
  const out = outer.slice();
  for (const layout of inner) if (!out.includes(layout)) out.push(layout);
  return out;
}

/** Apply a declaration to an inherited chain. */
export function applyLayouts(inherited: readonly Component<LayoutProps>[], spec: LayoutSpec | undefined): Component<LayoutProps>[] {
  if (!spec) return inherited as Component<LayoutProps>[];
  return spec.isolated ? joinLayouts([], spec.layouts) : joinLayouts(inherited, spec.layouts);
}

/** Split `@layout(A, B, { inherit })` / `res(x, { layout })` arguments into a spec. */
export function layoutSpec(args: ReadonlyArray<Component<LayoutProps> | LayoutOptions>): LayoutSpec {
  const last = args[args.length - 1];
  const options = typeof last === "object" && last !== null ? (last as LayoutOptions) : {};
  const layouts = (typeof last === "object" && last !== null ? args.slice(0, -1) : args) as Component<LayoutProps>[];
  for (const l of layouts) if (typeof l !== "function") throw new TypeError("@layout takes layout components, then optionally { inherit }");
  if (layouts.length === 0 && options.inherit !== false) throw new TypeError("@layout needs at least one layout (or { inherit: false } for none: see @noLayout)");
  return { layouts, isolated: options.inherit === false };
}
export const GROUP = createKey<GroupDef>("group");
export const NO_LAYOUT = createKey<Set<string | symbol>>("no-layout");
export const ACCEPTS = createKey<Map<string | symbol, string[]>>("accepts");

/** Options for @prerender. */
export interface PrerenderOptions {
  /**
   * Concrete paths for patterns with params: a list, or a function (it may be
   * async and use services via resolve()). Each path must match the route.
   *
   * ```tsx
   * @prerender({ paths: async () => (await resolve(Docs).slugs()).map((slug) => `/docs/${slug}`) })
   * @route("/docs/:slug")
   * class Doc {
   *   @param("slug") accessor slug!: string;
   *   @get page() { return <article>{this.slug}</article>; }
   * }
   * ```
   */
  paths?: readonly string[] | (() => readonly string[] | Promise<readonly string[]>);
}
export const PRERENDER = createKey<PrerenderOptions>("prerender");

/**
 * Render this route's GET to a static file at build time (`vite build`).
 * HTML becomes `<path>/index.html`; anything else (JSON, XML, text) is written
 * to the path itself, so give those routes an extension: `@route("/config.json")`.
 *
 * Prerendered routes can't read request data (query, headers, cookies,
 * session, body, the signed-in user): the build fails, naming the route and
 * what it read, rather than freezing one request's data into a file. Patterns
 * with params need `paths`.
 *
 * ```tsx
 * @prerender
 * @route("/about")
 * class About {
 *   @get page() { return <h1>About us</h1>; }
 * }
 *
 * @prerender({ paths: ["/docs/intro", "/docs/setup"] })
 * @route("/docs/:slug")
 * class Doc {
 *   @param("slug") accessor slug!: string;
 *   @get page() { return <article>{this.slug}</article>; }
 * }
 * ```
 */
export function prerender(value: Function, context: ClassDecoratorContext): void;
export function prerender(options?: PrerenderOptions): (value: Function, context: ClassDecoratorContext) => void;
export function prerender(a?: unknown, b?: unknown): unknown {
  const apply = (options: PrerenderOptions) => (_value: Function, context: ClassDecoratorContext) => {
    PRERENDER.set(context.metadata, options);
  };
  if (typeof a === "function" && isDecoratorContext(b, "class")) {
    apply({})(a, b);
    return undefined;
  }
  return apply((a ?? {}) as PrerenderOptions);
}

/** Every class decorated with @route, in definition order. */
export const routeRegistry: RouteDef[] = [];

/**
 * Forget every registered route. Used by dev servers before re-importing the
 * app, so a reload doesn't register each route twice. Tooling only; an app
 * at hand should use app.resetRegistries(), which also clears services,
 * guards and attributes.
 *
 * ```ts
 * resetRouteRegistry();
 * await import(`./routes/index.js?t=${Date.now()}`); // routes register afresh
 * ```
 */
export function resetRouteRegistry(): void {
  routeRegistry.length = 0;
}

/**
 * Make a class a route serving `pattern`. Its @get / @post / ... methods
 * handle the verbs, and an instance is created per request by default (see
 * `lifetime`). Patterns take `:name` params and a trailing `*name` splat;
 * the pattern must start with "/". Inside a group, the group's prefix comes
 * first.
 *
 * ```tsx
 * @route("/todos/:id")
 * class TodoPage {
 *   @param("id", { transform: toInt }) accessor id!: number;
 *   @get show() { return <h1>todo {this.id}</h1>; }
 *   @del remove() { return 204; }
 * }
 * ```
 */
export function route(pattern: string, options: RouteOptions = {}) {
  if (!pattern.startsWith("/")) {
    throw new TypeError(`@route pattern must start with "/": ${JSON.stringify(pattern)}`);
  }
  return (value: Function, context: ClassDecoratorContext): void => {
    routeRegistry.push({
      ctor: value as new () => object,
      className: String(context.name ?? "anonymous"),
      pattern,
      options,
      metadata: context.metadata,
    });
  };
}

function verb(name: Verb): VerbDecorator {
  const label = name === "DELETE" ? "del" : name.toLowerCase();
  const attach = (context: ClassMethodDecoratorContext, when?: VerbEntry["when"]): void => {
    assertPublicInstance(context, `@${label}`);
    VERBS.ownArray<VerbEntry>(context.metadata).push({ verb: name, method: context.name, ...(when ? { when } : {}) });
  };
  return function (first: unknown, second?: unknown) {
    if (isDecoratorContext(second)) return attach(second as ClassMethodDecoratorContext);
    if (typeof first !== "function") {
      throw new TypeError(`@${label}(...) takes a request test (a function or a guard), not a path: one route class serves one path`);
    }
    const test = first as When;
    const vary = (test as { vary?: string }).vary;
    return (_method: Function, context: ClassMethodDecoratorContext) => attach(context, { test, vary: vary?.toLowerCase() });
  } as VerbDecorator;
}

/**
 * Handle GET requests to the route's pattern with this method. Also answers
 * HEAD (without the body) unless the route has a @head handler. One route
 * class serves one pattern, so there's no path argument; a second handler for
 * the same verb is a variant: `@accepts(...)` picks by Accept header, and
 * `@get(when)` by any request test.
 *
 * ```tsx
 * @get page() { return <InteractivePage />; }        // everyone else
 * @get(isBot) crawlable() { return <FullPage />; }   // search engines and link previews
 * ```
 */
export const get = verb("GET");
/**
 * Handle POST requests to the route's pattern with this method: typically
 * creating something from a validated body. Cross-site browser POSTs are
 * refused with a 403 before the handler runs (see the `csrf` option).
 *
 * ```tsx
 * class NewTodo {
 *   @is.string({ transform: trim, validate: length(1) }) title!: string;
 * }
 *
 * @route("/todos")
 * class Todos {
 *   @inject(Db) accessor db!: Db;
 *   @body(NewTodo) accessor input!: Promise<NewTodo>;
 *
 *   @post async create() {
 *     const todo = this.db.todos.add(await this.input);
 *     return res(todo, { status: 201, headers: { location: `/todos/${todo.id}` } });
 *   }
 * }
 * ```
 */
export const post = verb("POST");
/**
 * Handle PUT requests to the route's pattern with this method: replacing a
 * resource with the full representation in the body.
 *
 * ```tsx
 * class TodoReplacement {
 *   @is.string({ transform: trim, validate: length(1) }) title!: string;
 *   @is.boolean() done!: boolean;
 * }
 *
 * @route("/todos/:id")
 * class TodoItem {
 *   @inject(Db) accessor db!: Db;
 *   @param("id", { transform: toInt }) accessor id!: number;
 *   @body(TodoReplacement) accessor replacement!: Promise<TodoReplacement>;
 *
 *   @put async replace() {
 *     return this.db.todos.replace(this.id, await this.replacement) ?? 404;
 *   }
 * }
 * ```
 */
export const put = verb("PUT");
/**
 * Handle PATCH requests to the route's pattern with this method: a partial
 * update, so the DTO's fields are optional and a missing one stays as it is.
 *
 * ```tsx
 * class TodoChanges {
 *   @is.string({ optional: true, transform: trim }) title?: string;
 *   @is.boolean({ optional: true }) done?: boolean;
 * }
 *
 * @route("/todos/:id")
 * class TodoItem {
 *   @inject(Db) accessor db!: Db;
 *   @param("id", { transform: toInt }) accessor id!: number;
 *   @body(TodoChanges) accessor changes!: Promise<TodoChanges>;
 *
 *   @patch async update() {
 *     return this.db.todos.update(this.id, await this.changes) ?? 404; // `{ "done": true }` keeps the title
 *   }
 * }
 * ```
 */
export const patch = verb("PATCH");
/**
 * Handle DELETE requests to the route's pattern with this method (`delete`
 * is a reserved word, hence `del`).
 *
 * ```tsx
 * @route("/todos/:id")
 * class TodoItem {
 *   @inject(Db) accessor db!: Db;
 *   @param("id", { transform: toInt }) accessor id!: number;
 *
 *   @del remove() {
 *     return this.db.todos.remove(this.id) ? 204 : 404;
 *   }
 * }
 * ```
 */
export const del = verb("DELETE");
/**
 * Handle HEAD requests with this method. Rarely needed: without one, HEAD
 * runs the @get handler and drops the body. Write one when producing the
 * body just to throw it away is expensive.
 *
 * ```tsx
 * @route("/files/*path")
 * class Download {
 *   @inject(Storage) accessor storage!: Storage;
 *   @param("path") accessor path!: string;
 *
 *   @get async file() {
 *     return res(await this.storage.read(this.path), { headers: { "content-type": mimeType(this.path) } });
 *   }
 *
 *   // Answer from metadata instead of reading the whole file only to drop it.
 *   @head async probe() {
 *     const size = await this.storage.size(this.path);
 *     if (size === undefined) return 404;
 *     currentContext().setHeader("content-length", String(size));
 *     return 200;
 *   }
 * }
 * ```
 */
export const head = verb("HEAD");
/**
 * Handle OPTIONS requests to the route's pattern with this method. Rarely
 * needed: without one (or @all), OPTIONS gets a 405 whose Allow header lists the
 * route's methods. The usual reason to write one is a CORS preflight.
 *
 * ```tsx
 * @route("/api/todos")
 * class TodosApi {
 *   @inject(Db) accessor db!: Db;
 *
 *   @get list() { return this.db.todos.all(); }
 *
 *   // The preflight a browser sends before a cross-origin request.
 *   @options preflight() {
 *     return res(null, {
 *       status: 204,
 *       headers: {
 *         "access-control-allow-origin": "https://app.example.com",
 *         "access-control-allow-methods": "GET",
 *         "access-control-max-age": "86400",
 *       },
 *     });
 *   }
 * }
 * ```
 */
export const options = verb("OPTIONS");
/**
 * Handle every method the route has no specific handler for. A catch-all:
 * with a splat pattern it answers a whole subtree, whatever the method.
 *
 * ```tsx
 * @route("/api/v1/*rest")
 * class RetiredApi {
 *   @all gone(): never {
 *     throw new HttpError(410, "API v1 is retired; use /api/v2");
 *   }
 * }
 * ```
 */
export const all = verb("ALL");

/**
 * Wrap JSX results in layouts, outermost first, inside the app's and groups'
 * layouts. On a route class it covers every handler; on a handler method,
 * just that one (innermost); on a @group class, every member route.
 * With `{ inherit: false }` they're the whole chain: no app root layouts, no
 * group layouts. A layout already in the inherited chain isn't applied twice,
 * so a route may name its full chain for readability.
 *
 * ```tsx
 * @layout(RootLayout, MarketingLayout) // RootLayout is the app's anyway
 * @route("/about")
 * class About {
 *   @get page() { return <p>About us</p>; }
 * }
 *
 * @route("/report/print")
 * class ReportPrint {
 *   @get @layout(PrintLayout, { inherit: false }) page() { return <p>numbers</p>; }
 * }
 * ```
 *
 * Stacked `@layout`s read top to bottom, outermost first.
 */
export function layout(...args: Component<LayoutProps>[] | [...Component<LayoutProps>[], LayoutOptions]) {
  const spec = layoutSpec(args);
  return (_value: unknown, context: ClassDecoratorContext | ClassMethodDecoratorContext): void => {
    // Decorators apply bottom-up; putting this one outside what's already
    // there keeps stacked @layouts in written order.
    const merge = (existing: LayoutSpec | undefined): LayoutSpec =>
      existing ? { layouts: [...spec.layouts, ...existing.layouts], isolated: spec.isolated || existing.isolated } : spec;
    if (context.kind === "class") {
      LAYOUT.set(context.metadata, merge(LAYOUT.hasOwn(context.metadata) ? LAYOUT.from(context.metadata) : undefined));
    } else if (context.kind === "method") {
      const map = METHOD_LAYOUTS.ownMap<string | symbol, LayoutSpec>(context.metadata);
      map.set(context.name, merge(map.get(context.name)));
    } else {
      throw new TypeError("@layout goes on a route or group class, or a handler method");
    }
  };
}

/**
 * Serve this handler only to clients that ask for one of these types in their
 * Accept header. Put it on a second handler for the same verb to offer, say,
 * JSON next to an HTML page. Shorthands: "json", "html", "ndjson", "text",
 * "csv", "xml", "sse"; or full mime types.
 *
 * ```ts
 * @get page() { return <TodoPage todos={todos} />; }
 * @get @accepts("json") data() { return { todos }; }
 * ```
 */
export function accepts(...types: [MediaType, ...MediaType[]]) {
  if (types.length === 0) throw new TypeError("@accepts needs at least one type");
  for (const type of types) {
    if (!isMediaType(type)) throw new TypeError(`@accepts("${type}"): not a media type (use a shorthand like "json" or a type/subtype)`);
  }
  return (_method: Function, context: ClassMethodDecoratorContext): void => {
    assertPublicInstance(context, "@accepts");
    ACCEPTS.ownMap<string | symbol, string[]>(context.metadata).set(context.name, types);
  };
}

/**
 * Render this handler's JSX with no layouts at all (partials, fragments,
 * embeds). For one response only, return `bare(node)` instead.
 *
 * ```tsx
 * // Fetched by a script and swapped into the page: no <html>, no nav.
 * @route("/search/results")
 * class SearchResults {
 *   @query("q") accessor q = "";
 *
 *   @get @noLayout list() {
 *     return <ul>{search(this.q).map((hit) => <li>{hit}</li>)}</ul>;
 *   }
 * }
 * ```
 */
export function noLayout(_method: Function, context: ClassMethodDecoratorContext): void {
  assertPublicInstance(context, "@noLayout");
  NO_LAYOUT.ownSet<string | symbol>(context.metadata).add(context.name);
}

/**
 * A route group: one prefix, layout and meta for many routes. Routes join with
 * `@route(path, { group: Admin })`; groups nest with `{ group: Parent }`.
 *
 * ```tsx
 * @group("/admin", { layout: AdminLayout, meta: { section: "admin" } })
 * class Admin {}
 *
 * @route("/users", { group: Admin }) // serves /admin/users
 * class AdminUsers {
 *   @get list() { return <h1>Users</h1>; }
 * }
 * ```
 */
export function group(prefix: string, options: GroupOptions = {}) {
  if (!prefix.startsWith("/")) throw new TypeError(`@group prefix must start with "/": ${JSON.stringify(prefix)}`);
  return (_value: Function, context: ClassDecoratorContext): void => {
    GROUP.set(context.metadata, { className: String(context.name ?? "anonymous"), prefix, options });
  };
}


function joinPaths(prefix: string, path: string): string {
  if (path === "/") return prefix === "" ? "/" : prefix;
  return (prefix.endsWith("/") ? prefix.slice(0, -1) : prefix) + path;
}

export interface ResolvedRoute {
  pattern: string;
  /** Group layouts, outermost first, then the route's own @layout. */
  layouts: Component<LayoutProps>[];
  /** A group or the route opted out of inherited layouts: the app's root layouts don't apply. */
  isolated: boolean;
  meta: PageMeta;
  /** Group guards outermost first, then the route's `guards` option. */
  guards: GuardSpec[];
}

/** Walk a route's group chain: prefixes concatenate, layouts nest, meta merges (deeper wins). */
export function resolveRoute(def: RouteDef): ResolvedRoute {
  const chain: GroupDef[] = [];
  const seen = new Set<Function>();
  const groupMetadata = new Map<GroupDef, DecoratorMetadataObject>();
  for (let cls = def.options.group; cls; ) {
    if (seen.has(cls)) throw new Error(`group cycle through ${cls.name}`);
    seen.add(cls);
    const metadata = metadataOf(cls);
    const groupDef = GROUP.from(metadata);
    if (!groupDef) throw new Error(`${cls.name} is used as a group but has no @group decorator`);
    chain.unshift(groupDef);
    groupMetadata.set(groupDef, metadata);
    cls = groupDef.options.group;
  }
  let prefix = "";
  let layouts: Component<LayoutProps>[] = [];
  let meta: PageMeta = {};
  const guards: GuardSpec[] = [];
  let isolated = false;
  for (const g of chain) {
    prefix = joinPaths(prefix, g.prefix);
    const metadata = groupMetadata.get(g)!;
    // The group's options and any @layout / @guards written on the group class itself.
    const declared = LAYOUT.from(metadata);
    if (g.options.inheritLayouts === false || declared?.isolated) {
      layouts = [];
      isolated = true;
    }
    const fromOptions = g.options.layout === undefined ? [] : Array.isArray(g.options.layout) ? g.options.layout : [g.options.layout];
    layouts = joinLayouts(joinLayouts(layouts, fromOptions), declared?.layouts ?? []);
    meta = { ...meta, ...g.options.meta };
    guards.push(...(g.options.guards ?? []), ...(CLASS_GUARDS.from(metadata) ?? []));
  }
  const own = LAYOUT.from(def.metadata);
  if (own?.isolated) isolated = true;
  layouts = applyLayouts(layouts, own);
  guards.push(...(def.options.guards ?? []));
  return { pattern: joinPaths(prefix, def.pattern), layouts, isolated, meta: { ...meta, ...def.options.meta }, guards };
}
