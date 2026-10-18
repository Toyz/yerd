/**
 * HTML renderer.
 *
 * Walks a yerd node tree once and produces HTML, synchronously wherever it
 * can: every render function returns `undefined` when it finished, or a
 * promise when it had to wait (an async component, a promise child) and the
 * caller must continue after it. A fully synchronous page never allocates a
 * promise or a generator per node.
 *
 * Output accumulates in a buffer that is flushed as a chunk right before the
 * renderer waits, so the top of the page goes out before a slow component
 * finishes, without emitting a chunk per tag.
 *
 * While it waits on one child, the async components among the children after
 * it are called right away (see startSiblings), so siblings wait together
 * instead of one after another. Output still goes out in order.
 */

import { Fragment, isYerdNode, jsx, type Child, type YerdNode } from "../jsx/jsx-runtime.js";
import { elementAttributes, renderAttributes } from "./attrs.js";
import { escapeHtml, isRawHtml, raw, type RawHtml } from "./escape.js";
import { formAction, isBoundAction } from "../actions/action.js";
import { DYNAMIC_ID, Dynamic, type DynamicProps } from "./dynamic.js";
import { Styles, stylesFor } from "./css.js";
import { Local, bindingSpec, isBinding, localState, stateName, type Binding, type LocalProps } from "./local.js";
import { Scripts, chunkHints } from "../actions/components.js";

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

// Where the parser drops a <style> (<select>), closes the element at one
// (<colgroup>), or reads it as markup or not at all (<svg>, <math>): rules for
// classes inside wait until the element has closed.
const HOLDS_CSS_ELEMENTS = new Set(["select", "colgroup", "svg", "math"]);
// Contents that aren't part of the page (<template>), or aren't once scripts
// run (<noscript>): rules sent inside don't count as sent for the rest of it.
const OWN_CSS_ELEMENTS = new Set(["template", "noscript"]);

/** What the renderer does differently for a tag; see tagFlags(). */
const VOID = 1;
const HOLDS_CSS = 2;
const OWN_CSS = 4;
const RAW_TEXT = 8;

const VALID_TAG = /^[a-zA-Z][a-zA-Z0-9-]*$/;

// The client runtime's chunks, as bits of State.needs: what the page's
// elements need, preloaded after <Scripts /> (see placeHints).
const CHUNK_NAMES = ["cues", "dnd", "local"] as const;
const CUES = 1;
const DND = 2;
const LOCAL = 4;

// Tags repeat constantly: each is checked and classified the first time it's
// seen, then it's one Map lookup per element (capped).
const tags = new Map<string, number>();

function tagFlags(tag: string): number {
  let flags = tags.get(tag);
  if (flags !== undefined) return flags;
  if (!VALID_TAG.test(tag)) throw new TypeError(`Invalid element name: ${JSON.stringify(tag)}`);
  flags = (VOID_ELEMENTS.has(tag) ? VOID : 0)
    | (HOLDS_CSS_ELEMENTS.has(tag) ? HOLDS_CSS : 0)
    | (OWN_CSS_ELEMENTS.has(tag) ? OWN_CSS : 0)
    | (tag === "script" || tag === "style" ? RAW_TEXT : 0);
  if (tags.size < 1024) tags.set(tag, flags);
  return flags;
}

/**
 * Options for renderToString() and renderToStream(). Responses yerd renders
 * for you set these themselves; pass them when you render on your own.
 *
 * ```tsx
 * const html = await renderToString(<Page />, { document: true });
 * ```
 */
export interface RenderOptions {
  /**
   * Prepend `<!doctype html>` when the first element rendered is `<html>`.
   *
   * ```tsx
   * await renderToString(<html><body>Hi</body></html>, { document: true });
   * // "<!doctype html><html><body>Hi</body></html>"
   * ```
   */
  document?: boolean;
  /**
   * How <Dynamic> parts render: "fallback" (build-time prerendering: the
   * fallback, marked for the runtime to fill) or "only" (the runtime's fill-in
   * request: nothing but the Dynamic parts). Default: everything, normally.
   */
  dynamic?: "fallback" | "only";
}

