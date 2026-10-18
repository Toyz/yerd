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
 */

import { Fragment, isYerdNode, type Child, type YerdNode } from "../jsx/jsx-runtime.js";
import { renderAttributes } from "./attrs.js";
import { escapeHtml, isRawHtml } from "./escape.js";
import { formAction, isAction, isBoundAction } from "../actions/action.js";
import { DYNAMIC_ID, Dynamic, type DynamicProps } from "./dynamic.js";
import { classesIn, stylesFor } from "./css.js";
import { Local, bindingSpec, isBinding, localState, stateName, type Binding, type LocalProps } from "./local.js";

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

const VALID_TAG = /^[a-zA-Z][a-zA-Z0-9-]*$/;

// Tags repeat constantly; remember the ones already checked (capped).
const checkedTags = new Set<string>();

function checkTag(tag: string): void {
  if (checkedTags.has(tag)) return;
  if (!VALID_TAG.test(tag)) throw new TypeError(`Invalid element name: ${JSON.stringify(tag)}`);
  if (checkedTags.size < 1024) checkedTags.add(tag);
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
  /** Inside a <select>, where the parser drops <style>: rules wait here for it to close. */
  cssHeld: Set<string> | undefined;
  /** Flushed chunks waiting for the stream's consumer. */
  chunks: string[];
  /** Wakes the stream's consumer when a chunk is flushed. */
  notify: (() => void) | undefined;
}

/** `undefined`: finished synchronously. A promise: continue after it. */
type Step = Promise<void> | undefined;

function write(state: State, html: string): void {
  if (state.dynamic !== "only" || state.insideDynamic > 0) state.buffer += html;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as PromiseLike<unknown>).then === "function";
}

function isIterable(value: unknown): value is Iterable<Child> {
  return typeof value === "object" && value !== null && typeof (value as Iterable<unknown>)[Symbol.iterator] === "function";
}

