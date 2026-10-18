import { jsx, type Child } from "../jsx/jsx-runtime.js";
import { raw } from "../render/escape.js";

/** Where yerd serves its client runtime. */
export const RUNTIME_PATH = "/_yerd/runtime.js";

export interface RegionProps {
  /** Unique on the page; how responses find the part of the page to replace. */
  id: string;
  /** Element to render. Default "div". */
  as?: string;
  children?: Child;
  [attribute: string]: unknown;
}

/**
 * A swappable part of the page. When an action (or a boosted link, or a live
 * refresh) returns HTML, every Region in it is morphed into the element with
 * the same id, keeping focus, scroll and input state.
 */
export function Region({ id, as = "div", ...rest }: RegionProps) {
  return jsx(as, { ...rest, id, "data-yx-region": true });
}

/**
 * The client runtime script. Put it once in your root layout's <head>.
 * `auto` turns on auto mode: every same-origin link and form is handled by
 * the runtime with no data-yx-* attributes, and links are prefetched from
 * where the pointer is heading (see src/client/runtime.ts).
 */
export function Scripts({ auto = false }: { auto?: boolean } = {}) {
  return raw(`<script type="module" src="${RUNTIME_PATH}"${auto ? " data-yx-auto" : ""}></script>`);
}