interface State {
  buffer: string;
  document: boolean;
  started: boolean;
  dynamic: RenderOptions["dynamic"];
  /** How many <Dynamic> boundaries we're inside; in "only" mode, output outside them is dropped. */
  insideDynamic: number;
  /** How many <Local> scopes we're inside; event handlers are shipped to the browser only there. */
  insideLocal: number;
  /** css`` classes whose rules this render already sent. */
  cssSent: Set<string>;
  /** css`` classes (and keyframes) the element being opened uses; emptied after each. */
  cssFound: Set<string>;
  /**
   * Where <Styles /> sits in the buffer, while the buffer still holds it: rules
   * go there, in <head>, instead of next to the elements (where an inline
   * <style> would count as a sibling for :first-child and `h1 + p`). Gone once
   * the head has been flushed.
   */
  cssAnchor: number | undefined;
  /** Rules on their way to cssAnchor: spliced in once, when the buffer is flushed or the render ends. */
  cssHead: string;
  /** The runtime chunks the elements rendered so far need (CUES | DND | LOCAL). */
  needs: number;
  /**
   * Just after <Scripts /> in the buffer, while the buffer still holds it:
   * where the chunks' modulepreload hints go when the buffer is flushed or
   * the render ends.
   */
  scriptsAnchor: number | undefined;
  /** Inside a <select>, where the parser drops <style>: rules wait here for it to close. */
  cssHeld: Set<string> | undefined;
  /** cssSent outside each open <template> / <noscript>, innermost last (see OWN_CSS_ELEMENTS). */
  cssOuter: Set<string>[] | undefined;
  /** Async components called before the walk got to them (see startSiblings), until it does. */
  early: Map<YerdNode, Early> | undefined;
  /** Flushed chunks waiting for the stream's consumer. */
  chunks: string[];
  /** Wakes the stream's consumer when a chunk is flushed. */
  notify: (() => void) | undefined;
}

/** `undefined`: finished synchronously. A promise: continue after it. */
type Step = Promise<void> | undefined;

/** An async component already called: how its promise came out, once it has. */
interface Early {
  /** Resolves (never rejects) once the component's promise has settled. */
  settled: Promise<void>;
  done: boolean;
  failed: boolean;
  /** What it resolved to, or the error. */
  value: unknown;
}

/** Whether output is kept: in "only" mode, just inside a <Dynamic>. */
function emitting(state: State): boolean {
  return state.dynamic !== "only" || state.insideDynamic > 0;
}

function write(state: State, html: string): void {
  if (emitting(state)) state.buffer += html;
}

/**
 * Run `fn` with a scope counter raised (inside a <Local>, a <Dynamic>),
 * lowering it again when its step settles or it throws.
 */
function scoped(state: State, counter: "insideLocal" | "insideDynamic", fn: () => Step): Step {
  state[counter]++;
  let step: Step;
  try {
    step = fn();
  } finally {
    // Finished synchronously, or threw: the scope is over now.
    if (!step) state[counter]--;
  }
  return step?.finally(() => {
    state[counter]--;
  });
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as PromiseLike<unknown>).then === "function";
}

function isIterable(value: unknown): value is Iterable<Child> {
  return typeof value === "object" && value !== null && typeof (value as Iterable<unknown>)[Symbol.iterator] === "function";
}

/** Put the rules collected for <head> in at <Styles />, in one splice. */
function placeHeadRules(state: State): void {
  if (!state.cssHead) return;
  const at = state.cssAnchor!;
  state.buffer = state.buffer.slice(0, at) + state.cssHead + state.buffer.slice(at);
  if (state.scriptsAnchor !== undefined && state.scriptsAnchor > at) state.scriptsAnchor += state.cssHead.length;
  state.cssHead = "";
}

/**
 * Put modulepreload hints for the runtime chunks the page needs after
 * <Scripts />, in one splice. Once the head has gone out it's too late: the
 * runtime loads what it finds a use for itself.
 */
function placeHints(state: State): void {
  const at = state.scriptsAnchor;
  if (at === undefined) return;
  state.scriptsAnchor = undefined;
  if (!state.needs) return;
  const hints = chunkHints(CHUNK_NAMES.filter((_, i) => state.needs & (1 << i)));
  state.buffer = state.buffer.slice(0, at) + hints + state.buffer.slice(at);
  if (state.cssAnchor !== undefined && state.cssAnchor >= at) state.cssAnchor += hints.length;
}

