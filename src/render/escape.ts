const NEEDS_ESCAPE = /[&<>"']/;

/**
 * Escape text for use in HTML text content or a quoted attribute value.
 *
 * Most strings need nothing, and V8's native regex test finds that far
 * faster than a JS loop can (a pure charCodeAt scan measured 7-15x slower on
 * clean strings; `search` was slower than `test` here too). Only when there
 * is something to replace does it switch to a hand-written scan, copying
 * slices between replacements, which beats `replace` with a callback.
 *
 * JSX already escapes every string, so you need this only when you build
 * HTML by hand, typically inside raw():
 *
 * ```ts
 * const badge = raw(`<mark title="${escapeHtml(user.name)}">${escapeHtml(user.name)}</mark>`);
 * ```
 */
export function escapeHtml(value: string): string {
  if (!NEEDS_ESCAPE.test(value)) return value;
  let out = "";
  let last = 0;
  for (let i = 0; i < value.length; i++) {
    let entity: string;
    switch (value.charCodeAt(i)) {
      case 38: entity = "&amp;"; break;
      case 60: entity = "&lt;"; break;
      case 62: entity = "&gt;"; break;
      case 34: entity = "&quot;"; break;
      case 39: entity = "&#39;"; break;
      default: continue;
    }
    if (i !== last) out += value.slice(last, i);
    out += entity;
    last = i + 1;
  }
  return last < value.length ? out + value.slice(last) : out;
}

const RAW: unique symbol = Symbol.for("yerd.raw");

/**
 * Pre-rendered HTML that the renderer writes without escaping: what raw()
 * and json() return. It's a valid Child, so it goes anywhere JSX children go.
 *
 * ```tsx
 * function icon(name: string): RawHtml {
 *   return raw(readFileSync(`icons/${name}.svg`, "utf8"));
 * }
 *
 * <button>{icon("trash")} Delete</button>
 * ```
 */
export interface RawHtml {
  /** Brand that marks a raw() result. */
  readonly [RAW]: true;
  /** The HTML, written as is. */
  readonly html: string;
}

/**
 * Opt out of escaping. The string is written to the page exactly as given, so
 * it must never contain unsanitized user input. For HTML you already trust:
 * rendered Markdown, an SVG from disk.
 *
 * ```tsx
 * const article = <article>{raw(markdownToHtml(post.body))}</article>;
 * ```
 */
export function raw(html: string): RawHtml {
  return { [RAW]: true, html };
}

export function isRawHtml(value: unknown): value is RawHtml {
  return typeof value === "object" && value !== null && (value as RawHtml)[RAW] === true;
}

const JSON_UNSAFE = /[<>&\u2028\u2029]/g;
const JSON_ESCAPES: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};
/** Marks json() output, which attributes escape (see isJsonText). */
const JSON_TEXT: unique symbol = Symbol.for("yerd.json");

/**
 * Data for an inline script: JSON with `<`, `>`, `&`, U+2028 and U+2029
 * written as \u escapes, so it can't close the <script> or open a comment,
 * and parses as the same value.
 *
 * ```tsx
 * <script type="application/json" id="data">{json(state)}</script>
 * ```
 *
 * As an attribute value it's escaped like a string (JSON is full of `"`,
 * which would end the attribute), so `data-props={json(props)}` is safe too.
 */
export function json(value: unknown): RawHtml {
  const text = JSON.stringify(value) ?? "null";
  return { [RAW]: true, [JSON_TEXT]: true, html: text.replace(JSON_UNSAFE, (c) => JSON_ESCAPES[c]!) } as RawHtml;
}

/** Whether a raw() value came from json(): safe as script text, but not as an attribute value as is. */
export function isJsonText(value: RawHtml): boolean {
  return (value as RawHtml & { [JSON_TEXT]?: true })[JSON_TEXT] === true;
}
