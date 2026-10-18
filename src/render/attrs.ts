import { attributeVersion, customAttribute, type AttributeDef } from "../attributes/attribute.js";
import { escapeHtml, isRawHtml } from "./escape.js";

// Anything that could end the attribute name or the tag. Attribute names come
// from prop keys, which can come from spread objects, so they're validated
// rather than trusted.
const VALID_ATTR_NAME = /^[^\s"'<>/=\x00-\x1f\x7f]+$/;

// Names repeat constantly across a page, so what we know about each (valid?
// a custom attribute?) is looked up once and remembered: one Map lookup per
// attribute on the hot path. Capped, in case names come from user data, and
// dropped when custom attributes are (re)defined.
interface NameInfo {
  valid: boolean;
  custom: AttributeDef<any> | undefined;
}
const names = new Map<string, NameInfo>();
let namesVersion = -1;

function nameInfo(name: string): NameInfo {
  let info = names.get(name);
  if (info === undefined) {
    info = { valid: VALID_ATTR_NAME.test(name), custom: customAttribute(name) };
    if (names.size < 2048) names.set(name, info);
  }
  return info;
}

export type ClassValue = string | null | undefined | false | ClassValue[] | Record<string, unknown>;

/** Flatten a class value into a space-separated string, in one pass with no intermediate arrays. */
export function classNames(value: ClassValue): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return appendClasses("", value);
}

function appendClasses(out: string, value: ClassValue): string {
  if (!value) return out;
  if (typeof value === "string") return out ? `${out} ${value}` : value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) out = appendClasses(out, value[i]);
    return out;
  }
  for (const name in value) if (value[name]) out = out ? `${out} ${name}` : name;
  return out;
}

const VALID_STYLE_PROPERTY = /^(--[\w-]+|-?[a-zA-Z][a-zA-Z0-9-]*)$/;
// Anything that could end the declaration or the rule: a value is one value.
const UNSAFE_STYLE_VALUE = /[;{}<]/;

// Property name -> validated CSS name, capped like checkedNames.
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
export function styleString(value: unknown): string {
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

/** Attributes whose value is a URL, checked for script-running schemes. First char first: this runs per string attribute. */
function isUrlAttribute(name: string): boolean {
  switch (name.charCodeAt(0)) {
    case 104: return name === "href";
    case 115: return name === "src";
    case 97: return name === "action";
    case 102: return name === "formaction" || name === "formAction";
    case 120: return name === "xlink:href";
    case 112: return name === "poster" || name === "ping";
    case 99: return name === "cite";
    case 98: return name === "background";
    case 100: return name === "data";
  }
  return false;
}

export const BLOCKED_URL = "about:blank#blocked";

// Browsers drop leading C0 controls and spaces, and tabs/newlines anywhere,
// before reading the scheme: "  java\tscript:" is javascript:.
const URL_IGNORED = /[\x00-\x20]/g;

/**
 * javascript:, vbscript: and data: URLs become about:blank#blocked, except
 * data:image/ on src and poster. Wrap a value in raw() to write it as given.
 */
export function safeUrl(name: string, url: string): string {
  const c = url.charCodeAt(0);
  // "/path", "#hash", "?query", "./rel": no scheme. The common case.
  if (c === 47 || c === 35 || c === 63 || c === 46) return url;
  const colon = url.indexOf(":");
  if (colon === -1) return url;
  const scheme = url.slice(0, colon).replace(URL_IGNORED, "").toLowerCase();
  if (scheme === "javascript" || scheme === "vbscript") return BLOCKED_URL;
  if (scheme === "data") {
    if ((name === "src" || name === "poster") && url.slice(colon + 1).replace(URL_IGNORED, "").toLowerCase().startsWith("image/")) return url;
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
    case 97: return name.startsWith("aria-") ? (value ? "true" : "false") : undefined;
    case 100: return name === "draggable" ? (value ? "true" : "false") : undefined;
    case 115: return name === "spellcheck" || name === "spellCheck" ? (value ? "true" : "false") : undefined;
    case 99: return name === "contenteditable" || name === "contentEditable" ? (value ? "true" : "false") : undefined;
    case 116: return name === "translate" ? (value ? "yes" : "no") : undefined;
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
 * raw() is written verbatim, unescaped and unchecked. class and className are
 * merged into one class attribute. `key` and `children` are never attributes
 * (render.ts writes the key as data-key). Custom attributes (see
 * attribute()) render through their own `render`; `custom` is false for that
 * output, so a custom attribute can write its own name as a plain attribute.
 */
export function renderAttributes(props: Record<string, unknown>, tag = "", custom = true): string {
  let out = "";
  let classDone = false;
  if (namesVersion !== attributeVersion()) {
    names.clear();
    namesVersion = attributeVersion();
  }
  for (const name in props) {
    if (name === "children" || name === "key") continue;
    let value = props[name];
    if (value === null || value === undefined) continue;
    const info = nameInfo(name);
    if (custom) {
      const def = info.custom;
      if (def) {
        const rendered = def.render ? def.render(value, { tag, props }) : defaultCustom(name, value);
        if (rendered) out += renderAttributes(rendered, tag, false);
        continue;
      }
    }
    if (typeof value === "function") {
      // Event handlers on server-rendered elements become sprinkles in M6.
      // Until then they produce no output.
      if (isEventHandlerName(name)) continue;
      throw new TypeError(`Attribute ${name} got a function; only on* event handlers (dropped on the server) and formaction={action} on a submit button accept one`);
    }
    if (value === false && enumerated(name, false) === undefined) continue;

    if (!info.valid) throw new TypeError(`Invalid attribute name: ${JSON.stringify(name)}`);

    if (name === "class" || name === "className") {
      // Both given: one attribute, in prop order.
      if (classDone) continue;
      classDone = true;
      const other = name === "class" ? props.className : props.class;
      value = other ? appendClasses(classNames(value as ClassValue), other as ClassValue) : classNames(value as ClassValue);
      if (value === "") continue;
      out += ` class="${escapeHtml(value as string)}"`;
      continue;
    }
    if (name === "style" && !isRawHtml(value)) {
      value = styleString(value);
      if (value === "") continue;
    }

    if (typeof value === "object") {
      if (isRawHtml(value)) {
        out += ` ${name}="${value.html}"`;
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
  return out;
}