/** Hand the buffer to the consumer as a chunk (we're about to wait). */
function flush(state: State): void {
  placeHints(state);
  placeHeadRules(state);
  if (!state.buffer) return;
  state.chunks.push(state.buffer);
  state.buffer = "";
  // The head (and <Styles /> in it) has gone out: later rules go inline.
  state.cssAnchor = undefined;
  state.notify?.();
}

function renderChild(child: unknown, state: State): Step {
  if (child === null || child === undefined || typeof child === "boolean") return undefined;
  if (typeof child === "string") {
    write(state, escapeHtml(child));
    return undefined;
  }
  if (typeof child === "number" || typeof child === "bigint") {
    write(state, String(child));
    return undefined;
  }
  // Elements first: the common case. A binding is never one (it's a function proxy).
  if (isYerdNode(child)) return renderNode(child, state);
  // A field read from <Local> state: the value now, kept live in the browser.
  if (isBinding(child)) {
    const b = child as Binding;
    write(state, `<span data-yx-text="${escapeHtml(bindingSpec(b))}">${escapeHtml(String(b.value ?? ""))}</span>`);
    return undefined;
  }
  if (typeof child !== "object") throw new TypeError(`Cannot render ${typeof child} as a child`);
  if (Array.isArray(child)) return renderList(child, 0, state);
  if (isRawHtml(child)) {
    write(state, child.html);
    return undefined;
  }
  if (isPromiseLike(child)) {
    flush(state);
    return Promise.resolve(child).then((value) => renderChild(value, state));
  }
  if (isIterable(child)) return renderList(Array.from(child), 0, state);
  throw new TypeError(`Cannot render ${Object.prototype.toString.call(child)} as a child`);
}

function renderList(items: readonly unknown[], from: number, state: State, started = false): Step {
  for (let i = from; i < items.length; i++) {
    const step = renderChild(items[i], state);
    if (step) {
      if (!started) startSiblings(items, i + 1, state);
      return step.then(() => renderList(items, i + 1, state, true));
    }
  }
  return undefined;
}

const AsyncFunction = (async () => {}).constructor;

/**
 * The walk is about to wait on a child: call the async components after it in
 * the same list (arrays and fragments in it included) now, so they wait
 * alongside it. What each returns is kept until the walk gets there and
 * renders it in order. Calling a component doesn't depend on where the walk
 * is (it only gets its props, and the request's context follows promises),
 * so an early call is the same call. Only `async` functions: plain components
 * still run when they're reached. Not inside elements or other components,
 * whose children might never render.
 */
function startSiblings(items: readonly unknown[], from: number, state: State): void {
  for (let i = from; i < items.length; i++) {
    const item = items[i];
    if (Array.isArray(item)) startSiblings(item, 0, state);
    else if (isYerdNode(item)) {
      if (item.type === Fragment) {
        const children = item.props.children;
        startSiblings(Array.isArray(children) ? children : [children], 0, state);
      } else if (item.type instanceof AsyncFunction && !state.early?.has(item)) {
        (state.early ??= new Map()).set(item, start(item));
      }
    }
  }
}

function start(node: YerdNode): Early {
  const early: Early = { settled: undefined!, done: false, failed: false, value: undefined };
  // Handled here, so a component that fails before the walk gets to it (or
  // that it never gets to, after an earlier error) is no unhandled rejection.
  early.settled = Promise.resolve((node.type as (props: object) => unknown)(node.props)).then(
    (value) => {
      early.done = true;
      early.value = value;
    },
    (error: unknown) => {
      early.done = true;
      early.failed = true;
      early.value = error;
    },
  );
  return early;
}

/** An early-started component, where the walk got to it: its output, or its error, now. */
function renderEarly(early: Early, state: State): Step {
  if (!early.done) {
    flush(state);
    return early.settled.then(() => renderEarly(early, state));
  }
  if (early.failed) {
    // As if it had been awaited here: what came before it goes out first.
    flush(state);
    throw early.value;
  }
  return renderChild(early.value, state);
}

