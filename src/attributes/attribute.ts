import { checkTrigger, type LoadTrigger } from "../render/lazy.js";

/**
 * Custom attributes, after loom's @attribute controllers: behaviour attached
 * to any element by an attribute, instead of a custom tag.
 *
 * ```tsx
 * export const tooltip = attribute("tooltip", {
 *   // Server half (optional): what the JSX prop renders as.
 *   render: (text: string) => ({ tooltip: text, "aria-label": text }),
 *   // Client half (optional): runs in the browser whenever an element has the
 *   // attribute, whether it came from the first page load, a morph or a boost.
 *   client(el, value) {
 *     el.title = value;
 *     return { update(next) { el.title = next; }, disconnect() { el.title = ""; } };
 *   },
 * });
 *
 * <button tooltip="Delete this todo">x</button>
 * ```
 *
 * The client half is sent to the browser as source text (`fn.toString()`,
 * appended to /_yerd/runtime.js), so like the runtime itself it must be
 * self-contained: no imports, nothing from the enclosing module. Everything it
 * needs comes in through its arguments, including `yerd`, the runtime's API.
 *
 * A client half that needs imports can be a module instead:
 * `client: "src/attrs/sortable.client.ts"`, loaded only where it's used.
 *
 * JSX types: declare the prop once, so `<button tooltip="...">` type-checks.
 *
 * ```ts
 * declare module "@toyz/yerd" { interface CustomAttributes { tooltip?: string } }
 * ```
 */

/**
 * What a client half returns: nothing, a cleanup function (run when the
 * element goes away), or hooks: `update` when the attribute's value changes
 * in a morph, `disconnect` when the element goes away.
 *
 * ```ts
 * export const autosize = attribute("autosize", {
 *   client(el) {
 *     const fit = () => {
 *       el.style.height = "auto";
 *       el.style.height = `${el.scrollHeight}px`;
 *     };
 *     el.addEventListener("input", fit);
 *     fit();
 *     return () => el.removeEventListener("input", fit);
 *   },
 * });
 * ```
 */
export type AttributeHandle = void | (() => void) | { update?(value: string): void; disconnect?(): void };

/**
 * Updating the page from client code: what a Region update, a boosted link
 * and a live refresh do, on demand.
 */
export interface PageApi {
  /**
   * Re-fetch the current page and morph its Regions.
   *
   * ```ts
   * client(el, _value, yerd) {
   *   el.addEventListener("click", () => yerd.page.refresh());
   * }
   * ```
   */
  refresh(): Promise<void>;
  /**
   * Boosted navigation to a same-origin URL; `push` adds a history entry.
   *
   * ```ts
   * client(el, url, yerd) {
   *   el.addEventListener("click", () => yerd.page.load(url, true));
   * }
   * ```
   */
  load(url: string, push: boolean): Promise<void>;
  /**
   * Apply the Regions in an HTML string to the page; returns how many matched.
   *
   * ```ts
   * client(_el, url, yerd) {
   *   const source = new EventSource(url);
   *   source.addEventListener("message", (e) => yerd.page.apply(e.data));
   *   return () => source.close();
   * }
   * ```
   */
  apply(html: string): number;
  /**
   * Patch `from` in place until it matches `to`, the way a Region update
   * does (elements matched by id or key keep their focus, scroll and input
   * state).
   *
   * ```ts
   * client(el, _value, yerd) {
   *   const next = el.cloneNode(true) as HTMLElement;
   *   next.querySelector("li")?.remove();
   *   yerd.page.morph(el, next);
   * }
   * ```
   */
  morph(from: Node, to: Node): void;
}

