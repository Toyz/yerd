/**
 * Parsers and validators shared by the request accessors (toInt, @file...)
 * and the DTO decorators (is.int, is.file...), so both read a value the same
 * way. A leaf module: it imports nothing, and the parsers report failure by
 * returning undefined, leaving each caller to word its own error.
 */

/**
 * Checks a value without changing it. Return `true` (or nothing) to accept,
 * `false` to reject with a generic 400, or a string to reject with that message.
 * Throwing an HttpError also works. Validators see the transformed value and
 * run in order; the first to reject wins.
 *
 * ```ts
 * const even: Validator<number> = (n) => n % 2 === 0 || "Must be even";
 *
 * @query("size", { transform: toInt, validate: [between(2, 64), even] }) accessor size = 8;
 * ```
 */
export type Validator<T> = (value: T) => boolean | string | void;

const INTEGER = /^-?\d+$/;
// Decimal notation only: Number() would also take "Infinity", "0x10" and "1e999".
const NUMBER = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/**
 * A base-10 integer (optional leading minus, digits only, surrounding spaces
 * allowed), or undefined. The result can be beyond Number.MAX_SAFE_INTEGER;
 * check Number.isSafeInteger to refuse those.
 */
export function parseInteger(raw: string): number | undefined {
  const text = raw.trim();
  return INTEGER.test(text) ? Number(text) : undefined;
}