// Keys: jsx() keeps an element's key on the node and renderNode writes it as
// data-key (an explicit data-key prop wins). A key on a component or a
// Fragment has no element to land on and is dropped.
function renderNode(node: YerdNode, state: State): Step {
  const { type, props } = node;

  if (typeof type === "function") {
    if (type === Fragment) return renderChild(props.children, state);
    if (type === Dynamic) return renderDynamic(props as unknown as DynamicProps, state);
    if (type === Styles) {
      // A second <Styles /> takes over: the first one's rules go in first.
      placeHeadRules(state);
      write(state, (Styles() as RawHtml).html);
      // Rules this page uses go here from now on, while the head is still in the buffer.
      if (emitting(state)) state.cssAnchor = state.buffer.length;
      return undefined;
    }
    if (type === Local) return renderLocal(props as unknown as LocalProps<object>, state);
    if (type === Scripts) {
      write(state, (Scripts(props as { auto?: boolean }) as RawHtml).html);
      // The first one gets the hints, while the head is still in the buffer.
      if (emitting(state) && state.scriptsAnchor === undefined) state.scriptsAnchor = state.buffer.length;
      return undefined;
    }
    const early = state.early?.get(node);
    if (early) {
      // Called already, while the walk waited on an earlier sibling.
      state.early!.delete(node);
      return renderEarly(early, state);
    }
    // In "only" mode components outside a <Dynamic> still run (a Dynamic may
    // be anywhere inside them); only their output is dropped.
    return renderChild(type(props), state);
  }

  const flags = tagFlags(type);
  if (flags & VOID && !isEmpty(props.children)) {
    throw new TypeError(`<${type}> is a void element and cannot have children`);
  }

  // "only" mode, outside every <Dynamic>: the tags would be dropped, so don't
  // build them (or sign action tokens for them). The children may hold one.
  if (!emitting(state)) {
    state.started = true;
    return flags & VOID ? undefined : renderChild(props.children, state);
  }

  const open = openElement(type, flags, props, node.key, state);
  if (flags & VOID) return undefined;
  if (flags & RAW_TEXT) {
    writeRawText(type, props.children, state);
    write(state, `</${type}>`);
    return undefined;
  }
  const step = renderChild(props.children, state);
  if (step) return step.then(() => closeElement(type, open, state));
  closeElement(type, open, state);
  return undefined;
}

/**
 * Write an element's start tag (after the rules its classes need), and set up
 * the CSS scope it opens. Returns what closeElement() needs: the tag's flags,
 * less HOLDS_CSS when an outer element is already holding.
 */
function openElement(type: string, flags: number, props: Record<string, unknown>, key: YerdNode["key"], state: State): number {
  if (!state.started) {
    state.started = true;
    if (state.document && type.toLowerCase() === "html") write(state, "<!doctype html>");
  }
  const local = state.insideLocal > 0;
  let attrs = elementAttributes(props, type, local, state.cssFound);
  let hidden = "";
  if (attrs === undefined) {
    // An action, dropTo or a Cues prop: rewritten into what the runtime reads.
    state.cssFound.clear();
    const rewritten = rewriteProps(type, props);
    state.needs |= chunksFor(rewritten.attrs);
    attrs = renderAttributes(rewritten.attrs, type, true, local, state.cssFound);
    hidden = rewritten.hidden;
  }
  if (state.cssFound.size) writeClassStyles(state);
  if (flags & HOLDS_CSS) {
    if (state.cssHeld) flags &= ~HOLDS_CSS;
    else state.cssHeld = new Set();
  }
  if (flags & OWN_CSS) {
    (state.cssOuter ??= []).push(state.cssSent);
    state.cssSent = new Set(state.cssSent);
  }
  // null is nothing, as for any attribute: a null key isn't written, and
  // data-key={null} doesn't stand in for the key.
  const keyAttr = key == null || props["data-key"] != null ? "" : ` data-key="${escapeHtml(String(key))}"`;
  write(state, `<${type}${attrs}${keyAttr}>${hidden}`);
  return flags;
}

/** The end tag, and the end of the CSS scope openElement() set up. */
function closeElement(type: string, open: number, state: State): void {
  write(state, `</${type}>`);
  if (open & OWN_CSS) state.cssSent = state.cssOuter!.pop()!;
  if (open & HOLDS_CSS) {
    const held = state.cssHeld!;
    state.cssHeld = undefined;
    if (held.size) writeStyles(state, stylesFor(held, state.cssSent));
  }
}

/** css`` classes the element uses (cssFound): their rules go just before it (or are held). */
function writeClassStyles(state: State): void {
  const classes = state.cssFound;
  // In <head> there's nothing to hold for: <select>, <svg> and the rest don't matter there.
  if (state.cssHeld && state.cssAnchor === undefined) for (const name of classes) state.cssHeld.add(name);
  else writeStyles(state, stylesFor(classes, state.cssSent));
  classes.clear();
}

