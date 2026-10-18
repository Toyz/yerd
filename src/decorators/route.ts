import type { Component } from "../jsx/jsx-runtime.js";
import type { GuardSpec } from "./guards.js";
import { createKey } from "./keys.js";

export type Verb = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "ALL";

export interface VerbEntry {
  verb: Verb;
  method: string | symbol;
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
  title?: string;
  description?: string;
  [key: string]: unknown;
}

/** What every layout component receives. */
export interface LayoutProps {
  children: import("../jsx/jsx-runtime.js").Child;
  meta: PageMeta;
}

export interface RouteOptions {
  /** Name for `url()` building (later milestone). */
  name?: string;
  /** Instance lifetime. Default "scoped": a fresh instance per request. */
  lifetime?: "singleton" | "scoped" | "transient";
  /** A @group class: its prefix, layout and meta apply to this route. */
  group?: Function;
  /** Page metadata for layouts; overrides group meta. */
  meta?: PageMeta;
  /** Guards (names or value guards) run before every handler and action of this route, after group guards. */
  guards?: GuardSpec[];
}

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

// guards.ts's class-guard key, by name (createKey returns the same key), to
// read @guards written on a group class without importing guards.ts here.
const GROUP_CLASS_GUARDS = createKey<GuardSpec[]>("guards:class");

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

export interface PrerenderOptions {
  /** Concrete paths for patterns with params: a list, or a function (it may use services via resolve()). */
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
 * ```ts
 * @prerender @route("/about") class About { ... }
 * @prerender({ paths: () => resolve(Docs).slugs().map((s) => `/docs/${s}`) }) @route("/docs/:slug") class Doc { ... }
 * ```
 */
export function prerender(value: Function, context: ClassDecoratorContext): void;
export function prerender(options?: PrerenderOptions): (value: Function, context: ClassDecoratorContext) => void;
export function prerender(a?: unknown, b?: unknown): unknown {
  const apply = (options: PrerenderOptions) => (_value: Function, context: ClassDecoratorContext) => {
    PRERENDER.set(context.metadata, options);
  };
  if (typeof a === "function" && typeof b === "object" && b !== null && (b as { kind?: unknown }).kind === "class") {
    apply({})(a, b as ClassDecoratorContext);
    return undefined;
  }
  return apply((a ?? {}) as PrerenderOptions);
}

/** Every class decorated with @route, in definition order. */
export const routeRegistry: RouteDef[] = [];

/**
 * Forget every registered route. Used by dev servers before re-importing the
 * app, so a reload doesn't register each route twice.
 */
export function resetRouteRegistry(): void {
  routeRegistry.length = 0;
}

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

function verb(name: Verb) {
  const label = name === "DELETE" ? "del" : name.toLowerCase();
  return (_method: Function, context: ClassMethodDecoratorContext): void => {
    if (context.static || context.private) {
      throw new TypeError(`@${label} must decorate a public instance method (got ${String(context.name)})`);
    }
    VERBS.ownArray<VerbEntry>(context.metadata).push({ verb: name, method: context.name });
  };
}

export const get = verb("GET");
export const post = verb("POST");
export const put = verb("PUT");
export const patch = verb("PATCH");
export const del = verb("DELETE");
export const head = verb("HEAD");
export const options = verb("OPTIONS");
export const all = verb("ALL");

/**
 * Wrap JSX results in layouts, outermost first, inside the app's and groups'
 * layouts. On a route class it covers every handler; on a handler method,
 * just that one (innermost); on a @group class, every member route.
 * With `{ inherit: false }` they're the whole chain: no app root layouts, no
 * group layouts. A layout already in the inherited chain isn't applied twice,
 * so a route may name its full chain for readability.
 *
 * ```ts
 * @layout(RootLayout, MarketingLayout)          // RootLayout is the app's anyway
 * @route("/about") class About { ... }
 *
 * @route("/report") class Report {
 *   @get page() { ... }
 *   @get("/print") @layout(PrintLayout, { inherit: false }) print() { ... }
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
export function accepts(...types: string[]) {
  if (types.length === 0) throw new TypeError("@accepts needs at least one type");
  return (_method: Function, context: ClassMethodDecoratorContext): void => {
    const map = ACCEPTS.hasOwn(context.metadata) ? ACCEPTS.from(context.metadata)! : new Map(ACCEPTS.from(context.metadata));
    map.set(context.name, types);
    ACCEPTS.set(context.metadata, map);
  };
}

/** Render this handler's JSX with no layouts at all (partials, fragments, embeds). */
export function noLayout(_method: Function, context: ClassMethodDecoratorContext): void {
  const set = NO_LAYOUT.hasOwn(context.metadata) ? NO_LAYOUT.from(context.metadata)! : new Set(NO_LAYOUT.from(context.metadata));
  set.add(context.name);
  NO_LAYOUT.set(context.metadata, set);
}

/**
 * A route group: one prefix, layout and meta for many routes. Routes join with
 * `@route(path, { group: Admin })`; groups nest with `{ group: Parent }`.
 *
 * ```ts
 * @group("/admin", { layout: AdminLayout, meta: { section: "admin" } })
 * class Admin {}
 *
 * @route("/users", { group: Admin }) // serves /admin/users
 * class AdminUsers { ... }
 * ```
 */
export function group(prefix: string, options: GroupOptions = {}) {
  if (!prefix.startsWith("/")) throw new TypeError(`@group prefix must start with "/": ${JSON.stringify(prefix)}`);
  return (_value: Function, context: ClassDecoratorContext): void => {
    GROUP.set(context.metadata, { className: String(context.name ?? "anonymous"), prefix, options });
  };
}

function metadataOf(cls: Function): DecoratorMetadataObject {
  return ((cls as unknown as Record<symbol, unknown>)[Symbol.metadata!] as DecoratorMetadataObject | undefined) ?? {};
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
    guards.push(...(g.options.guards ?? []), ...(GROUP_CLASS_GUARDS.from(metadata) ?? []));
  }
  const own = LAYOUT.from(def.metadata);
  if (own?.isolated) isolated = true;
  layouts = applyLayouts(layouts, own);
  guards.push(...(def.options.guards ?? []));
  return { pattern: joinPaths(prefix, def.pattern), layouts, isolated, meta: { ...meta, ...def.options.meta }, guards };
}