/** The runtime's short-lived cache of pages and JSON, the one boosted navigation reads. */
export interface NetApi {
  /**
   * Warm the cache with a page (for boosted navigation) or a JSON response.
   *
   * ```ts
   * client(el, url, yerd) {
   *   el.addEventListener("pointerenter", () => yerd.net.prefetch(url));
   * }
   * ```
   */
  prefetch(url: string, as?: "page" | "json"): void;
  /**
   * fetch(), answered from the cache when a fresh JSON prefetch of the same URL exists.
   *
   * ```ts
   * client(el, url, yerd) {
   *   yerd.net.fetch(url).then(async (res) => {
   *     el.textContent = String(((await res.json()) as { visits: number }).visits);
   *   });
   * }
   * ```
   */
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/** What ClockApi.sync() measured. */
export interface ClockReading {
  /** The server's time when the promise settled, in ms (its `Date.now()`). */
  now: number;
  /** Server time minus this page's time, in ms. */
  offset: number;
  /** The round trip the measurement was made over, in ms. */
  rtt: number;
}

/** The server's clock, as this page measured it: what `sync` and cues are timed by. */
export interface ClockApi {
  /**
   * The server's time now, in ms (its `Date.now()`), as best this page can
   * tell. Until the clock has been measured (see sync()), it's this page's own.
   *
   * ```ts
   * client(el, _value, yerd) {
   *   const tick = setInterval(() => (el.textContent = new Date(yerd.clock.now()).toLocaleTimeString()), 1000);
   *   return () => clearInterval(tick);
   * }
   * ```
   */
  now(): number;
  /**
   * Measure the server's clock (once per page; later calls share it).
   *
   * ```ts
   * client(el, value, yerd) {
   *   const at = Number(value); // a server timestamp
   *   void yerd.clock.sync().then(({ now }) => setTimeout(() => el.classList.add("go"), at - now));
   * }
   * ```
   */
  sync(): Promise<ClockReading>;
}

/**
 * The runtime API (window.yerd), which a client half also receives as its
 * third argument, grouped by job: `page` updates the page, `net` is the
 * prefetch cache, `clock` is the server's time.
 *
 * ```ts
 * export const poll = attribute("poll", {
 *   client(_el, value, yerd) {
 *     const timer = setInterval(() => yerd.page.refresh(), Number(value) * 1000);
 *     return () => clearInterval(timer);
 *   },
 * });
 *
 * // <div poll={30} hidden />: refresh the page's Regions every 30 seconds
 * ```
 */
export interface YerdClient {
  /** Refresh, navigate, apply Regions, morph. See PageApi. */
  readonly page: PageApi;
  /** Prefetch and the cached fetch. See NetApi. */
  readonly net: NetApi;
  /** The server's clock. See ClockApi. */
  readonly clock: ClockApi;
  /**
   * Register a client attribute's setup at runtime (attribute() on the
   * server does this for you).
   *
   * ```ts
   * yerd.attribute("data-shout", (el, value) => void (el.textContent = value.toUpperCase()));
   * ```
   */
  attribute(name: string, setup: ClientSetup): void;
}

/**
 * The client half: called once per element that has the attribute, with the
 * element, the attribute's value, and the runtime API. Usually written inline
 * in attribute(); the type is for writing one on its own. It's sent to the
 * browser as source, so keep it self-contained.
 *
 * ```ts
 * const copy: ClientSetup = (el, value) => {
 *   const onClick = () => navigator.clipboard.writeText(value);
 *   el.addEventListener("click", onClick);
 *   return () => el.removeEventListener("click", onClick);
 * };
 *
 * export const copyText = attribute("copy-text", { client: copy });
 * ```
 */
export type ClientSetup = (el: HTMLElement, value: string, yerd: YerdClient) => AttributeHandle;

/**
 * The server half: turns the prop's value into the attributes actually
 * written. It also gets the element's tag and props, so it can act per
 * element. Return null or undefined to write nothing.
 *
 * ```ts
 * const external: RenderAttribute<boolean> = (on, { tag }) =>
 *   on && tag === "a" ? { target: "_blank", rel: "noopener noreferrer" } : null;
 *
 * export const externalLink = attribute("external", { render: external });
 *
 * // <a href="https://example.com" external>: target="_blank" rel="noopener noreferrer"
 * ```
 */
export type RenderAttribute<V> = (value: V, element: { tag: string; props: Readonly<Record<string, unknown>> }) => Record<string, unknown> | null | undefined;

/** The two halves of a custom attribute, for attribute(). Both are optional. */
export interface AttributeOptions<V> {
  /**
   * Server half: the attributes to write for the prop's value; null or
   * undefined writes nothing. Without it the prop is written under its own
   * name, objects as JSON.
   */
  render?: RenderAttribute<V>;
  /**
   * Client half: a self-contained function (sent as source), or a client
   * module's path whose default export is that function, loaded when needed.
   *
   * ```ts
   * export const sortable = attribute("sortable", { client: "src/attrs/sortable.client.ts", when: "visible" });
   * ```
   */
  client?: ClientSetup | string;
  /**
   * With a module client half: when to import it. Default "load".
   *
   * ```ts
   * attribute("confetti", { client: "src/attrs/confetti.client.ts", when: "interaction" });
   * ```
   */
  when?: LoadTrigger;
}

/** A defined custom attribute, as returned by attribute(). */
export interface AttributeDef<V = unknown> {
  /** The attribute (and JSX prop) name. */
  readonly name: string;
  /** The server half, if any. */
  readonly render: RenderAttribute<V> | undefined;
  /** The client half, if any: a function, or a client module's source path. */
  readonly client: ClientSetup | string | undefined;
  /** When a module client half is imported; undefined for an inline one. */
  readonly when: LoadTrigger | undefined;
}

const VALID_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** User attributes; reset by the Vite plugin on reload. Built-ins live apart, so a reset keeps them. */
const registry = new Map<string, AttributeDef<any>>();
const builtins = new Map<string, AttributeDef<any>>();
/** Props the renderer handles itself (server-timed animation), so a custom attribute by that name would never run. */
const RESERVED = new Set(["sync", "cue"]);
let version = 0;

/** Server-side lookup used by the renderer: the def for a prop name, if it's a custom attribute. */
export function customAttribute(name: string): AttributeDef<any> | undefined {
  return registry.get(name) ?? builtins.get(name);
}

/**
 * Define a custom attribute. Call it at module level in a file both the
 * server imports (so the renderer knows the prop) and nothing else needs:
 * the client half travels as text inside the runtime script. Names are
 * lowercase words joined by dashes. Declare the prop on `CustomAttributes`
 * so JSX accepts it.
 *
 * ```tsx
 * export const tooltip = attribute("tooltip", {
 *   render: (text: string) => ({ tooltip: text, "aria-label": text }),
 *   client(el, value) {
 *     el.title = value;
 *     return {
 *       update(next) { el.title = next; },
 *       disconnect() { el.title = ""; },
 *     };
 *   },
 * });
 *
 * declare module "@toyz/yerd" {
 *   interface CustomAttributes {
 *     tooltip?: string;
 *   }
 * }
 *
 * <button tooltip="Delete this todo">x</button>
 * ```
 */
export function attribute<V = string>(name: string, options: AttributeOptions<V>): AttributeDef<V> {
  if (!VALID_NAME.test(name)) throw new TypeError(`Custom attribute names are lowercase words joined by dashes; got ${JSON.stringify(name)}`);
  if (builtins.has(name) || RESERVED.has(name)) throw new TypeError(`"${name}" is a built-in yerd attribute`);
  if (registry.has(name)) throw new TypeError(`Custom attribute "${name}" is defined twice`);
  const { client } = options;
  if (typeof client === "string" && !client) throw new TypeError(`attribute("${name}"): client is an empty module path`);
  if (typeof client !== "string" && options.when !== undefined) throw new TypeError(`attribute("${name}"): \`when\` is for a client half that's a module (client: "src/....client.ts")`);
  const when = typeof client === "string" ? checkTrigger(options.when ?? "load", `attribute("${name}")`) : undefined;
  const def: AttributeDef<V> = { name, render: options.render, client, when };
  registry.set(name, def);
  version++;
  return def;
}

/** Bumped whenever the set of custom attributes changes; the renderer's name cache keys on it. */
export function attributeVersion(): number {
  return version;
}

/**
 * Forget every user-defined custom attribute (built-ins stay). Used by dev
 * servers before re-importing the app. Defining the same name twice throws,
 * so tests that define attributes call it between runs.
 *
 * ```ts
 * import { afterEach } from "vitest";
 * import { resetAttributeRegistry } from "@toyz/yerd";
 *
 * afterEach(() => resetAttributeRegistry());
 * ```
 */
export function resetAttributeRegistry(): void {
  registry.clear();
  version++;
}

function builtin<V>(name: string, render: RenderAttribute<V>): void {
  builtins.set(name, { name, render, client: undefined, when: undefined });
}

/** @internal The custom attributes whose client half is a module: what the lazy chunk loads (see render/lazy.ts lazyRegistry()). */
export function moduleAttributes(): Array<{ name: string; src: string; when: LoadTrigger }> {
  const out: Array<{ name: string; src: string; when: LoadTrigger }> = [];
  for (const def of registry.values()) if (typeof def.client === "string") out.push({ name: def.name, src: def.client, when: def.when! });
  return out;
}

// ── prefetch ──

/**
 * When `prefetch` fires: on hover or focus ("intent"), on scrolling into view ("visible"), or at page load ("load").
 *
 * ```tsx
 * function NavLink({ href, label, when = "intent" }: { href: string; label: string; when?: PrefetchMode }) {
 *   return <a href={href} prefetch={when}>{label}</a>;
 * }
 *
 * <NavLink href="/reports" label="Reports" when="visible" />
 * ```
 */
export type PrefetchMode = "intent" | "visible" | "load";

/**
 * `prefetch` on a link warms the next page before the click: on hover or
 * focus ("intent", the default), when it scrolls into view ("visible"), or
 * as soon as the page loads ("load"). Inside data-yx-boost the page goes into
 * the runtime's cache and the boosted navigation uses it; elsewhere the
 * browser's own <link rel="prefetch"> does it. On any element,
 * `{ url, as: "json" }` warms an API response that `yerd.net.fetch(url)` then
 * answers from the cache.
 *
 * ```tsx
 * <a href="/todos" prefetch>Todos</a>
 * <a href="/reports" prefetch="visible">Reports</a>
 * <section prefetch={{ url: "/api/stats", as: "json", on: "visible" }}>...</section>
 * ```
 *
 * Prefetch requests carry `yx-prefetch: 1`; they're GETs, so handlers must
 * already be free of side effects. Skipped on Save-Data and 2G connections.
 */
export type PrefetchValue = boolean | PrefetchMode | { url: string; on?: PrefetchMode; as?: "page" | "json" };

const MODES = new Set<string>(["intent", "visible", "load"]);

builtin<PrefetchValue>("prefetch", (value, { tag, props }) => {
  if (value === false) return null;
  const options = typeof value === "object" ? value : { on: value === true ? "intent" : value };
  const on = options.on ?? "intent";
  if (!MODES.has(on)) throw new TypeError(`prefetch="${on}" isn't a mode; use "intent", "visible" or "load"`);
  const url = "url" in options ? options.url : undefined;
  if (url === undefined && !((tag === "a" || tag === "area") && typeof props.href === "string")) {
    throw new TypeError(`prefetch on <${tag}> needs an href to prefetch, or prefetch={{ url }}`);
  }
  const as = "as" in options ? options.as : undefined;
  return {
    "data-yx-prefetch": on,
    "data-yx-prefetch-url": url,
    "data-yx-prefetch-as": as === "json" ? "json" : undefined,
  };
});

// ── client source ──

let cached: { version: number; source: string } | undefined;

/** A function's source as an expression, including method shorthand (`client(el) {...}`). */
function sourceExpression(fn: Function, source: string): string {
  // `function ...`, `async function ...`, arrows: already expressions.
  // `async\s*`: minifiers print `async(e)=>...`.
  if (/^(async\s*)?(function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(source)) return source;
  // Method shorthand: evaluate it as a method of a throwaway object.
  return `({ ${source} })[${JSON.stringify(fn.name)}]`;
}

/**
 * The source of a function that runs in the browser (a client half, a
 * <Local> handler: see render/attrs.ts), as an expression. Refuses compiler
 * output that leans on helpers the browser won't have, and functions with no
 * source to send. `label` names the function in the error.
 */
export function selfContainedSource(fn: Function, label: string): string {
  const source = fn.toString();
  if (/\b__(async|awaiter|generator|name)\b/.test(source)) {
    throw new TypeError(`${label} uses a compiler helper (async lowered below ES2017, or keepNames); it's sent to the browser as source, so it must be self-contained`);
  }
  // Built-ins and bind() results print as `function () { [native code] }`.
  if (source.endsWith("{ [native code] }")) {
    throw new TypeError(`${label} is a built-in or bound function; it's sent to the browser as source, so write one inline`);
  }
  return sourceExpression(fn, source);
}

/** Script that registers every client half with the runtime; appended to /_yerd/runtime.js. */
export function attributesSource(): string {
  if (cached?.version === version) return cached.source;
  let lines = "";
  for (const def of registry.values()) {
    // Module client halves are the lazy chunk's.
    if (typeof def.client !== "function") continue;
    lines += `  yerd.attribute(${JSON.stringify(def.name)}, ${selfContainedSource(def.client, `The client half of attribute "${def.name}"`)});\n`;
  }
  const source = lines ? `((yerd) => {\n${lines}})(window.yerd);\n` : "";
  cached = { version, source };
  return source;
}
