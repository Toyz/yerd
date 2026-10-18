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
 */

import type { Child } from "../jsx/jsx-runtime.js";

const BINDING: unique symbol = Symbol.for("yerd.binding");

/** A bound field read, as the renderer sees it. */
export interface Binding {
  readonly [BINDING]: true;
  readonly path: string;
  readonly value: unknown;
  readonly negate: boolean;
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
      const inner = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
      return bindable(inner, path ? `${path}.${key}` : key);
    },
  });
}

/** The inverse of a boolean binding: `hidden={not(s.open)}`. */
export function not(binding: boolean): boolean {
  if (!isBinding(binding)) return !binding;
  const b = binding as unknown as Binding;
  return { [BINDING]: true, path: b.path, value: !b.value, negate: true } as unknown as boolean;
}

export interface LocalProps<S extends object> {
  /** The initial state; serialized as JSON for the browser. */
  state: S;
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
  const match = /^(?:async\s*)?(?:function[^(]*)?\(?\s*([^)=,\s]*)/.exec(source);
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