/** Rules into <head> at <Styles /> while it's still in the buffer, else inline here. */
function writeStyles(state: State, html: string): void {
  if (!html) return;
  if (state.cssAnchor === undefined) {
    write(state, html);
    return;
  }
  // Splicing each one in would copy the whole buffer per class.
  state.cssHead += html;
}

/**
 * The props elementAttributes() leaves to the renderer (it returns undefined
 * when there's one): an action becomes the attributes the runtime posts with,
 * `dropTo` and the Cues props their data-yx-* forms. `hidden` goes right
 * after the start tag. Rare, so copying the props is fine.
 */
function rewriteProps(type: string, props: Record<string, unknown>): { attrs: Record<string, unknown>; hidden: string } {
  let attrs = props;
  let hidden = "";
  if (type === "form") {
    // <form action={this.add}> / action={() => this.remove({ id })}: a POST to the owning route, carrying a signed token.
    if (isActionValue(props.action)) {
      const target = formAction(props.action as Parameters<typeof formAction>[0]);
      const { trigger, ...rest } = props;
      attrs = { ...rest, action: target.url, method: "post", "data-yx": true, "data-yx-trigger": trigger, "data-yx-holes": holesAttr(target.holes) };
      hidden = `<input type="hidden" name="_yx" value="${escapeHtml(target.token)}">`;
    }
  } else if ((type === "button" || type === "input") && (props.formaction !== undefined || props.formAction !== undefined)) {
    attrs = submitterAttributes(type, props);
  } else if (isActionValue(props.action)) {
    // An action on any other element: the runtime posts it when `trigger` fires (default: click).
    const target = formAction(props.action as Parameters<typeof formAction>[0]);
    const { action: _, trigger, ...rest } = props;
    attrs = {
      ...rest,
      "data-yx-action": target.url,
      "data-yx-token": target.token,
      "data-yx-trigger": trigger ?? "click",
      "data-yx-holes": holesAttr(target.holes),
    };
  }

  if (attrs.dropTo !== undefined) {
    const { dropTo, ...rest } = attrs;
    attrs = { ...rest, "data-yx-drop-to": dropTo };
  }
  if (attrs.sync !== undefined || attrs.cue !== undefined || attrs.cueRoom !== undefined || attrs.cueFrom !== undefined) {
    // Server-timed animation (see Cues): the runtime reads these.
    const { sync, cue, cueRoom, cueFrom, ...rest } = attrs;
    const names = Array.isArray(cue) ? cue.join(" ") : cue;
    attrs = {
      ...rest,
      "data-yx-sync": sync === true ? true : undefined,
      "data-yx-cue": names || undefined,
      "data-yx-cue-room": names ? cueRoom : undefined,
      "data-yx-cue-from": names ? cueFrom : undefined,
    };
  }
  return { attrs, hidden };
}

/** The runtime chunks rewritten attributes need: cues for sync and cues, dnd for a drop target. */
function chunksFor(attrs: Record<string, unknown>): number {
  let needs = 0;
  if (attrs["data-yx-sync"] || attrs["data-yx-cue"]) needs |= CUES;
  const trigger = attrs["data-yx-trigger"];
  if (attrs["data-yx-drop-to"] != null || (typeof trigger === "string" && trigger.trim().startsWith("drop"))) needs |= DND;
  return needs;
}

/** An @action, a lambda calling one, or bind(...) of one. */
function isActionValue(value: unknown): boolean {
  return typeof value === "function" || isBoundAction(value);
}

/** What the browser fills in when the action fires, for the runtime: JSON, or no attribute. */
function holesAttr(holes: string[][] | undefined): string | undefined {
  return holes?.length ? JSON.stringify(holes) : undefined;
}

/** Children a void element may be given: nothing, in any spelling. */
function isEmpty(children: unknown): boolean {
  if (children === undefined || children === null || typeof children === "boolean" || children === "") return true;
  if (!Array.isArray(children)) return false;
  for (let i = 0; i < children.length; i++) if (!isEmpty(children[i])) return false;
  return true;
}

