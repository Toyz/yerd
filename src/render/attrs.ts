import { attributeVersion, customAttribute, selfContainedSource, type AttributeDef } from "../attributes/attribute.js";
import { cssClassesIn, keyframesIn } from "./css.js";
import { escapeHtml, isJsonText, isRawHtml } from "./escape.js";
import { bindingSpec, isBinding, type Binding } from "./local.js";

// Anything that could end the attribute name or the tag. Attribute names come
// from prop keys, which can come from spread objects, so they're validated
// rather than trusted.
const VALID_ATTR_NAME = /^[^\s"'<>/=\x00-\x1f\x7f]+$/;

// Props the renderer rewrites before they're attributes (see rewriteProps in
// render.ts): an action (`action`, `formaction` on a submit button), which
// is never a string, `dropTo`, and the Cues props, whatever their value.
const UNLESS_STRING = 1;
const ALWAYS = 2;
const RENDERER_PROPS = new Map([
  ["action", UNLESS_STRING], ["formaction", UNLESS_STRING], ["formAction", UNLESS_STRING],
  ["dropTo", ALWAYS], ["sync", ALWAYS], ["cue", ALWAYS], ["cueRoom", ALWAYS], ["cueFrom", ALWAYS],
]);

// Names repeat constantly across a page, so what we know about each (valid?
// a custom attribute? the renderer's?) is looked up once and remembered: one
// Map lookup per attribute on the hot path. Capped, in case names come from
// user data, and dropped when custom attributes are (re)defined.
interface NameInfo {
  valid: boolean;
  custom: AttributeDef<any> | undefined;
  renderer: number;
}
const names = new Map<string, NameInfo>();
let namesVersion = -1;

/**
 * Custom attributes with a module client half, written since the renderer
 * last looked: it empties this after each element, to preload the lazy
 * chunk (and the module, for "load"). Module state, like walkCss below: an
 * element's attributes are written synchronously.
 */
export const lazyAttributes: AttributeDef<any>[] = [];

function nameInfo(name: string): NameInfo {
  let info = names.get(name);
  if (info === undefined) {
    info = { valid: VALID_ATTR_NAME.test(name), custom: customAttribute(name), renderer: RENDERER_PROPS.get(name) ?? 0 };
    if (names.size < 2048) names.set(name, info);
  }
  return info;
}

export type ClassValue = string | null | undefined | false | ClassValue[] | Record<string, unknown>;

// What walkClasses() finds besides the class string: <Local> class bindings
// and css`` classes. Module state rather than arguments or a closure: a walk
// is synchronous and runs no user code, so two never overlap.
let walkBinds: string[] | undefined;
let walkCss: Set<string> | undefined;

/**
 * One pass over a class value, appending its classes to `out`. On the way it
 * collects class flags bound to <Local> state (`{ active: s.selected }`, also
 * inside an array: each is its initial value plus a `class.<flag>` binding
 * per class in the flag, as the browser's classList takes one at a time) and
 * the css`` classes named (flag keys whether on or off: they may switch on
 * later). A binding used as a class name (`["card", s.theme]`) is an
 * expression: its initial value, not kept in step. raw() is its text.
 */
function walkClasses(out: string, value: unknown): string {
  if (typeof value === "string") {
    if (walkCss && value.includes("yx-")) cssClassesIn(value, walkCss);
    return value === "" ? out : out ? `${out} ${value}` : value;
  }
  if (typeof value !== "object" || value === null) {
    // A binding is a function proxy; anything else here holds no classes.
    return typeof value === "function" && isBinding(value) ? walkClasses(out, (value as Binding).value) : out;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) out = walkClasses(out, value[i]);
    return out;
  }
  if (isRawHtml(value)) return walkClasses(out, value.html);
  const flags = value as Record<string, unknown>;
  for (const flag in flags) {
    const on = flags[flag];
    if (walkCss && flag.includes("yx-")) cssClassesIn(flag, walkCss);
    if (isBinding(on)) {
      const spec = bindingSpec(on as Binding);
      for (const word of flag.split(/\s+/)) if (word) (walkBinds ??= []).push(`class.${word}:${spec}`);
      if (!(on as Binding).value) continue;
    } else if (!on) continue;
    out = out ? `${out} ${flag}` : flag;
  }
  return out;
}