/** Hand the buffer to the consumer as a chunk (we're about to wait). */
function flush(state: State): void {
  if (!state.buffer) return;
  state.chunks.push(state.buffer);
  state.buffer = "";
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
  // A field read from <Local> state: the value now, kept live in the browser.
  if (isBinding(child)) {
    const b = child as Binding;
    write(state, `<span data-yx-text="${escapeHtml(bindingSpec(b))}">${escapeHtml(String(b.value ?? ""))}</span>`);
    return undefined;
  }
  if (typeof child !== "object") throw new TypeError(`Cannot render ${typeof child} as a child`);
  if (isYerdNode(child)) return renderNode(child, state);
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

function renderList(items: readonly unknown[], from: number, state: State): Step {
  for (let i = from; i < items.length; i++) {
    const step = renderChild(items[i], state);
    if (step) return step.then(() => renderList(items, i + 1, state));
  }
  return undefined;
}

// Keys: jsx() keeps an element's key on the node and renderNode writes it as
// data-key (an explicit data-key prop wins). A key on a component or a
// Fragment has no element to land on and is dropped.
function renderNode(node: YerdNode, state: State): Step {
  const { type, props } = node;

  if (typeof type === "function") {
    if (type === Fragment) return renderChild(props.children, state);
    if (type === Dynamic) return renderDynamic(props as unknown as DynamicProps, state);
    if (type === Local) return renderLocal(props as unknown as LocalProps<object>, state);
    // In "only" mode components outside a <Dynamic> still run (a Dynamic may
    // be anywhere inside them); only their output is dropped.
    return renderChild(type(props), state);
  }

  checkTag(type);

  if (!state.started) {
    state.started = true;
    if (state.document && type.toLowerCase() === "html") write(state, "<!doctype html>");
  }

  const isVoid = VOID_ELEMENTS.has(type);
  if (isVoid && !isEmpty(props.children)) {
    throw new TypeError(`<${type}> is a void element and cannot have children`);
  }

  // "only" mode, outside every <Dynamic>: the tags would be dropped, so don't
  // build them (or sign action tokens for them). The children may hold one.
  if (state.dynamic === "only" && state.insideDynamic === 0) {
    return isVoid ? undefined : renderChild(props.children, state);
  }

  writeClassStyles(props, state);
  const holdsCss = HOLDS_CSS.has(type) && !state.cssHeld;
  if (holdsCss) state.cssHeld = new Set();
  const outerSent = OWN_CSS.has(type) ? state.cssSent : undefined;
  if (outerSent) state.cssSent = new Set(outerSent);

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
    attrs = submitterAttributes(type, props, state);
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
  // null is nothing, as for any attribute: a null key isn't written, and
  // data-key={null} doesn't stand in for the key.
  const key = node.key == null || props["data-key"] != null ? "" : ` data-key="${escapeHtml(String(node.key))}"`;
  write(state, `<${type}${renderAttributes(attrs, type, true, state.insideLocal > 0)}${key}>${hidden}`);
  if (isVoid) return undefined;
  if (type === "script" || type === "style") {
    writeRawText(type, props.children, state);
    write(state, `</${type}>`);
    return undefined;
  }
  const close = holdsCss || outerSent ? () => {
    write(state, `</${type}>`);
    if (outerSent) state.cssSent = outerSent;
    if (!holdsCss) return;
    const held = state.cssHeld!;
    state.cssHeld = undefined;
    if (held.size) write(state, stylesFor(held, state.cssSent));
  } : () => write(state, `</${type}>`);
  const step = renderChild(props.children, state);
  if (step) return step.then(close);
  close();
  return undefined;
}

// Where the parser drops a <style> (<select>), closes the element at one
// (<colgroup>), or reads it as markup or not at all (<svg>, <math>): rules for
// classes inside wait until the element has closed.
const HOLDS_CSS = new Set(["select", "colgroup", "svg", "math"]);
// Contents that aren't part of the page (<template>), or aren't once scripts
// run (<noscript>): rules sent inside don't count as sent for the rest of it.
const OWN_CSS = new Set(["template", "noscript"]);

/** css`` classes in class / className: their rules go just before the first element using them (or are held). */
function writeClassStyles(props: Record<string, unknown>, state: State): void {
  if (props.class === undefined && props.className === undefined) return;
  const classes = classesIn([props.class, props.className]);
  if (!classes.size) return;
  if (state.cssHeld) for (const name of classes) state.cssHeld.add(name);
  else write(state, stylesFor(classes, state.cssSent));
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
function submitterAttributes(type: string, props: Record<string, unknown>, state: State): Record<string, unknown> {
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
  state.insideLocal++;
  const done = () => {
    state.insideLocal--;
    write(state, "</yerd-local>");
  };
  let step: Step;
  try {
    step = renderChild(children(localState(initial)), state);
  } catch (error) {
    state.insideLocal--;
    throw error;
  }
  if (step) return step.then(done, (error: unknown) => {
    state.insideLocal--;
    throw error;
  });
  done();
  return undefined;
}

function renderDynamic(props: DynamicProps, state: State): Step {
  const { id, fallback, noscript, children, as = "div", ...rest } = props;
  checkTag(as);
  if (!DYNAMIC_ID.test(id)) throw new TypeError(`<Dynamic> ids must be letters, digits, - and _ (got ${JSON.stringify(id)})`);
  const deferred = state.dynamic === "fallback";
  const attrs = { ...rest, id, "data-yx-region": true, "data-yx-defer": deferred || undefined };
  state.insideDynamic++;
  const finish = () => {
    if (deferred && noscript !== undefined) {
      // Without JavaScript nothing fills the skeleton: hide it, show this instead.
      write(state, `<noscript><style>#${id}>:not(noscript){display:none!important}</style>`);
      // Its rules don't count as sent for the rest of the page (see OWN_CSS).
      const outerSent = state.cssSent;
      state.cssSent = new Set(outerSent);
      const step = renderChild(noscript, state);
      if (step) return step.then(() => {
        state.cssSent = outerSent;
        write(state, `</noscript></${as}>`);
      });
      state.cssSent = outerSent;
      write(state, "</noscript>");
    }
    write(state, `</${as}>`);
    return undefined;
  };
  const done = () => {
    state.insideDynamic--;
  };
  try {
    writeClassStyles(rest, state);
    write(state, `<${as}${renderAttributes(attrs, as, true, state.insideLocal > 0)}>`);
    // Prerendering: the skeleton. Otherwise: the real content, per request.
    const step = renderChild(deferred ? fallback : children(), state);
    const tail = step ? step.then(finish) : finish();
    if (tail) return tail.then(done, (error: unknown) => {
      done();
      throw error;
    });
    done();
    return undefined;
  } catch (error) {
    done();
    throw error;
  }
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
    cssHeld: undefined,
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