/**
 * <button formaction={this.remove}>: the button posts to the action's route
 * and, being the submitter, adds the signed token as its own name/value
 * (_yx), which is where the server reads it from. Other buttons in the same
 * form submit normally. Inside <form action={action}> too: the submitter's
 * _yx comes after the form's hidden one, and the server takes the last.
 */
function submitterAttributes(type: string, props: Record<string, unknown>): Record<string, unknown> {
  const prop = props.formaction !== undefined ? "formaction" : "formAction";
  const value = props[prop];
  // Strings are plain URLs; anything else that isn't an action is renderAttributes' to reject.
  if (!isActionValue(value)) return props;
  const submits = type === "button" ? props.type === undefined || props.type === "submit" : props.type === "submit";
  if (!submits) throw new TypeError(`${prop}={action} needs a submit button: <button> or <input type="submit">`);
  if (props.name !== undefined || props.value !== undefined) {
    throw new TypeError(`<${type} ${prop}={action}> can't have its own name or value: it submits the action token as name="_yx"`);
  }
  const target = formAction(value as Parameters<typeof formAction>[0]);
  return { ...props, [prop]: target.url, formmethod: "post", name: "_yx", value: target.token, "data-yx-holes": holesAttr(target.holes) };
}

// What would end a raw text element early, or (in a script) put the parser
// in a state where it does.
const SCRIPT_END = /<\/script|<!--/i;
const STYLE_END = /<\/style/i;

/**
 * <script> and <style> contents are raw text: entities aren't decoded, so
 * escaping would corrupt them (`a > b` would become `a &gt; b`). Text and
 * raw() are written as is, but refused if together they could close the
 * element. For data, use json().
 */
function writeRawText(type: string, children: unknown, state: State): void {
  const text = rawText(type, children, "");
  if ((type === "script" ? SCRIPT_END : STYLE_END).test(text)) {
    throw new TypeError(`<${type}> text can't contain ${type === "script" ? "</script or <!--" : "</style"}; for data, use json()`);
  }
  write(state, text);
}

function rawText(type: string, children: unknown, out: string): string {
  if (children === null || children === undefined || typeof children === "boolean") return out;
  if (typeof children === "string") return out + children;
  if (typeof children === "number" || typeof children === "bigint") return out + String(children);
  if (isRawHtml(children)) return out + children.html;
  if (Array.isArray(children)) {
    for (let i = 0; i < children.length; i++) out = rawText(type, children[i], out);
    return out;
  }
  throw new TypeError(`<${type}> children must be text (strings, numbers, raw() or json())`);
}

/**
 * A <Local> scope: a display:contents wrapper carrying the initial state as
 * JSON and the name handlers use for it, then the render prop's output.
 */
function renderLocal(props: LocalProps<object>, state: State): Step {
  const { state: initial, children, persist } = props;
  if (typeof children !== "function") throw new TypeError("<Local> takes a render prop: {(s) => ...}");
  let json: string;
  try {
    json = JSON.stringify(initial);
  } catch (error) {
    throw new TypeError(`<Local> state must be JSON (plain objects, arrays, strings, numbers, booleans): ${(error as Error).message}`);
  }
  // undefined, a function, null, a Date...: the runtime needs an object to
  // hold fields (stringify gives undefined for some, which would render "undefined").
  if (json === undefined || (json[0] !== "{" && json[0] !== "[")) {
    throw new TypeError(`<Local> state must be an object, got ${json === undefined ? typeof initial : json}`);
  }
  const name = stateName(children);
  const store = typeof persist === "string" ? { key: persist, storage: "local" } : persist;
  if (store && !store.key) throw new TypeError("<Local persist> needs a non-empty key");
  const persisted = store ? ` data-yx-persist="${escapeHtml(store.key)}"${store.storage === "session" ? ' data-yx-storage="session"' : ""}` : "";
  write(state, `<yerd-local data-yx-local="${escapeHtml(json)}" data-yx-as="${name}"${persisted} style="display:contents">`);
  state.needs |= LOCAL;
  return scoped(state, "insideLocal", () => {
    const step = renderChild(children(localState(initial)), state);
    if (step) return step.then(() => write(state, "</yerd-local>"));
    write(state, "</yerd-local>");
    return undefined;
  });
}

