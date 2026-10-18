/**
 * Local state: interactivity that runs entirely in the browser, with no
 * request. A render prop gets the state; reading a field renders its value
 * and marks the spot as bound to it, and event handlers are shipped to the
 * browser as their source (like custom attributes' client halves).
 *
 * ```tsx
 * <Local state={{ count: 0, open: false }}>
 *   {(s) => (
 *     <div>
 *       <span>{s.count}</span>
 *       <button onClick={() => s.count++}>+1</button>
 *       <button onClick={() => (s.open = !s.open)}>details</button>
 *       <p hidden={not(s.open)}>Only when open.</p>
 *     </div>
 *   )}
 * </Local>
 * ```
 *
 * - On the server, `s.count` renders the initial value (a text binding is a
 *   `<span data-yx-text>`; attributes and class flags are bound too). In the
 *   browser the runtime keeps a copy of the state, runs the handlers against
 *   it, and re-applies the bindings after each one.
 * - A binding is a direct field read (`s.count`, `s.user.name`, `not(s.x)`).
 *   Expressions (`s.count * 2`, `s.open ? a : b`) render the initial value but
 *   don't update; derive in a handler into another field instead.
 * - Handlers may use the state (by the render prop's parameter name) and
 *   their event argument, nothing else from the server: they're sent as text.
 *   Compiling them in the browser needs `'unsafe-eval'` under a strict CSP.
 * - The state is JSON: plain objects, arrays, strings, numbers, booleans.
 * - `persist="key"` keeps it in localStorage (or sessionStorage) across
 *   reloads. The server still renders the defaults, so the saved values
 *   appear once the runtime starts.
 */

import type { Child } from "../jsx/jsx-runtime.js";

const BINDING: unique symbol = Symbol.for("yerd.binding");
/** eq()'s value, under a symbol so a state field called `equals` stays a field. */
const EQUALS: unique symbol = Symbol.for("yerd.binding.equals");

/** A bound field read, as the renderer sees it. */
export interface Binding {
  readonly [BINDING]: true;
  readonly path: string;
  readonly value: unknown;
  readonly negate: boolean;
  /** From eq(): the binding is `field === value` rather than the field itself. */
  readonly [EQUALS]?: unknown;
}

/**
 * How a binding is written for the runtime: `[!]path`, plus `=<JSON>` for an
 * eq() binding (URI-encoded, so `;` and `:` in the value can't break the list).
 */
export function bindingSpec(b: Binding): string {
  const equals = b[EQUALS];
  const compare = equals !== undefined ? `=${encodeURIComponent(JSON.stringify(equals))}` : "";
  return `${b.negate ? "!" : ""}${b.path}${compare}`;
}

export function isBinding(value: unknown): value is Binding {
  return (typeof value === "object" || typeof value === "function") && value !== null && (value as Binding)[BINDING] === true;
}

/**
 * A state object whose field reads are bindings. Each read returns a proxy
 * that is both a Binding (for the renderer) and readable further
 * (`s.user.name`), and that converts to its initial value in expressions.
 */
function bindable(value: unknown, path: string): unknown {
  const target = function binding() {} as unknown as Record<PropertyKey, unknown>;
  return new Proxy(target, {
    get(_t, key) {
      if (key === BINDING) return true;
      if (key === "path") return path;
      if (key === "value") return value;
      if (key === "negate") return false;
      if (key === Symbol.toPrimitive) return () => value;
      if (key === "toString") return () => String(value);
      if (key === "valueOf") return () => value;
      if (key === "toJSON") return () => value;
      if (typeof key !== "string") return undefined;
      // Every read is a callable proxy, so `then` would make a binding look
      // like a promise that never settles: an async component returning one,
      // or Promise.resolve(s.count), would hang the render. Only a field that
      // really is called `then` is bound.
      if (key === "then" && !(value !== null && typeof value === "object" && "then" in value)) return undefined;
      const inner = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
      return bindable(inner, path ? `${path}.${key}` : key);
    },
  });
}

/** The inverse of a boolean binding: `hidden={not(s.open)}`. */
export function not(binding: boolean): boolean {
  if (!isBinding(binding)) return !binding;
  const b = binding as unknown as Binding;
  return { [BINDING]: true, path: b.path, value: !b.value, negate: !b.negate, [EQUALS]: b[EQUALS] } as unknown as boolean;
}

/**
 * Whether a field equals a value, kept in step: `class={{ active: eq(s.tab, "specs") }}`,
 * `hidden={not(eq(s.slide, 2))}`. The value is compared as JSON (strings,
 * numbers, booleans, null).
 */
export function eq<T>(field: T, value: T): boolean {
  if (!isBinding(field)) return field === value;
  const b = field as unknown as Binding;
  if (b[EQUALS] !== undefined) throw new TypeError("eq() takes a field of the state, not another eq()");
  // The runtime negates after comparing, so eq(not(x), v) can't be written down.
  if (b.negate) throw new TypeError("eq() takes a field of the state, not not(); write not(eq(field, value))");
  return { [BINDING]: true, path: b.path, value: b.value === value, negate: false, [EQUALS]: value } as unknown as boolean;
}

export interface LocalProps<S extends object> {
  /** The initial state; serialized as JSON for the browser. */
  state: S;
  /**
   * Keep the state in the browser's storage under this key, so it survives
   * reloads: `persist="likes"` (localStorage), or `{ key, storage: "session" }`
   * for sessionStorage. Saved values are merged over `state` on load (so new
   * fields get their defaults); every scope with the same key, in this tab
   * and others, stays in step.
   */
  persist?: string | { key: string; storage?: "local" | "session" };
  /** Renders the UI from the state. Its parameter's name is how handlers refer to the state. */
  children: (state: S) => Child;
}

/**
 * A client-side state scope. See the module docs; the renderer handles it
 * (this function is only its identity and type).
 */
export function Local<S extends object>(_props: LocalProps<S>): Child {
  throw new Error("<Local> is rendered by yerd's renderer");
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** The render prop's parameter name: what handlers call the state. */
export function stateName(fn: Function): string {
  const source = fn.toString();
  // \b: a parameter that merely starts with "async" or "function" is a name.
  const match = /^(?:async\b\s*)?(?:function\b[^(]*)?\(?\s*([^)=,\s]*)/.exec(source);
  const name = match?.[1] ?? "";
  if (!IDENTIFIER.test(name)) {
    throw new TypeError(`<Local>'s render prop needs a plain parameter name, like (s) => ..., not ${JSON.stringify(name || source.slice(0, 30))}`);
  }
  return name;
}

/** Build the state proxy for one scope. */
export function localState<S extends object>(state: S): S {
  return bindable(state, "") as S;
}
