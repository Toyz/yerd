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

export const YERD_NODE: unique symbol = Symbol.for("yerd.node");

export type Component<P = any> = (props: P) => Child | Promise<Child>;

export interface YerdNode {
  readonly [YERD_NODE]: true;
  readonly type: string | Component | typeof Fragment;
  readonly props: Record<string, unknown> & { children?: Child };
  readonly key: string | number | undefined;
}

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

export function Fragment(props: { children?: Child }): Child {
  return props.children;
}

export function jsx(
  type: YerdNode["type"],
  props: Record<string, unknown> | null,
  key?: string | number,
): YerdNode {
  return { [YERD_NODE]: true, type, props: props ?? {}, key };
}

/** tsc emits `jsxs` for elements with static multiple children; same thing here. */
export const jsxs = jsx;

/**
 * The classic form, which tsc still emits (imported from the package root)
 * when a key follows a spread: `<div {...p} key="k" />`. Same node as jsx():
 * the key comes out of props, and children are one child or an array.
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

export function isYerdNode(value: unknown): value is YerdNode {
  return typeof value === "object" && value !== null && (value as YerdNode)[YERD_NODE] === true;
}

// Attribute typings for every element live in ./elements.ts.
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