function renderDynamic(props: DynamicProps, state: State): Step {
  const { id, fallback, noscript, children, as = "div", ...rest } = props;
  const flags = tagFlags(as);
  if (flags & (VOID | RAW_TEXT)) throw new TypeError(`<Dynamic as="${as}">: the wrapper must be an element that holds other elements`);
  if (!DYNAMIC_ID.test(id)) throw new TypeError(`<Dynamic> ids must be letters, digits, - and _ (got ${JSON.stringify(id)})`);
  const deferred = state.dynamic === "fallback";
  const attrs = { ...rest, id, "data-yx-region": true, "data-yx-defer": deferred || undefined };
  return scoped(state, "insideDynamic", () => {
    const open = openElement(as, flags, attrs, undefined, state);
    const finish = (): Step => {
      if (!deferred || noscript === undefined) {
        closeElement(as, open, state);
        return undefined;
      }
      // Without JavaScript nothing fills the skeleton: hide it, show this instead.
      const step = renderNode(jsx("noscript", { children: [raw(`<style>#${id}>:not(noscript){display:none!important}</style>`), noscript] }), state);
      if (step) return step.then(() => closeElement(as, open, state));
      closeElement(as, open, state);
      return undefined;
    };
    // Prerendering: the skeleton. Otherwise: the real content, per request.
    const step = renderChild(deferred ? fallback : children(), state);
    return step ? step.then(finish) : finish();
  });
}

/**
 * The walk recurses per level (about three frames per element), so a tree
 * nested a few thousand elements deep overflows the stack. Real pages are
 * nowhere near that; an iterative walk would cost every page, so instead the
 * engine's bare RangeError gets a message that says what happened.
 */
function explainOverflow(error: unknown): unknown {
  if (!(error instanceof RangeError) || !error.message.includes("call stack")) return error;
  return new RangeError(
    "Rendering overflowed the call stack: the tree is nested too deeply (thousands of levels) or a component renders itself without end",
    { cause: error },
  );
}

/**
 * Render to a stream of HTML chunks, flushed at the points where rendering
 * has to wait (an async component, a promise child), so the top of the page
 * goes out first. Handlers that return JSX are already streamed this way;
 * use it to send rendered HTML somewhere else, like a file.
 *
 * ```tsx
 * import { createWriteStream } from "node:fs";
 * import { Readable } from "node:stream";
 *
 * Readable.from(renderToStream(<Report />, { document: true })).pipe(createWriteStream("report.html"));
 * ```
 */
export async function* renderToStream(child: Child, options: RenderOptions = {}): AsyncGenerator<string> {
  const state: State = {
    buffer: "",
    document: options.document ?? false,
    started: false,
    dynamic: options.dynamic,
    insideDynamic: 0,
    insideLocal: 0,
    cssSent: new Set(),
    cssFound: new Set(),
    cssAnchor: undefined,
    cssHead: "",
    needs: 0,
    scriptsAnchor: undefined,
    cssHeld: undefined,
    cssOuter: undefined,
    early: undefined,
    chunks: [],
    notify: undefined,
  };
  let step: Step;
  try {
    step = renderChild(child, state);
  } catch (error) {
    throw explainOverflow(error);
  }
  if (!step) {
    // Synchronous all the way: one chunk.
    placeHints(state);
    placeHeadRules(state);
    if (state.buffer) yield state.buffer;
    return;
  }
  let finished = false;
  let failure: { error: unknown } | undefined;
  step.then(
    () => {
      finished = true;
      state.notify?.();
    },
    (error: unknown) => {
      failure = { error: explainOverflow(error) };
      state.notify?.();
    },
  );
  while (true) {
    while (state.chunks.length > 0) yield state.chunks.shift()!;
    if (failure) throw failure.error;
    if (finished) break;
    await new Promise<void>((resolve) => (state.notify = resolve));
    state.notify = undefined;
  }
  placeHints(state);
  placeHeadRules(state);
  if (state.buffer) yield state.buffer;
}

/**
 * Render to a single HTML string, awaiting async components. For HTML that
 * isn't a response (an email body, a snippet in a test); handlers can just
 * return the JSX.
 *
 * ```tsx
 * const html = await renderToString(<WelcomeEmail name={user.name} />);
 * await mailer.send({ to: user.email, subject: "Welcome", html });
 * ```
 */
export async function renderToString(child: Child, options: RenderOptions = {}): Promise<string> {
  let html = "";
  for await (const chunk of renderToStream(child, options)) html += chunk;
  return html;
}
