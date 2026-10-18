import { jsx, type Child } from "../jsx/jsx-runtime.js";
import { raw } from "../render/escape.js";

/** Where yerd serves its client runtime. */
export const RUNTIME_PATH = "/_yerd/runtime.js";

/** Props for <Region>. */
export interface RegionProps {
  /** Unique on the page; how responses find the part of the page to replace. */
  id: string;
  /** Element to render. Default "div". */
  as?: string;
  /**
   * In a response: add this Region's children to the end of the one on the
   * page instead of replacing them (children with an id or key already there
   * are updated in place). For infinite scroll and feeds.
   */
  append?: boolean;
  /** Like `append`, at the start: new messages on top. */
  prepend?: boolean;
  /** The region's content. */
  children?: Child;
  /** Other attributes go on the element as given. */
  [attribute: string]: unknown;
}

/**
 * A swappable part of the page. When an action (or a boosted link, or a live
 * refresh) returns HTML, every Region in it is morphed into the element with
 * the same id, keeping focus, scroll and input state.
 */
export function Region({ id, as = "div", append, prepend, ...rest }: RegionProps) {
  return jsx(as, { ...rest, id, "data-yx-region": true, "data-yx-append": append || undefined, "data-yx-prepend": prepend || undefined });
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
