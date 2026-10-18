/**
 * Client code that loads when it's needed: islands, lazy custom elements and
 * (in attributes/attribute.ts) module-backed attribute client halves. Each
 * points at a client module by its source path ("src/widgets/chart.client.ts"),
 * resolved like assetUrl(): the file itself in dev, the hashed build output
 * (through the Vite manifest) in production. The runtime's lazy chunk
 * (client/runtime-lazy.ts) imports each module the first time its trigger
 * fires, once per page.
 */

import { jsx, type Child, type YerdNode } from "../jsx/jsx-runtime.js";
import { clientModule } from "../assets.js";
import { Logger } from "../log/logger.js";
import type { LazyModule, LazyRegistry } from "../client/hooks.js";

/**
 * When a lazy module loads: "load" (default), "idle", "visible" (within
 * 200px of the viewport), "interaction" (first hover, press, focus or touch)
 * or "media:<query>". The triggering event isn't replayed.
 *
 * ```tsx
 * <Island src="src/widgets/map.client.ts" when="visible" props={{ lat, lng }} />
 * <Island src="src/widgets/menu.client.ts" when="media:(min-width: 800px)" />
 * ```
 */
export type LoadTrigger = "load" | "idle" | "visible" | "interaction" | `media:${string}`;

const TRIGGERS = new Set(["load", "idle", "visible", "interaction"]);

/** @internal `when`, checked: one of the LoadTrigger words, or "media:" and a query. `where` names it in the error. */
export function checkTrigger(when: unknown, where: string): LoadTrigger {
  if (typeof when === "string" && (TRIGGERS.has(when) || (when.startsWith("media:") && when.length > 6))) return when as LoadTrigger;
  throw new TypeError(`${where}: when=${JSON.stringify(when)} isn't a trigger; use "load", "idle", "visible", "interaction" or "media:<query>"`);
}

// ── lazy elements ──

/** Options for lazyElement(). */
export interface LazyElementOptions {
  /**
   * When to import the module. Default "load".
   *
   * ```ts
   * lazyElement("share-menu", "src/components/share-menu.client.ts", { when: "interaction" });
   * ```
   */
  when?: LoadTrigger;
}

/** A registered lazy element, as returned by lazyElement(). */
export interface LazyElementDef {
  /** The custom element's tag. */
  readonly tag: string;
  /** The client module that defines it, as a source path. */
  readonly src: string;
  /** When the module is imported. */
  readonly when: LoadTrigger;
}

// Custom element names: a lowercase letter, then at least one dash among lowercase letters, digits, ".", "_" and "-".
const VALID_TAG = /^[a-z][a-z0-9._]*-[a-z0-9._-]*$/;

/** Lazy elements by tag; reset by the Vite plugin on reload, like the attribute registry. */
const elements = new Map<string, LazyElementDef>();

/**
 * A custom element whose module loads only when a page uses the tag, after
 * loom's @lazy. Call it at module level on the server; the module defines
 * the element itself, and the tag's server-rendered children show until then.
 *
 * ```tsx
 * // src/elements.ts (imported by the server)
 * export const clock = lazyElement("gnome-clock", "src/components/gnome-clock.client.ts", { when: "idle" });
 *
 * // src/components/gnome-clock.client.ts (built for the browser)
 * customElements.define("gnome-clock", class extends HTMLElement {
 *   connectedCallback() { this.textContent = new Date().toLocaleTimeString(); }
 * });
 *
 * // in a page: the server's text shows until the element upgrades
 * <gnome-clock>12:00</gnome-clock>
 * ```
 */
export function lazyElement(tag: string, src: string, options: LazyElementOptions = {}): LazyElementDef {
  if (!VALID_TAG.test(tag)) throw new TypeError(`lazyElement: ${JSON.stringify(tag)} isn't a custom element name (lowercase, with a dash: "my-widget")`);
  if (elements.has(tag)) throw new TypeError(`Lazy element <${tag}> is defined twice`);
  if (typeof src !== "string" || !src) throw new TypeError(`lazyElement("${tag}") needs the client module's source path`);
  const def: LazyElementDef = { tag, src, when: checkTrigger(options.when ?? "load", `lazyElement("${tag}")`) };
  elements.set(tag, def);
  return def;
}

