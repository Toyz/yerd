/**
 * @toyz/yerd/client: types for the app's own client modules (islands, lazy
 * elements, module-backed attribute halves). Types only: nothing here runs
 * in the browser, so importing it with `import type` adds nothing to a
 * bundle.
 */

import type { ClientSetup, YerdClient } from "../attributes/attribute.js";

export type { AttributeHandle, ClientSetup, YerdClient, PageApi, NetApi, ClockApi, ClockReading } from "../attributes/attribute.js";
export type { LoadTrigger } from "../render/lazy.js";

/**
 * What an island's mount function may return: nothing, or a cleanup that
 * runs when the island leaves the page.
 *
 * ```ts
 * const mount: IslandMount = (el) => {
 *   const timer = setInterval(() => (el.textContent = new Date().toLocaleTimeString()), 1000);
 *   return () => clearInterval(timer);
 * };
 * ```
 */
export type IslandCleanup = void | (() => void);

/**
 * An island module's default export: called with the <yerd-island> element,
 * the props the server passed (`P`), and the runtime API. May be async.
 *
 * ```ts
 * // src/widgets/counter.client.ts
 * import type { IslandMount } from "@toyz/yerd/client";
 *
 * const mount: IslandMount<{ start: number }> = (el, { start }) => {
 *   let n = start;
 *   const button = document.createElement("button");
 *   button.textContent = String(n);
 *   button.onclick = () => (button.textContent = String(++n));
 *   el.replaceChildren(button);
 * };
 * export default mount;
 * ```
 */
export type IslandMount<P = undefined> = (el: HTMLElement, props: P, yerd: YerdClient) => IslandCleanup | Promise<IslandCleanup>;

/**
 * A module-backed attribute half's default export: the same function an
 * inline `client` would be. An alias of ClientSetup, named for the module.
 *
 * ```ts
 * // src/attrs/autosize.client.ts, for attribute("autosize", { client: "src/attrs/autosize.client.ts" })
 * import type { AttributeSetup } from "@toyz/yerd/client";
 *
 * const autosize: AttributeSetup = (el) => {
 *   const fit = () => void (el.style.height = `${el.scrollHeight}px`);
 *   el.addEventListener("input", fit);
 *   return () => el.removeEventListener("input", fit);
 * };
 * export default autosize;
 * ```
 */
export type AttributeSetup = ClientSetup;

/**
 * `yx:lazy-start`'s detail: the module URL being loaded for the element it
 * bubbles from.
 *
 * ```ts
 * document.addEventListener("yx:lazy-start", (e) => console.log("loading", e.detail.src));
 * ```
 */
export interface LazyStartDetail {
  src: string;
}

/**
 * `yx:lazy-end`'s detail: the module URL, whether it loaded (and mounted),
 * and the error when it didn't.
 *
 * ```ts
 * document.addEventListener("yx:lazy-end", (e) => {
 *   if (!e.detail.ok) report(e.detail.error);
 * });
 * ```
 */
export interface LazyEndDetail {
  src: string;
  ok: boolean;
  error?: unknown;
}

declare global {
  interface HTMLElementEventMap {
    "yx:lazy-start": CustomEvent<LazyStartDetail>;
    "yx:lazy-end": CustomEvent<LazyEndDetail>;
  }
  interface DocumentEventMap {
    "yx:lazy-start": CustomEvent<LazyStartDetail>;
    "yx:lazy-end": CustomEvent<LazyEndDetail>;
  }
}