/** The css`` classes in a class value, as rendering finds them. */
export function classesIn(value: unknown, out: Set<string> = new Set()): Set<string> {
  walkCss = out;
  walkClasses("", value);
  walkCss = undefined;
  walkBinds = undefined;
  return out;
}

const VALID_STYLE_PROPERTY = /^(--[\w-]+|-?[a-zA-Z][a-zA-Z0-9-]*)$/;
// Anything that could end the declaration or the rule: a value is one value.
const UNSAFE_STYLE_VALUE = /[;{}<]/;

// Property name -> validated CSS name, remembered like attribute names (capped).
const styleNames = new Map<string, string>();

function cssName(property: string): string {
  let name = styleNames.get(property);
  if (name !== undefined) return name;
  name = property.startsWith("--") ? property : property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  // msTransform -> -ms-transform (WebkitX already gets its dash from the capital).
  if (name.startsWith("ms-")) name = `-${name}`;
  if (!VALID_STYLE_PROPERTY.test(name)) throw new TypeError(`Invalid style property: ${JSON.stringify(property)}`);
  if (styleNames.size < 1024) styleNames.set(property, name);
  return name;
}

/**
 * A style object as a declaration list: camelCase keys become kebab-case,
 * `--custom` properties pass through, nullish/false/"" values are skipped.
 * Numbers are written as they are, without a unit (`{ width: 10 }` is
 * `width:10`, which CSS ignores: write "10px"). Values can't contain `;`,
 * `{`, `}` or `<`; a style string is passed through as given instead.
 */
function styleString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return "";
  let out = "";
  for (const property in value) {
    const v = (value as Record<string, unknown>)[property];
    if (v === null || v === undefined || v === false || v === "") continue;
    const text = String(v);
    if (UNSAFE_STYLE_VALUE.test(text)) throw new TypeError(`Invalid value for style ${property}: ${JSON.stringify(text)}`);
    out += out ? `;${cssName(property)}:${text}` : `${cssName(property)}:${text}`;
  }
  return out;
}

/**
 * Attributes whose value is a URL, checked for script-running schemes. HTML
 * attribute names are case-insensitive (`SRC` is `src`), so the check is
 * too. First char first, lower-cased by bit: this runs per string attribute,
 * and only a name of the right length and first letter is lower-cased whole.
 */
function isUrlAttribute(name: string): boolean {
  switch (name.charCodeAt(0) | 32) {
    case 104: return named(name, "href");
    case 115: return named(name, "src");
    case 97: return named(name, "action");
    case 102: return named(name, "formaction");
    case 120: return named(name, "xlink:href");
    case 112: return named(name, "poster") || named(name, "ping");
    case 99: return named(name, "cite");
    case 98: return named(name, "background");
    case 100: return named(name, "data");
  }
  return false;
}

/** `name` is `lower` in any case. */
function named(name: string, lower: string): boolean {
  return name.length === lower.length && (name === lower || name.toLowerCase() === lower);
}

const BLOCKED_URL = "about:blank#blocked";

// Browsers drop leading C0 controls and spaces, and tabs/newlines anywhere,
// before reading the scheme: "  java\tscript:" is javascript:.
const URL_IGNORED = /[\x00-\x20]/g;

/**
 * javascript:, vbscript: and data: URLs become about:blank#blocked, except
 * data:image/ on src and poster. Wrap a value in raw() to write it as given.
 */
