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
 * The runtime API a client half receives as its third argument (window.yerd).
 *
 * ```ts
 * export const poll = attribute("poll", {
 *   client(_el, value, yerd) {
 *     const timer = setInterval(() => yerd.refresh(), Number(value) * 1000);
 *     return () => clearInterval(timer);
 *   },
 * });
 *
 * // <div poll={30} hidden />: refresh the page's Regions every 30 seconds
 * ```
 */
export interface YerdClient {
  /**
   * Morph `to` into `from`: patch `from` in place until it matches `to`, the
   * way a Region update does (elements matched by id or key keep their focus,
   * scroll and input state).
   */
  morph(from: Node, to: Node): void;
  /**
   * Apply the Regions in an HTML string to the page; returns how many matched.
   *
   * ```ts
   * client(_el, url, yerd) {
   *   const source = new EventSource(url);
   *   source.addEventListener("message", (e) => yerd.apply(e.data));
   *   return () => source.close();
   * }
   * ```
   */
  apply(html: string): number;
  /**
   * Re-fetch the current page and morph its Regions.
   *
   * ```ts
   * client(el, _value, yerd) {
   *   el.addEventListener("click", () => yerd.refresh());
   * }
   * ```
   */
  refresh(): Promise<void>;
  /**
   * Boosted navigation to a same-origin URL; `push` adds a history entry.
   *
   * ```ts
   * client(el, url, yerd) {
   *   el.addEventListener("click", () => yerd.load(url, true));
   * }
   * ```
   */
  load(url: string, push: boolean): Promise<void>;
  /**
   * Warm the runtime's short-lived cache with a page (for boosted navigation) or a JSON response.
   *
   * ```ts
   * client(el, url, yerd) {
   *   el.addEventListener("pointerenter", () => yerd.prefetch(url));
   * }
   * ```
   */
  prefetch(url: string, as?: "page" | "json"): void;
  /**
   * fetch(), answered from the prefetch cache when a fresh JSON prefetch of the same URL exists.
   *
   * ```ts
   * client(el, url, yerd) {
   *   yerd.fetch(url).then(async (res) => {
   *     el.textContent = String(((await res.json()) as { visits: number }).visits);
   *   });
   * }
   * ```
   */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Register a client attribute at runtime. */
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
  /** Client half: runs in the browser for each element carrying the attribute. Must be self-contained (it's sent as source text). */
  client?: ClientSetup;
}

/** A defined custom attribute, as returned by attribute(). */
export interface AttributeDef<V = unknown> {
  /** The attribute (and JSX prop) name. */
  readonly name: string;
  /** The server half, if any. */
  readonly render: RenderAttribute<V> | undefined;
  /** The client half, if any. */
  readonly client: ClientSetup | undefined;
}

const VALID_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** User attributes; reset by the Vite plugin on reload. Built-ins live apart, so a reset keeps them. */
const registry = new Map<string, AttributeDef<any>>();
const builtins = new Map<string, AttributeDef<any>>();
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
  if (builtins.has(name)) throw new TypeError(`"${name}" is a built-in yerd attribute`);
  if (registry.has(name)) throw new TypeError(`Custom attribute "${name}" is defined twice`);
  const def: AttributeDef<V> = { name, render: options.render, client: options.client };
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
  builtins.set(name, { name, render, client: undefined });
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
 * `{ url, as: "json" }` warms an API response that `yerd.fetch(url)` then
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

/**
 * A function's source as an expression, including method shorthand
 * (`client(el) {...}`). Also used for <Local> handlers (see render/attrs.ts).
 */
export function sourceExpression(fn: Function, source = fn.toString()): string {
  // `function ...`, `async function ...`, arrows: already expressions.
  // `async\s*`: minifiers print `async(e)=>...`.
  if (/^(async\s*)?(function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(source)) return source;
  // Method shorthand: evaluate it as a method of a throwaway object.
  return `({ ${source} })[${JSON.stringify(fn.name)}]`;
}

function functionExpression(name: string, fn: Function): string {
  const source = fn.toString();
  if (/\b__(async|awaiter|generator|name)\b/.test(source)) {
    throw new Error(`The client half of attribute "${name}" uses a compiler helper (async lowered below ES2017, or keepNames); it must be self-contained`);
  }
  return sourceExpression(fn, source);
}

/** Script that registers every client half with the runtime; appended to /_yerd/runtime.js. */
export function attributesSource(): string {
  if (cached?.version === version) return cached.source;
  let lines = "";
  for (const def of registry.values()) {
    if (!def.client) continue;
    lines += `  yerd.attribute(${JSON.stringify(def.name)}, ${functionExpression(def.name, def.client)});\n`;
  }
  const source = lines ? `((yerd) => {\n${lines}})(window.yerd);\n` : "";
  cached = { version, source };
  return source;
}