/** @internal The lazy element for a tag, if it's one. */
export function lazyElementFor(tag: string): LazyElementDef | undefined {
  return elements.size ? elements.get(tag) : undefined;
}

/**
 * Forget every lazy element, as dev servers do before re-importing the app.
 * Tests that define lazy elements call it between runs.
 *
 * ```ts
 * import { afterEach } from "vitest";
 * import { resetLazyElements } from "@toyz/yerd";
 *
 * afterEach(() => resetLazyElements());
 * ```
 */
export function resetLazyElements(): void {
  elements.clear();
}

// ── the registry the runtime gets ──

const log = new Logger("yerd::assets");
const unresolved = new Set<string>();

/** A module for the registry, or undefined (logged once) when it can't be resolved: that element or attribute just stays inert. */
function registryModule(src: string, when: string, what: string): LazyModule | undefined {
  try {
    const { url, css } = clientModule(src);
    return css.length ? { url, when, css } : { url, when };
  } catch (error) {
    if (!unresolved.has(src)) {
      unresolved.add(src);
      log.error(`${what}: ${(error as Error).message}`);
    }
    return undefined;
  }
}

/**
 * @internal The lazy elements and module-backed attributes (`attributes`:
 * name, module, trigger), resolved to URLs for the browser. Sent with the
 * runtime script, so it's resolved per serve: source paths in dev, the
 * build's files in production.
 */
export function lazyRegistry(attributes: Iterable<{ name: string; src: string; when: string }>): LazyRegistry {
  const registry: LazyRegistry = { elements: {}, attributes: {} };
  for (const def of elements.values()) {
    const module = registryModule(def.src, def.when, `lazyElement("${def.tag}")`);
    if (module) registry.elements[def.tag] = module;
  }
  for (const { name, src, when } of attributes) {
    const module = registryModule(src, when, `attribute("${name}")`);
    if (module) registry.attributes[name] = module;
  }
  return registry;
}

// ── islands ──

/** Props for <Island>. `P` is what the module's mount function receives. */
export interface IslandProps<P = unknown> {
  /** The client module, as a source path relative to the Vite root. */
  src: string;
  /** When to import and mount it. Default "load". */
  when?: LoadTrigger;
  /** Handed to the mount function. Must be JSON: anything else throws while rendering. */
  props?: P;
  /** Shown until the module mounts. */
  children?: Child;
  /** Other attributes go on the <yerd-island> element (class, style, id, ...). */
  [attribute: string]: unknown;
}

/** What islandNode() makes: the element to render, and its module URL when the page should preload it. */
export interface IslandRender {
  node: YerdNode;
  preload: string[] | undefined;
}

/** A props path for error messages: props.points[3], props["odd key"]. */
function propPath(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/**
 * Throw unless `value` survives JSON.stringify and JSON.parse unchanged: a
 * Date would arrive as a string and a Map as {}, which the types wouldn't
 * show. An undefined property is fine (it's left out, as it would be).
 */
function checkJson(value: unknown, path: string, where: string, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  let what: string;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    what = String(value);
  } else if (typeof value === "object") {
    if (seen.has(value)) what = "a circular reference";
    else if (Array.isArray(value)) {
      seen.add(value);
      value.forEach((item, i) => checkJson(item, propPath(path, i), where, seen));
      seen.delete(value);
      return;
    } else {
      const proto = Object.getPrototypeOf(value) as object | null;
      if (proto === Object.prototype || proto === null) {
        seen.add(value);
        for (const [key, item] of Object.entries(value)) if (item !== undefined) checkJson(item, propPath(path, key), where, seen);
        seen.delete(value);
        return;
      }
      what = `a ${(value as { constructor?: { name?: string } }).constructor?.name || "class instance"}`;
    }
  } else what = typeof value === "undefined" ? "undefined" : `a ${typeof value}`;
  throw new TypeError(`${where}: ${path} is ${what}; island props are sent to the browser as JSON, so they must be plain objects, arrays, strings, finite numbers, booleans or null`);
}