function safeUrl(name: string, url: string): string {
  const c = url.charCodeAt(0);
  // "/path", "#hash", "?query", "./rel": no scheme. The common case.
  if (c === 47 || c === 35 || c === 63 || c === 46) return url;
  const colon = url.indexOf(":");
  if (colon === -1) return url;
  const scheme = url.slice(0, colon).replace(URL_IGNORED, "").toLowerCase();
  if (scheme === "javascript" || scheme === "vbscript") return BLOCKED_URL;
  if (scheme === "data") {
    if ((named(name, "src") || named(name, "poster")) && url.slice(colon + 1).replace(URL_IGNORED, "").toLowerCase().startsWith("image/")) return url;
    return BLOCKED_URL;
  }
  return url;
}

/**
 * Enumerated attributes take the words, not presence: aria-hidden={false}
 * must say "false", and draggable="" isn't draggable="true". Returns
 * undefined for ordinary boolean attributes (true: bare, false: omitted).
 * data-* stays boolean: data-x={true} renders bare.
 */
function enumerated(name: string, value: boolean): string | undefined {
  switch (name.charCodeAt(0)) {
    case 97:
      if (name.startsWith("aria-")) return value ? "true" : "false";
      // Omitted, autocorrect means on: false has to say "off".
      return name === "autocorrect" ? (value ? "on" : "off") : undefined;
    case 100: return name === "draggable" ? (value ? "true" : "false") : undefined;
    case 115: return name === "spellcheck" || name === "spellCheck" ? (value ? "true" : "false") : undefined;
    case 99: return name === "contenteditable" || name === "contentEditable" ? (value ? "true" : "false") : undefined;
    case 116: return name === "translate" ? (value ? "yes" : "no") : undefined;
    case 119: return name === "writingsuggestions" ? (value ? "true" : "false") : undefined;
  }
  return undefined;
}

/** A custom attribute without its own render: strings and booleans as usual, objects as JSON. */
function defaultCustom(name: string, value: unknown): Record<string, unknown> {
  return { [name]: typeof value === "object" && value !== null && !isRawHtml(value) ? JSON.stringify(value) : value };
}

function isEventHandlerName(name: string): boolean {
  return name.charCodeAt(0) === 111 && name.charCodeAt(1) === 110; // "on"
}

/**
 * Render a props object to an attribute string with a leading space per attribute.
 *
 * Values: strings are escaped (URL attributes are also scheme-checked, see
 * safeUrl); numbers are written as is, NaN is omitted; true is a bare
 * attribute and false/null/undefined omit it, except for enumerated ones (see
 * enumerated); URL objects are stringified and Dates written as ISO strings;
 * raw() is written verbatim, unescaped and unchecked (json() is escaped like a
 * string). class and className are merged into one class attribute. `key`
 * and `children` are never attributes
 * (render.ts writes the key as data-key). Custom attributes (see
 * attribute()) render through their own `render`; `custom` is false for that
 * output, so a custom attribute can write its own name as a plain attribute.
 * The css`` classes in class and the keyframes in style go into `found`,
 * classes first.
 */
export function renderAttributes(props: Record<string, unknown>, tag = "", custom = true, local = false, found?: Set<string>): string {
  return attributes(props, tag, custom, local, false, found)!;
}

/**
 * An element's own props, as renderAttributes(), or undefined when one of
 * them is the renderer's to rewrite first (an action, `dropTo`, the Cues
 * props): it checks for those as it goes, so other elements pay nothing.
 */
export function elementAttributes(props: Record<string, unknown>, tag: string, local: boolean, found: Set<string>): string | undefined {
  return attributes(props, tag, true, local, true, found);
}