/** A finite decimal number (`"3.5"`, `"-.5"`, `"1e3"`, surrounding spaces allowed), or undefined. */
export function parseNumber(raw: string): number | undefined {
  const text = raw.trim();
  if (!NUMBER.test(text)) return undefined;
  // "1e400" passes the pattern but overflows to Infinity.
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The words read as booleans, case-sensitive, matching what HTML sends: a
 * ticked checkbox posts "on", and a bare `?flag` (or `flag=`) has an empty
 * value, which means present. An unticked checkbox sends nothing at all.
 */
const TRUE = new Set(["true", "1", "on", ""]);
const FALSE = new Set(["false", "0", "off"]);

/** "true", "1", "on" or "" as true; "false", "0" or "off" as false; anything else undefined. */
export function parseBool(raw: string): boolean | undefined {
  if (TRUE.has(raw)) return true;
  if (FALSE.has(raw)) return false;
  return undefined;
}

/**
 * Run a field's transforms, left to right, then its validators. Returns the
 * value, or a Rejection when a validator refuses it. A step that throws
 * throws through: request accessors let an HttpError become the response,
 * DTOs turn the error into an issue.
 */
export function runPipe(value: unknown, transforms: readonly ((value: any) => unknown)[], validators: readonly Validator<any>[]): unknown {
  for (const step of transforms) value = step(value);
  for (const check of validators) {
    const verdict = check(value);
    if (verdict === false) return new Rejection(undefined);
    if (typeof verdict === "string") return new Rejection(verdict);
  }
  return value;
}

/** A validator's refusal: its message, or undefined for a plain `false` (the caller words a generic one). */
export class Rejection {
  constructor(readonly message: string | undefined) {}
}

/** One step or a list of them, as a list. For normalizing `transform` / `validate` options once, up front. */
export function steps<F extends Function>(option: F | readonly F[] | undefined): readonly F[] {
  if (option === undefined) return [];
  return typeof option === "function" ? [option as F] : (option as readonly F[]);
}

// ── files ──

/** Size and type limits on an uploaded file (@file, @files, is.file, is.files). */
export interface FileLimits {
  /** Largest file, in bytes. */
  maxSize?: number;
  /** Accepted mime types, `image/*` style wildcards allowed; matched case-insensitively. */
  types?: readonly string[];
}

/**
 * An empty file input still posts a part, with no name and no bytes: that's
 * "no file". True for a file that was actually chosen.
 */
export function isSentFile(file: File): boolean {
  return file.size > 0 || file.name !== "";
}

function typeAccepted(type: string, accepted: readonly string[]): boolean {
  const actual = type.toLowerCase();
  return accepted.some((t) => {
    const want = t.toLowerCase();
    return want.endsWith("/*") ? actual.startsWith(want.slice(0, -1)) : actual === want;
  });
}

/** Why `file` breaks `limits`, with the status a request accessor answers it with; undefined when it fits. */
export function fileProblem(file: File, limits: FileLimits | undefined): { status: 413 | 415; message: string } | undefined {
  if (limits?.maxSize !== undefined && file.size > limits.maxSize) {
    return { status: 413, message: `File is larger than ${limits.maxSize} bytes` };
  }
  const types = limits?.types;
  if (types && !typeAccepted(file.type, types)) {
    return { status: 415, message: `File type ${file.type || "(unknown)"} isn't accepted (${types.join(", ")})` };
  }
  return undefined;
}

// ── validators ──

/**
 * Numbers within [min, max], inclusive. Rejects with "Must be from 1 to 10
 * (got 12)". Works on accessors after a number transform, and in DTOs.
 *
 * ```ts
 * @query("page", { transform: toInt, validate: between(1, 500) }) accessor page = 1;
 *
 * class Review {
 *   @is.int({ validate: between(1, 10) }) rating!: number;
 * }
 * ```
 */
export function between(min: number, max: number): Validator<number> {
  return (n) => (n >= min && n <= max) || `Must be from ${min} to ${max} (got ${n})`;
}

/**
 * String or array length within [min, max], inclusive. `max` defaults to
 * unlimited, so `length(1)` means "not empty". Put `trim` before it so blank
 * input doesn't count.
 *
 * ```ts
 * class Listing {
 *   @is.string({ transform: trim, validate: length(1, 140) }) title!: string;
 *   @is.array(is.string(), { validate: length(0, 5) }) tags: string[] = [];
 * }
 * ```
 */
export function length(min: number, max = Infinity): Validator<string | readonly unknown[]> {
  return (value) => {
    if (value.length >= min && value.length <= max) return true;
    if (value.length === 0) return "Can't be empty";
    const unit = typeof value === "string" ? "characters" : "items";
    if (max === Infinity) return `Must be at least ${min} ${unit} (got ${value.length})`;
    if (min <= 0) return `Must be at most ${max} ${unit} (got ${value.length})`;
    return `Must be ${min} to ${max} ${unit} (got ${value.length})`;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Deliberately loose: one @, no spaces, a dot in the domain. The only real check is sending mail to it.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A UUID (any case), optionally of one version: `uuid()`, `uuid(4)`, `uuid(7)`.
 * For params and queries; DTOs have `is.uuid()`, which also lowercases.
 *
 * ```ts
 * @route("/orders/:id")
 * export class Order {
 *   @param("id", { validate: uuid(4) }) accessor id!: string;
 * }
 * ```
 */
export function uuid(version?: number): Validator<string> {
  return (value) => {
    if (!UUID.test(value)) return "Expected a UUID";
    if (version !== undefined && value[14]!.toLowerCase() !== version.toString(16)) return `Expected a version ${version} UUID`;
    return true;
  };
}

/**
 * A plausible email address (one @, a dot in the domain, no spaces, at most
 * 254 characters). Loose on purpose: sending mail to it is the only real
 * check. For params, queries and fields; DTOs have `is.email()`.
 *
 * ```ts
 * @query("notify", { transform: trim, validate: email() }) accessor notify: string | undefined;
 * ```
 */
export function email(): Validator<string> {
  return (value) => (value.length <= 254 && EMAIL.test(value)) || "Expected an email address";
}

/**
 * String matching a regular expression, rejecting with `message` (or a
 * generic one). Anchor the pattern (`^...$`) to match the whole value.
 *
 * ```ts
 * @query("ref", { validate: matches(/^[A-Z]{3}-\d{4}$/, "Expected a code like ABC-1234") }) accessor ref: string | undefined;
 * ```
 */
export function matches(pattern: RegExp, message?: string): Validator<string> {
  return (value) => {
    pattern.lastIndex = 0;
    return pattern.test(value) || (message ?? "Isn't in the expected format");
  };
}
