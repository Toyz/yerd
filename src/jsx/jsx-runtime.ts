/**
 * yerd JSX runtime.
 *
 * tsc compiles `<h1>{x}</h1>` into `jsx("h1", { children: x })` imported from
 * here (via `jsxImportSource: "@toyz/yerd"`). We don't build a virtual DOM for
 * diffing: `jsx()` returns a plain `{ type, props }` node that a renderer walks
 * once. This module is isomorphic: it touches neither the DOM nor Node.
 */

import type { RawHtml } from "../render/escape.js";
import type { IntrinsicElements as YerdIntrinsicElements } from "./elements.js";

/**
 * The brand on every JSX node; isYerdNode() checks for it. Apps don't need
 * it (use isYerdNode()); it's for tools that build or inspect nodes by hand.
 *
 * ```ts
 * import { YERD_NODE, type YerdNode } from "@toyz/yerd/jsx-runtime";
 *
 * const node: YerdNode = { [YERD_NODE]: true, type: "p", props: { children: "Hi" }, key: undefined };
 * ```
 */
export const YERD_NODE: unique symbol = Symbol.for("yerd.node");

/**
 * A function component: props in, something renderable out. May be async.
 * Use it to type a prop that takes a component:
 *
 * ```tsx
 * function Table<T>({ rows, Row }: { rows: T[]; Row: Component<{ row: T }> }) {
 *   return <table><tbody>{rows.map((row) => <Row row={row} />)}</tbody></table>;
 * }
 *
 * const UserRow: Component<{ row: { name: string } }> = ({ row }) => <tr><td>{row.name}</td></tr>;
 *
 * <Table rows={users} Row={UserRow} />
 * ```
 */
export type Component<P = any> = (props: P) => Child | Promise<Child>;

/**
 * A JSX element: what `<div />` or `<Page />` evaluates to. Rendering happens
 * later, in one pass. Type a prop with it when it must be an element rather
 * than any Child:
 *
 * ```tsx
 * function Field({ label, input }: { label: string; input: YerdNode }) {
 *   return <label>{label} {input}</label>;
 * }
 *
 * <Field label="Email" input={<input type="email" name="email" />} />
 * ```
 */
export interface YerdNode {
  /** Brand that marks a JSX node. */
  readonly [YERD_NODE]: true;
  /** A tag name, a component, or Fragment. */
  readonly type: string | Component | typeof Fragment;
  /** The element's props, children included. */
  readonly props: Record<string, unknown> & { children?: Child };
  /** The `key` prop. On an element it renders as `data-key`, which the runtime uses to match nodes when morphing; on a component it is dropped. */
  readonly key: string | number | undefined;
}

/**
 * Anything that can render. Strings and numbers are escaped; null, undefined
 * and booleans render nothing; iterables render each item; promises are
 * awaited. Use raw() to emit HTML as is. Type `children` with it:
 *
 * ```tsx
 * function Card({ title, children }: { title: string; children?: Child }) {
 *   return (
 *     <section class="card">
 *       <h2>{title}</h2>
 *       {children}
 *     </section>
 *   );
 * }
 *
 * <Card title="Inbox">Nothing new.</Card>
 * ```
 */
export type Child =
  | YerdNode
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | RawHtml
  | Iterable<Child>
  | PromiseLike<Child>;

/**
 * Groups children without a wrapper element: `<>...</>`, or `<Fragment>`
 * written out. A fragment renders no element, so a `key` on it is dropped:
 * key the elements inside instead, which is what the runtime matches on.
 *
 * ```tsx
 * function Term({ term, def }: { term: string; def: string }) {
 *   return (
 *     <>
 *       <dt key={term}>{term}</dt>
 *       <dd>{def}</dd>
 *     </>
 *   );
 * }
 *
 * <dl>{terms.map((t) => <Term term={t.term} def={t.def} />)}</dl>
 * ```
 */
export function Fragment(props: { children?: Child }): Child {
  return props.children;
}

/**
 * Create a JSX node. tsc calls this for you when compiling TSX; you rarely
 * call it directly. It's handy when the tag is only known as a string, which
 * JSX can't type-check:
 *
 * ```ts
 * import { jsx } from "@toyz/yerd/jsx-runtime";
 * import type { Child } from "@toyz/yerd";
 *
 * function Heading({ level, children }: { level: 1 | 2 | 3; children?: Child }) {
 *   return jsx(`h${level}`, { children });
 * }
 * ```
 */
export function jsx(
  type: YerdNode["type"],
  props: Record<string, unknown> | null,
  key?: string | number,
): YerdNode {
  return { [YERD_NODE]: true, type, props: props ?? {}, key };
}

/**
 * tsc emits `jsxs` for elements with static multiple children; same thing here.
 *
 * ```ts
 * jsxs("ul", { children: [jsx("li", { children: "One" }), jsx("li", { children: "Two" })] });
 * ```
 */
export const jsxs = jsx;

/**
 * The classic form, which tsc still emits (imported from the package root)
 * when a key follows a spread: `<div {...p} key="k" />`. Same node as jsx():
 * the key comes out of props, and children are one child or an array. Also
 * usable by hand, to build nodes without TSX:
 *
 * ```ts
 * createElement("ul", { class: "list" }, createElement("li", null, "One"), createElement("li", null, "Two"));
 * ```
 */
export function createElement(
  type: YerdNode["type"],
  props: Record<string, unknown> | null,
  ...children: Child[]
): YerdNode {
  const own: Record<string, unknown> = {};
  let key: string | number | undefined;
  if (props) {
    for (const name in props) {
      if (name === "key") key = props[name] as string | number | undefined;
      else own[name] = props[name];
    }
  }
  if (children.length === 1) own.children = children[0];
  else if (children.length > 1) own.children = children;
  return { [YERD_NODE]: true, type, props: own, key };
}

/**
 * Whether `value` is a JSX node (as opposed to text, an array, raw() HTML or
 * a promise).
 *
 * ```tsx
 * import { isYerdNode } from "@toyz/yerd/jsx-runtime";
 *
 * function Title({ children }: { children?: Child }) {
 *   return isYerdNode(children) ? children : <h1>{children}</h1>;
 * }
 * ```
 */
export function isYerdNode(value: unknown): value is YerdNode {
  return typeof value === "object" && value !== null && (value as YerdNode)[YERD_NODE] === true;
}

// Attribute typings for every element live in ./elements.ts.
/**
 * The JSX type namespace TypeScript reads for TSX type checking. Augment its
 * `IntrinsicElements` to type a tag yerd doesn't know, such as MathML (tags
 * with a dash are custom elements and already take any attributes):
 *
 * ```tsx
 * import type { GlobalAttributes } from "@toyz/yerd";
 *
 * declare module "@toyz/yerd/jsx-runtime" {
 *   namespace JSX {
 *     interface IntrinsicElements {
 *       math: GlobalAttributes & { display?: "block" | "inline" };
 *       mi: GlobalAttributes;
 *     }
 *   }
 * }
 *
 * <math display="block"><mi>x</mi></math>
 * ```
 */
export declare namespace JSX {
  type Element = YerdNode;
  /** Lets async function components be used as JSX tags. */
  type ElementType = keyof IntrinsicElements | Component<any>;
  interface ElementChildrenAttribute {
    children: {};
  }
  /** Props every JSX tag accepts, components included. */
  interface IntrinsicAttributes {
    key?: string | number;
  }
  /** Augment this to type extra tags: `declare module "@toyz/yerd/jsx-runtime"`. */
  interface IntrinsicElements extends YerdIntrinsicElements {}
}
