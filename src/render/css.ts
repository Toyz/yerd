/**
 * Scoped CSS in TSX: `css` turns rules into a class name, and only the pages
 * that use the class get its rules.
 *
 * ```tsx
 * const card = css`
 *   padding: 16px;
 *   border-radius: 12px;
 *   &:hover { box-shadow: 0 4px 12px #0002; }
 * `;
 *
 * function Card({ children }: { children: Child }) {
 *   return <div class={card}>{children}</div>;
 * }
 * ```
 *
 * - The class is a hash of the rules (`yx-1k3j9a`), the same on every server,
 *   so the rules go wherever the class goes: `.yx-1k3j9a { ...your rules }`.
 *   `&` is the element itself (native CSS nesting).
 * - In development, a page gets each class's rules once, in a `<style>` just
 *   before the first element using it; the client runtime moves them into
 *   `<head>` and drops duplicates (an action's response repeats the ones it
 *   uses). After `vite build`, every rule is in one hashed stylesheet that
 *   `<Styles />` links, and nothing is inlined.
 * - Interpolating another class gives its selector (`${card}:hover &`), a
 *   `keyframes` name its scoped name; anything else is written as text.
 * - `css.global` adds rules that aren't scoped (resets, body, fonts):
 *   `<Styles />` in the head writes them.
 *
 * Classes are found in `class` / `className` props (strings, arrays, and the
 * keys of flag objects, `{ [active]: on }`). A class name buried in raw()
 * HTML isn't seen.
 */

import { raw, type RawHtml } from "./escape.js";

/** A rule set registered by css`` or keyframes``. */
interface Rule {
  /** The full CSS text: `.yx-abc{...}` or `@keyframes yx-k-abc{...}`. */
  text: string;
  /** Keyframes (or other rules) it refers to, sent along with it. */
  needs: string[];
}

const rules = new Map<string, Rule>();
const globals: string[] = [];
const globalSet = new Set<string>();

/** After `vite build`: where the bundle is, and which classes it holds. */
let bundle: { href: string; classes: Set<string> } | undefined;

/**
 * Two 32-bit FNV-1a variants, base36: short, stable across processes and
 * machines (a class rendered on one server styles a page from another),
 * collisions out of reach for a stylesheet's worth of rules.
 */
function hash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return ((a >>> 0).toString(36) + (b >>> 0).toString(36)).slice(0, 10);
}

/** `</style` in a rule would close the <style> it's written in. */
function checkText(text: string): void {
  if (/<\/style/i.test(text)) throw new TypeError("CSS can't contain </style");
}

interface Built {
  body: string;
  needs: string[];
}

/** The template's text, with classes and keyframes interpolated as selectors and names. */
function build(strings: TemplateStringsArray, values: readonly unknown[]): Built {
  let body = strings[0]!;
  const needs: string[] = [];
  values.forEach((value, i) => {
    let text: string;
    if (typeof value === "string" && rules.has(value)) {
      const rule = rules.get(value)!;
      if (rule.text.startsWith("@keyframes")) {
        text = value;
        needs.push(value);
      } else {
        // Another css`` class: its selector, so `${card}:hover &` targets it.
        text = `.${value}`;
      }
    } else if (value === null || value === undefined || value === false) text = "";
    else text = String(value);
    body += text + strings[i + 1]!;
  });
  return { body: body.trim(), needs };
}

function register(name: string, text: string, needs: string[]): string {
  checkText(text);
  const existing = rules.get(name);
  if (existing && existing.text !== text) throw new Error(`css: two different rule sets hash to ${name}; change one slightly`);
  rules.set(name, { text, needs });
  return name;
}

/**
 * Scoped rules; returns their class name. Use it in `class`, alone or with
 * others: `class={[card, { [active]: selected }]}`.
 */
export function css(strings: TemplateStringsArray, ...values: unknown[]): string {
  const { body, needs } = build(strings, values);
  const name = `yx-${hash(body)}`;
  return register(name, `.${name}{${body}}`, needs);
}

/**
 * Rules that aren't scoped: resets, `body`, `@font-face`, CSS variables on
 * `:root`. `<Styles />` writes them (in development) or links the bundle
 * that has them (after `vite build`).
 *
 * ```ts
 * css.global`
 *   :root { --accent: #d6452b; }
 *   body { margin: 0; font-family: system-ui, sans-serif; }
 * `;
 * ```
 */
css.global = function global(strings: TemplateStringsArray, ...values: unknown[]): void {
  const { body } = build(strings, values);
  checkText(body);
  if (globalSet.has(body)) return;
  globalSet.add(body);
  globals.push(body);
};

/**
 * A scoped `@keyframes`; returns its name, for `animation` in a css`` rule
 * (which then carries the keyframes wherever it goes).
 *
 * ```ts
 * const pop = keyframes`from { transform: scale(0.9); opacity: 0; }`;
 * const badge = css`animation: ${pop} 0.2s ease-out;`;
 * ```
 */
export function keyframes(strings: TemplateStringsArray, ...values: unknown[]): string {
  const { body } = build(strings, values);
  const name = `yx-k-${hash(body)}`;
  return register(name, `@keyframes ${name}{${body}}`, []);
}

/** Every class name in a class / className value: strings, arrays, and flag objects' keys (on or off). */
export function classesIn(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    for (const token of value.split(/\s+/)) if (token && rules.has(token)) out.add(token);
  } else if (Array.isArray(value)) {
    for (const item of value) classesIn(item, out);
  } else if (value && typeof value === "object") {
    // Flag objects: { [active]: s.on } may switch on in the browser later, so its rules go too.
    for (const key of Object.keys(value)) classesIn(key, out);
  }
  return out;
}

/** The `<style>` for classes not sent yet on this page (and what they need), or "". Updates `sent`. */
export function stylesFor(classes: Set<string>, sent: Set<string>): string {
  let html = "";
  const visit = (name: string) => {
    if (sent.has(name)) return;
    sent.add(name);
    const rule = rules.get(name);
    if (!rule) return;
    for (const need of rule.needs) visit(need);
    // Already in the build's stylesheet: nothing to inline.
    if (bundle?.classes.has(name)) return;
    html += `<style data-yx-css="${name}">${rule.text}</style>`;
  };
  for (const name of classes) visit(name);
  return html;
}

/**
 * Global rules (`css.global`), or the build's stylesheet once there is one.
 * Put it in the root layout's `<head>`.
 *
 * ```tsx
 * <head>
 *   <Styles />
 * </head>
 * ```
 */
export function Styles(): RawHtml {
  if (bundle) return raw(`<link rel="stylesheet" href="${bundle.href.replace(/"/g, "&quot;")}">`);
  return raw(globals.length ? `<style data-yx-css="global">${globals.join("\n")}</style>` : "");
}

/** Every rule known now, globals first: the build's stylesheet. */
export function cssBundleText(): string {
  return [...globals, ...[...rules.values()].map((r) => r.text)].join("\n");
}

/** The class names in the bundle (so the server stops inlining them). */
export function cssBundleClasses(): string[] {
  return [...rules.keys()];
}

/** @internal Serve the build's stylesheet: `<Styles />` links it, and its classes aren't inlined. */
export function useCssBundle(href: string, classes: readonly string[]): void {
  bundle = { href, classes: new Set(classes) };
}

/** @internal Forget the bundle (dev servers, tests). */
export function resetCssBundle(): void {
  bundle = undefined;
}

/** A content hash for the bundle's file name. */
export function cssBundleHash(text: string): string {
  return hash(text);
}