function attributes(props: Record<string, unknown>, tag: string, custom: boolean, local: boolean, renderer: boolean, found: Set<string> | undefined): string | undefined {
  let out = "";
  let classDone = false;
  let styleText: string | undefined;
  // <Local> bindings on this element: "hidden:!open;class.active:sel".
  let binds: string[] | undefined;
  if (namesVersion !== attributeVersion()) {
    names.clear();
    namesVersion = attributeVersion();
  }
  for (const name in props) {
    if (name === "children" || name === "key") continue;
    let value = props[name];
    if (value === null || value === undefined) continue;
    const info = nameInfo(name);
    if (renderer && info.renderer && (info.renderer === ALWAYS || typeof value !== "string")) return undefined;
    if (isBinding(value)) {
      const b = value as Binding;
      if (name === "class" || name === "className") {
        // The runtime sets the attribute by this name, so className binds as
        // class. Next to the other spelling it's only part of the class list,
        // which the runtime can't keep in step on its own: just the value.
        if (props[name === "class" ? "className" : "class"] == null) (binds ??= []).push(`class:${bindingSpec(b)}`);
      } else (binds ??= []).push(`${name}:${bindingSpec(b)}`);
      value = b.value;
      if (value === null || value === undefined) continue;
    }
    if (custom) {
      const def = info.custom;
      if (def) {
        const rendered = def.render ? def.render(value, { tag, props }) : defaultCustom(name, value);
        if (rendered) {
          out += renderAttributes(rendered, tag, false, false, found);
          if (typeof def.client === "string") lazyAttributes.push(def);
        }
        continue;
      }
    }
    if (typeof value === "function") {
      if (isEventHandlerName(name)) {
        // Inside <Local> a handler runs in the browser: its source goes along.
        // Elsewhere there's nothing to run it, so it's dropped.
        if (local) {
          // The name becomes part of an attribute name, so it's checked like one.
          if (!info.valid) throw new TypeError(`Invalid attribute name: ${JSON.stringify(name)}`);
          out += ` data-yx-on-${name.slice(2).toLowerCase()}="${escapeHtml(selfContainedSource(value, `${name} in <Local>`))}"`;
        }
        continue;
      }
      throw new TypeError(`Attribute ${name} got a function; only on* event handlers (dropped on the server) and formaction={action} on a submit button accept one`);
    }
    if (value === false && enumerated(name, false) === undefined) continue;

    if (!info.valid) throw new TypeError(`Invalid attribute name: ${JSON.stringify(name)}`);

    if (name === "class" || name === "className") {
      // Both given: one attribute, in prop order.
      if (classDone) continue;
      classDone = true;
      const other = name === "class" ? props.className : props.class;
      // Both given, className first: css`` classes are still found class first.
      if (found && name === "className" && other != null) classesIn(other, found);
      walkBinds = binds;
      walkCss = found;
      // Both given: the other one's flags are bound too.
      const text = walkClasses(walkClasses("", value), other);
      binds = walkBinds;
      walkBinds = undefined;
      walkCss = undefined;
      if (text === "") continue;
      out += ` class="${escapeHtml(text)}"`;
      continue;
    }
    if (name === "style") {
      if (!isRawHtml(value)) {
        value = styleString(value);
        if (value === "") continue;
      }
      // `style={{ animation: `${pop} 1s` }}`: the keyframes go too, after the classes.
      if (found) styleText = typeof value === "string" ? value : (value as { html: string }).html;
    }

    if (typeof value === "object") {
      if (isRawHtml(value)) {
        // json() is data, often a user's: its quotes would end the attribute.
        out += ` ${name}="${isJsonText(value) ? escapeHtml(value.html) : value.html}"`;
        continue;
      }
      if (value instanceof URL) value = value.href;
      else if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) throw new TypeError(`Attribute ${name} got an invalid Date`);
        value = value.toISOString();
      } else throw new TypeError(`Attribute ${name} got an object; only class and style accept objects`);
    }

    if (typeof value === "string") {
      out += ` ${name}="${escapeHtml(isUrlAttribute(name) ? safeUrl(name, value) : value)}"`;
    } else if (typeof value === "boolean") {
      const word = enumerated(name, value);
      out += word === undefined ? ` ${name}` : ` ${name}="${word}"`;
    } else if (typeof value === "number") {
      if (value === value) out += ` ${name}="${value}"`;
    } else {
      out += ` ${name}="${escapeHtml(String(value))}"`;
    }
  }
  if (styleText !== undefined) keyframesIn(styleText, found!);
  if (binds) out += ` data-yx-bind="${escapeHtml(binds.join(";"))}"`;
  return out;
}
