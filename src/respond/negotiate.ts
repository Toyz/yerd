/**
 * Content negotiation on the Accept header.
 *
 * Two ways in: `@accepts("json")` on a second handler for the same verb, or
 * returning `negotiate({ html: () => ..., json: () => ... })` from one handler.
 * Either way the rules are:
 *
 * - An explicit type (`application/json`) or range (`application/*`) in Accept
 *   selects the variant that produces it, by q-value.
 * - A bare `*` / `*` never selects a variant over the default: browsers send
 *   `text/html,...,*;q=0.8` and should keep getting HTML.
 * - If Accept explicitly prefers something no variant offers (text/html, say)
 *   and there's a default, the default wins.
 * - Nothing acceptable and no default: 406.
 */

/** Short names `@accepts` and negotiate() understand. */
export type MediaShorthand = "html" | "json" | "ndjson" | "text" | "sse" | "xml" | "csv";

/** Common full types, listed so editors can complete them. */
export type CommonMediaType =
  | "text/html" | "text/plain" | "text/csv" | "text/xml" | "text/event-stream" | "text/markdown" | "text/calendar"
  | "application/json" | "application/x-ndjson" | "application/xml" | "application/xhtml+xml" | "application/ld+json"
  | "application/problem+json" | "application/pdf" | "application/zip" | "application/octet-stream"
  | "application/atom+xml" | "application/rss+xml" | "application/manifest+json"
  | "image/png" | "image/jpeg" | "image/webp" | "image/avif" | "image/svg+xml";

/**
 * A media type for content negotiation: a shorthand (`"json"`), a common
 * type, or any other `type/subtype` (`"application/vnd.api+json"`). Anything
 * else, like a typo such as `"jsno"`, doesn't compile.
 */
export type MediaType = MediaShorthand | CommonMediaType | `${string}/${string}`;

const SHORTHAND: Record<MediaShorthand, string> = {
  html: "text/html",
  json: "application/json",
  ndjson: "application/x-ndjson",
  text: "text/plain",
  sse: "text/event-stream",
  xml: "application/xml",
  csv: "text/csv",
};

/** "json" -> "application/json"; full types pass through, lowercased. */
export function expandType(type: string): string {
  return (SHORTHAND[type as MediaShorthand] ?? type).toLowerCase();
}

interface Range {
  type: string;
  subtype: string;
  q: number;
}

/**
 * Parse an Accept header into media ranges with their q-values, in header
 * order (not sorted). q is clamped to 0-1; a malformed q counts as 0. A
 * missing header gives an empty list. `@accepts` and negotiate() cover the
 * usual cases; this is for deciding something else by Accept yourself.
 *
 * ```ts
 * parseAccept("application/json, text/*;q=0.5");
 * // [{ type: "application", subtype: "json", q: 1 }, { type: "text", subtype: "*", q: 0.5 }]
 *
 * const wantsCsv = parseAccept(ctx.headers.accept).some((r) => r.subtype === "csv" && r.q > 0);
 * ```
 */
export function parseAccept(header: string | undefined): Range[] {
  if (!header) return [];
  const ranges: Range[] = [];
  for (const part of header.split(",")) {
    const [media, ...params] = part.trim().split(";");
    if (!media) continue;
    const [type = "*", subtype = "*"] = media.trim().toLowerCase().split("/");
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split("=");
      if (key?.toLowerCase() === "q") q = Math.min(1, Math.max(0, Number(value) || 0));
    }
    ranges.push({ type, subtype, q });
  }
  return ranges;
}

/** Best q for `mime` from non-wildcard ranges (exact or `type/*`), or -1 when none names it. */
function explicitQuality(mime: string, ranges: Range[]): number {
  const [type, subtype] = mime.split("/");
  let best = -1;
  let specificity = -1;
  for (const r of ranges) {
    if (r.type === "*") continue;
    const exact = r.type === type && r.subtype === subtype;
    const partial = r.type === type && r.subtype === "*";
    if (!exact && !partial) continue;
    const s = exact ? 2 : 1;
    if (s > specificity || (s === specificity && r.q > best)) {
      specificity = s;
      best = r.q;
    }
  }
  return best;
}

