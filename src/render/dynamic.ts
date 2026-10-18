import type { Child } from "../jsx/jsx-runtime.js";

/** Props for <Dynamic>. */
export interface DynamicProps {
  /** Unique on the page: the Region id the runtime fills. */
  id: string;
  /** What a prerendered page shows until the runtime fills it in: a skeleton, a spinner, nothing. */
  fallback?: Child;
  /**
   * What a prerendered page shows instead when JavaScript is off (the fallback
   * would never be filled in): a link, a static version, a message. Rendered at
   * build time inside <noscript>, which also hides the fallback.
   *
   * ```tsx
   * <Dynamic id="cart" fallback={<span class="skeleton" />} noscript={<a href="/cart">View cart</a>}>
   *   {() => <CartSummary />}
   * </Dynamic>
   * ```
   */
  noscript?: Child;
  /** Renders the real content, per request. May read request data (session, user, query). */
  children: () => Child | Promise<Child>;
  /** Wrapper element. Default "div". */
  as?: string;
  /** Other attributes go on the wrapper element (class, style, data-*, ...). */
  [attribute: string]: unknown;
}

/** Region ids end up in a CSS selector for `noscript`, so they're kept simple. */
export const DYNAMIC_ID = /^[A-Za-z][\w-]*$/;

/**
 * A per-request part of a page. On ordinary requests it renders its children.
 * When the page is prerendered at build time, the fallback goes into the static
 * file instead (the children aren't called, which is why they may read request
 * data), and the client runtime fetches the real content once the page loads:
 * one request for all of a page's Dynamic parts.
 *
 * ```tsx
 * <Dynamic id="account" fallback={<span class="skeleton" />}>
 *   {() => <AccountMenu user={auth.current()} />}
 * </Dynamic>
 * ```
 *
 * The renderer handles this component itself (see render.ts); calling it as a
 * plain function just renders the children.
 */
export function Dynamic(props: DynamicProps): Child | Promise<Child> {
  return props.children();
}