/** FNV-1a, as 7 base-36 digits: a short, stable name for an island's module and props. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

/**
 * @internal The <yerd-island> element for an Island's props: the module URL,
 * trigger, props and stylesheets as data attributes, and `data-yx-keep`, so
 * a morph leaves what the module drew alone. Its key (unless the Island has
 * one) comes from the module and props: a morph keeps a mounted island while
 * those are the same, and swaps in a fresh one (cleanup, then mount) when
 * they change.
 */
export function islandNode(input: IslandProps, key?: string | number): IslandRender {
  const { src, when = "load", props, children, ...rest } = input;
  if (typeof src !== "string" || !src) throw new TypeError("<Island> needs src: the client module's source path");
  const where = `<Island src="${src}">`;
  const trigger = checkTrigger(when, where);
  let json: string | undefined;
  if (props !== undefined) {
    checkJson(props, "props", where, new Set());
    json = JSON.stringify(props);
  }
  const module = clientModule(src);
  const node = jsx(
    "yerd-island",
    {
      ...rest,
      "data-yx-island": module.url,
      "data-yx-when": trigger === "load" ? undefined : trigger,
      "data-yx-props": json,
      "data-yx-styles": module.css.length ? module.css.join(" ") : undefined,
      "data-yx-keep": true,
      children,
    },
    key ?? `yx-island-${shortHash(`${src}\n${json ?? ""}`)}`,
  );
  return { node, preload: trigger === "load" ? [module.url, ...module.imports] : undefined };
}

/**
 * A part of the page that runs its own client module, loaded when `when`
 * fires. The module's default export mounts into the `<yerd-island>`
 * element with `props`; the children show until then.
 *
 * ```tsx
 * // in a page
 * <Island src="src/widgets/sparkline.client.ts" when="visible" props={{ points: [3, 5, 2, 8] }}>
 *   <p>Sales: 3, 5, 2, 8</p>
 * </Island>
 *
 * // src/widgets/sparkline.client.ts
 * import type { IslandMount } from "@toyz/yerd/client";
 *
 * const mount: IslandMount<{ points: number[] }> = (el, { points }) => {
 *   const canvas = document.createElement("canvas");
 *   // ...draw the points...
 *   el.replaceChildren(canvas);
 *   return () => canvas.remove();
 * };
 * export default mount;
 * ```
 */
export function Island<P = unknown>(props: IslandProps<P>): YerdNode {
  return islandNode(props).node;
}

/** Props for a component made by island(): IslandProps with `props` typed (and required, unless P allows undefined). */
export type IslandComponentProps<P> = Omit<IslandProps<P>, "src" | "props"> & (undefined extends P ? { props?: P } : { props: P });

/**
 * An island as a component with type-checked props. Share the props type
 * with the module through a type-only import.
 *
 * ```tsx
 * // src/widgets/sparkline.client.ts
 * import type { IslandMount } from "@toyz/yerd/client";
 * export interface SparklineProps { points: number[]; color?: string }
 * const mount: IslandMount<SparklineProps> = (el, { points }) => { ... };
 * export default mount;
 *
 * // src/components.tsx (server)
 * import type { SparklineProps } from "./widgets/sparkline.client.js";
 * export const Sparkline = island<SparklineProps>("src/widgets/sparkline.client.ts", { when: "visible" });
 *
 * <Sparkline props={{ points: [3, 5, 2, 8] }}>3, 5, 2, 8</Sparkline>
 * ```
 */
export function island<P = undefined>(src: string, defaults: { when?: LoadTrigger } = {}): (props: IslandComponentProps<P>) => YerdNode {
  const when = checkTrigger(defaults.when ?? "load", `island("${src}")`);
  return (props) => jsx(Island, { when, ...props, src });
}