/**
 * Choose among variants, each identified by the mime types it produces.
 * Returns the index of the chosen variant, `"default"`, or `undefined` (406).
 */
export function choose(variants: readonly (readonly string[])[], accept: string | undefined, hasDefault: boolean): number | "default" | undefined {
  const ranges = parseAccept(accept);
  const onlyWildcards = ranges.every((r) => r.type === "*");
  if (ranges.length === 0 || onlyWildcards) {
    if (hasDefault) return "default";
    return variants.length > 0 && (ranges.length === 0 || ranges.some((r) => r.q > 0)) ? 0 : undefined;
  }

  let bestIndex = -1;
  let bestQ = 0;
  variants.forEach((types, index) => {
    for (const mime of types) {
      const q = explicitQuality(mime, ranges);
      if (q > bestQ) {
        bestQ = q;
        bestIndex = index;
      }
    }
  });

  // Explicitly wanted types that no variant produces (usually text/html, which the default renders).
  const offered = new Set(variants.flat());
  let otherQ = 0;
  for (const r of ranges) {
    if (r.type === "*" || r.subtype === "*") continue;
    if (!offered.has(`${r.type}/${r.subtype}`)) otherQ = Math.max(otherQ, r.q);
  }

  if (hasDefault && (bestIndex === -1 || otherQ > bestQ)) return "default";
  if (bestIndex !== -1) return bestIndex;
  // Only wildcard matches left: */* with q > 0 accepts the first variant
  // the client didn't refuse by name (`application/json;q=0, */*`).
  const anyQ = ranges.find((r) => r.type === "*")?.q ?? 0;
  if (anyQ <= 0) return undefined;
  const index = variants.findIndex((types) => types.some((mime) => explicitQuality(mime, ranges) !== 0));
  return index === -1 ? undefined : index;
}

const NEGOTIATED: unique symbol = Symbol.for("yerd.negotiated");

/**
 * negotiate()'s argument: a producer per media type, keyed by shorthand or
 * mime type. The first key is the default. Name the type to build the
 * variants up before negotiating.
 *
 * ```tsx
 * @get async list() {
 *   const todos = await this.db.todos.all();
 *   const variants: Variants = { html: () => <TodoList todos={todos} />, json: () => todos };
 *   if (this.csv) variants.csv = () => toCsv(todos);
 *   return negotiate(variants);
 * }
 * ```
 */
export type Variants = { [K in MediaType]?: () => unknown };

/**
 * What negotiate() returns; the response pipeline picks and runs one variant.
 * Name it as the return type of a helper that several handlers share.
 *
 * ```tsx
 * function todoResponse(todo: Todo): Negotiated {
 *   return negotiate({ html: () => <h1>{todo.title}</h1>, json: () => todo });
 * }
 * ```
 */
export interface Negotiated {
  /** Brand that marks a negotiate() result. */
  readonly [NEGOTIATED]: true;
  /** The variants, as passed to negotiate(). */
  readonly variants: Variants;
}

/**
 * Return different representations from one handler; the Accept header picks.
 * The first key is the default. Keys are shorthands ("html", "json", "ndjson",
 * "text", "csv", "xml", "sse") or full mime types. Only the chosen function
 * runs. Negotiated responses get `Vary: Accept`.
 *
 * ```tsx
 * @get show() {
 *   return negotiate({ html: () => <TodoPage todos={todos} />, json: () => ({ todos }) });
 * }
 * ```
 */
export function negotiate(variants: Variants): Negotiated {
  if (Object.keys(variants).length === 0) throw new TypeError("negotiate() needs at least one variant");
  for (const key of Object.keys(variants)) {
    if (!(key in SHORTHAND) && !/^[\w.+-]+\/[\w.+-]+$/.test(key)) throw new TypeError(`negotiate(): "${key}" isn't a media type (use a shorthand like "json" or a type/subtype)`);
  }
  return { [NEGOTIATED]: true, variants };
}

export function isNegotiated(value: unknown): value is Negotiated {
  return typeof value === "object" && value !== null && (value as Negotiated)[NEGOTIATED] === true;
}
