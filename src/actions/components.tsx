import { jsx, type Child } from "../jsx/jsx-runtime.js";
import type { FormAttributes } from "../jsx/elements.js";
import { raw } from "../render/escape.js";
import { bind, type Action } from "./action.js";

/** Where yerd serves its client runtime. */
export const RUNTIME_PATH = "/_yerd/runtime.js";

/** Props for <Region>. */
export interface RegionProps {
  /** Unique on the page; how responses find the part of the page to replace. */
  id: string;
  /** Element to render. Default "div". */
  as?: string;
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

/**
 * Props for <Form>: the action, the arguments it's called with (required
 * unless the action takes none, and typed from it), and any other `<form>`
 * attribute.
 */
export type FormProps<A> = Omit<FormAttributes, "action" | "method"> & {
  /** The @action method to call. */
  action: Action<A>;
  /** The form's content. */
  children?: Child;
} & ({} extends A ? { /** Arguments for the action, signed into the form. */ args?: NoInfer<A> } : { /** Arguments for the action, signed into the form. */ args: NoInfer<A> });

/**
 * A form that calls an action with arguments. The arguments are signed into
 * the form's token, so the browser can't change which item it acts on, and
 * typed from the action: a wrong or missing field doesn't compile. Renders a
 * plain `<form>` (a POST that works with JavaScript off, upgraded to fetch by
 * the runtime); the same as `<form action={bind(action, args)}>`.
 *
 * ```tsx
 * @action remove({ id }: { id: string }) { ... }
 *
 * <Form action={this.remove} args={{ id: todo.id }}>
 *   <button>Delete</button>
 * </Form>
 * ```
 */
export function Form<A>({ action, args, ...rest }: FormProps<A>) {
  return jsx("form", { ...rest, action: bind(action, (args ?? {}) as A) });
}
