/**
 * DTO classes: the class is the schema.
 *
 * TypeScript types are erased at runtime, so `body<Signup>()` alone couldn't
 * validate anything. Instead, decorate the fields of a class; `body(Signup)`
 * infers the type from the class, checks the input against the decorators and
 * returns a real `Signup` instance. A field decorator that doesn't match its
 * field's declared type is a compile error, so the validated shape and the
 * declared type can't drift apart.
 *
 * ```ts
 * class Signup {
 *   @is.string({ transform: [trim, lower], validate: matches(/@/) }) email!: string;
 *   @is.int({ validate: between(13, 120) }) age!: number;
 *   @is.string({ optional: true }) referrer?: string;
 * }
 * ```
 */

import { HttpError } from "../respond/response.js";
import { createKey, metadataOf } from "./keys.js";
import { assertPublicInstance } from "./util.js";
import type { FieldOutput, IsValidPipe, Pipe, PipeError, Transform } from "./request.js";
import { email, fileProblem, parseBool, parseInteger, parseNumber, Rejection, runPipe, steps, uuid, type Validator } from "./parse.js";

/**
 * One problem found while validating, with a path like `address.city` or
 * `tags[2]`. A failed DTO throws a 400 HttpError whose `details.issues` lists
 * every one; catch it to show them your own way.
 *
 * ```ts
 * try {
 *   parse(Signup, raw);
 * } catch (error) {
 *   if (!(error instanceof HttpError) || !error.details) throw error;
 *   for (const { path, message } of error.details.issues as Issue[]) console.log(`${path}: ${message}`);
 * }
 * ```
 */
export interface Issue {
  /** Where the problem is: a field path, or "(root)" for the value itself. */
  path: string;
  /** What's wrong, e.g. "Required" or "Expected an integer". */
  message: string;
}

const INVALID: unique symbol = Symbol("yerd.invalid");

/**
 * Where a value sits, as Spec.parse is told: a path string, or, inside nested
 * DTOs and arrays, a parent and a key, joined into `address.city` or
 * `tags[2]` only when there is an issue to report.
 */
export type Path = string | { readonly parent: Path; readonly key: string | number };

function pathText(path: Path): string {
  if (typeof path === "string") return path;
  const parent = pathText(path.parent);
  if (typeof path.key === "number") return `${parent}[${path.key}]`;
  return parent ? `${parent}.${path.key}` : path.key;
}

function child(parent: Path, key: string | number): Path {
  return parent === "" && typeof key === "string" ? key : { parent, key };
}

/**
 * How to check and convert one value. Every `is.*` decorator carries one as
 * `.spec`. Apps rarely touch it; it's how `is.array` checks its items, and it
 * lets tests or tooling run one rule on its own.
 *
 * ```ts
 * const issues: Issue[] = [];
 * is.int().spec.parse("42", "age", issues);  // 42
 * is.int().spec.parse("old", "age", issues); // issues: [{ path: "age", message: "Expected an integer" }]
 * ```
 */
export interface Spec<T> {
  /** Whether a missing value is allowed. */
  readonly optional: boolean;
  /** Check and convert `value`; on failure, push to `issues` and return the INVALID marker. */
  parse(value: unknown, path: Path, issues: Issue[]): T | typeof INVALID;
}

interface DtoField {
  key: string;
  spec: Spec<unknown>;
}

export const DTO_FIELDS = createKey<DtoField[]>("dto:fields");

/**
 * A DTO class: constructible with no arguments, its fields decorated with
 * `is.*`. Field initializers act as defaults for missing values. Use it to
 * type helpers that take any DTO.
 *
 * ```ts
 * export async function loadJson<T>(cls: DtoClass<T>, path: string): Promise<T> {
 *   return parse(cls, JSON.parse(await readFile(path, "utf8")));
 * }
 *
 * const config = await loadJson(AppConfig, "config.json"); // an AppConfig
 * ```
 */
export type DtoClass<T> = new () => T;

/**
 * The decorator an `is.*` factory returns. If the field's declared type can't
 * hold the validated value, the return type is something TypeScript rejects at
 * the `@`. Name it to keep a rule in a constant and reuse it, on fields or as
 * `is.array`'s item.
 *
 * ```ts
 * const tag: IsDecorator<string> = is.string({ transform: [trim, lower], validate: length(1, 30) });
 *
 * class Post {
 *   @tag category!: string;
 *   @is.array(tag, { max: 5 }) tags!: string[];
 * }
 * ```
 */
export type IsDecorator<T> = (<This, V>(
  value: undefined,
  context: ClassFieldDecoratorContext<This, V>,
) => [T] extends [V] ? void : { "field type does not accept the validated value": T }) & {
  readonly spec: Spec<T>;
};

/**
 * Options every `is.*` decorator takes. Steps run in order: type check,
 * transform, validate. `O` is the options object itself (inferred whole), so
 * a pipeline can change the type and validators are typed by its output.
 */
export interface IsOptions<B, O = unknown> {
  /**
   * Missing (or `undefined`) is allowed and leaves the field undefined, or
   * its initializer. The field's type must then allow undefined; a field with
   * an initializer doesn't need `optional` at all.
   *
   * ```ts
   * @is.string({ optional: true }) nickname?: string;
   * ```
   */
  optional?: boolean;
  /**
   * Transform(s) run after the type check, left to right; each takes the
   * previous one's output, so the last decides the field's type:
   * `[trim, lower]`, or `[trim, toUuid]` for a branded `Uuid`. Throw to reject.
   *
   * ```ts
   * @is.string({ transform: [trim, lower] }) handle!: string;
   * ```
   */
  transform?: Pipe;
  /**
   * Validator(s) run last, on the transformed value. `false` or a string
   * rejects it. Inline functions need their parameter annotated.
   *
   * ```ts
   * @is.int({ validate: [between(1, 100), (n: number) => n % 5 === 0 || "Must be a multiple of 5"] }) step!: number;
   * ```
   */
  validate?: Validator<FieldOutput<O, B>> | readonly Validator<FieldOutput<O, B>>[];
}

/** The field type: the pipeline's output (or the checked value), plus undefined when optional. */
type Out<O, B> = O extends { optional: true } ? FieldOutput<O, B> | undefined : FieldOutput<O, B>;

/** The decorator, or (for a pipeline whose steps don't line up) something `@` rejects. */
type Checked<O, B> = (O extends { transform: infer T } ? IsValidPipe<T, B> : true) extends true ? IsDecorator<Out<O, B>> : PipeError;

/** Checks for is.file() / is.files(). */
export interface FileRules {
  /** Largest file, in bytes. */
  maxSize?: number;
  /** Accepted mime types, `image/*` style wildcards allowed. */
  types?: readonly string[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type AnyIsOptions = { optional?: boolean; transform?: Pipe; validate?: Validator<any> | readonly Validator<any>[] };

/** An is.* decorator's transforms and validators, normalized once, when the decorator is made. */
interface Pipeline {
  readonly transforms: readonly Transform<any, any>[];
  readonly validators: readonly Validator<any>[];
}

function pipelineOf(options: AnyIsOptions | undefined): Pipeline {
  return { transforms: steps(options?.transform as Transform<any, any> | readonly Transform<any, any>[] | undefined), validators: steps(options?.validate) };
}

function finish(input: unknown, path: Path, issues: Issue[], pipeline: Pipeline): unknown {
  if (pipeline.transforms.length === 0 && pipeline.validators.length === 0) return input;
  try {
    const value = runPipe(input, pipeline.transforms, pipeline.validators);
    return value instanceof Rejection ? issue(issues, path, value.message ?? "Invalid value") : value;
  } catch (error) {
    return issue(issues, path, messageOf(error));
  }
}

function issue(issues: Issue[], path: Path, message: string): typeof INVALID {
  issues.push({ path: pathText(path) || "(root)", message });
  return INVALID;
}

function makeDecorator<T>(spec: Spec<T>): IsDecorator<T> {
  const decorator = function (_value: undefined, context: ClassFieldDecoratorContext): void {
    assertPublicInstance(context, "DTO decorators");
    const fields = DTO_FIELDS.ownArray<DtoField>(context.metadata);
    const field: DtoField = { key: String(context.name), spec: spec as Spec<unknown> };
    // A subclass redeclaring a field replaces the parent's spec rather than adding a second one.
    const existing = fields.findIndex((f) => f.key === field.key);
    if (existing >= 0) fields[existing] = field;
    else fields.push(field);
  };
  return Object.assign(decorator, { spec }) as unknown as IsDecorator<T>;
}

function primitive<B>(check: (value: unknown) => B | typeof INVALID, expected: string) {
  return <const O extends IsOptions<B, O> = {}>(options?: O): Checked<O, B> => {
    const pipeline = pipelineOf(options);
    return makeDecorator({
      optional: options?.optional ?? false,
      parse(value, path, issues) {
        const base = check(value);
        if (base === INVALID) return issue(issues, path, `Expected ${expected}`);
        return finish(base, path, issues, pipeline);
      },
    }) as unknown as Checked<O, B>;
  };
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

/** Whether year-month-day is a real calendar date. */
function sameUtcDay(year: number, month: number, day: number): boolean {
  // setUTCFullYear, unlike Date.UTC, doesn't map years 0-99 to 1900-1999.
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}


/**
 * Field decorators for DTO classes. Numbers and booleans also accept their
 * string forms (`"42"`, `"true"`, `"on"`), so the same DTO works for JSON and
 * URL-encoded form bodies. Every one takes `optional`, `transform` and
 * `validate` (see IsOptions). DTO fields are plain fields, not accessors; pass
 * the class to `@body`, `form.parse()` or `parse()`.
 *
 * ```ts
 * class Address {
 *   @is.string({ transform: trim, validate: length(1) }) city!: string;
 *   @is.string({ optional: true }) zip?: string;
 * }
 *
 * class Signup {
 *   @is.email() email!: string;
 *   @is.int({ validate: between(13, 120) }) age!: number;
 *   @is.oneOf(["free", "pro"]) plan: "free" | "pro" = "free";
 *   @is.boolean({ optional: true }) newsletter?: boolean;
 *   @is.object(Address, { optional: true }) address?: Address;
 *   @is.array(is.string({ transform: trim }), { optional: true, max: 5 }) tags?: string[];
 * }
 * ```
 */
export const is = {
  /**
   * A string, as is. No coercion from other types, and no trimming unless
   * you add `trim`.
   *
   * ```ts
   * @is.string({ transform: trim, validate: length(1, 60) }) name!: string;
   * ```
   */
  string: primitive<string>((v) => (typeof v === "string" ? v : INVALID), "a string"),

  /**
   * A safe integer, or a string of digits with an optional leading minus
   * (surrounding spaces allowed, like is.number).
   *
   * ```ts
   * @is.int({ validate: between(1, 99) }) qty!: number;
   * ```
   */
  int: primitive<number>((v) => {
    const n = typeof v === "string" ? parseInteger(v) : v;
    return typeof n === "number" && Number.isSafeInteger(n) ? n : INVALID;
  }, "an integer"),

  /**
   * A finite number, or a decimal string (exponents allowed).
   *
   * ```ts
   * @is.number({ validate: (n: number) => n > 0 || "Must be positive" }) price!: number;
   * ```
   */
  number: primitive<number>((v) => {
    const n = typeof v === "string" ? parseNumber(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : INVALID;
  }, "a number"),

  /**
   * A boolean, or "true" / "1" / "on" / "" and "false" / "0" / "off", the
   * same words as toBool. An unchecked checkbox sends nothing, so give the
   * field a default or `optional`.
   *
   * ```ts
   * @is.boolean() agree = false; // <input type="checkbox" name="agree"> sends "on" when ticked
   * ```
   */
  boolean: primitive<boolean>((v) => {
    const b = typeof v === "string" ? parseBool(v) : v;
    return typeof b === "boolean" ? b : INVALID;
  }, "a boolean"),

  /**
   * One of these exact strings; the field type is their union.
   *
   * ```ts
   * @is.oneOf(["low", "high"], { optional: true }) priority?: "low" | "high";
   * ```
   */
  oneOf<const V extends string, const O extends IsOptions<V, O> = {}>(values: readonly V[], options?: O): Checked<O, V> {
    const allowed = new Set<string>(values);
    const pipeline = pipelineOf(options);
    return makeDecorator({
      optional: options?.optional ?? false,
      parse(value, path, issues) {
        if (typeof value !== "string" || !allowed.has(value)) return issue(issues, path, `Expected one of ${values.join(", ")}`);
        return finish(value, path, issues, pipeline);
      },
    }) as unknown as Checked<O, V>;
  },

  /**
   * A nested DTO, validated recursively; its issues get paths like
   * `shipping.city`.
   *
   * ```ts
   * @is.object(Address) shipping!: Address;
   * ```
   */
  object<T, const O extends IsOptions<T, O> = {}>(dto: DtoClass<T>, options?: O): Checked<O, T> {
    dtoFields(dto);
    const pipeline = pipelineOf(options);
    return makeDecorator({
      optional: options?.optional ?? false,
      parse(value, path, issues) {
        const parsed = parseDto(dto, value, path, issues);
        return parsed === INVALID ? INVALID : finish(parsed, path, issues, pipeline);
      },
    }) as unknown as Checked<O, T>;
  },

  /**
   * An array whose items match another `is.*` spec. A lone value (a form field
   * sent once) counts as a one-item array. `min` and `max` bound the count.
   *
   * ```ts
   * @is.array(is.int(), { min: 1, max: 10 }) seats!: number[];
   * ```
   */
  array<T, const O extends IsOptions<T[], O> & { min?: number; max?: number } = {}>(
    item: IsDecorator<T>,
    options?: O,
  ): Checked<O, T[]> {
    const pipeline = pipelineOf(options);
    return makeDecorator({
      optional: options?.optional ?? false,
      parse(value, path, issues) {
        const list = Array.isArray(value) ? value : [value];
        if (options?.min !== undefined && list.length < options.min) return issue(issues, path, `Expected at least ${options.min} items`);
        if (options?.max !== undefined && list.length > options.max) return issue(issues, path, `Expected at most ${options.max} items`);
        const before = issues.length;
        const out = list.map((v, i) => item.spec.parse(v, child(path, i), issues));
        if (issues.length > before) return INVALID;
        return finish(out, path, issues, pipeline);
      },
    }) as unknown as Checked<O, T[]>;
  },

  /**
   * An uploaded file from a multipart form (see ActionForm.parse and @body).
   * `types` takes mime types with `image/*` style wildcards; `maxSize` is in
   * bytes. A field sent with several files is rejected; use is.files().
   *
   * ```ts
   * class Profile {
   *   @is.string() name!: string;
   *   @is.file({ types: ["image/*"], maxSize: 2_000_000, optional: true }) avatar?: File;
   * }
   * ```
   */
  file<const O extends IsOptions<File, O> & FileRules = {}>(options?: O): Checked<O, File> {
    const pipeline = pipelineOf(options);
    return makeDecorator({
      optional: options?.optional ?? false,
      parse(value, path, issues) {
        if (!(value instanceof File)) return issue(issues, path, Array.isArray(value) ? "Expected one file" : "Expected a file");
        const problem = fileProblem(value, options);
        if (problem) return issue(issues, path, problem.message);
        return finish(value, path, issues, pipeline);
      },
    }) as unknown as Checked<O, File>;
  },

  /**
   * Several uploaded files under one name (one file counts as a list of
   * one). Takes `types` and `maxSize` like is.file(), plus `min` and `max`.
   *
   * ```ts
   * @is.files({ types: ["image/*"], max: 5, optional: true }) photos?: File[];
   * ```
   */
  files<const O extends IsOptions<File[], O> & FileRules & { min?: number; max?: number } = {}>(options?: O): Checked<O, File[]> {
    const pipeline = pipelineOf(options);
    return makeDecorator({
      optional: options?.optional ?? false,
      parse(value, path, issues) {
        const list = Array.isArray(value) ? value : [value];
        if (!list.every((f) => f instanceof File)) return issue(issues, path, "Expected files");
        if (options?.min !== undefined && list.length < options.min) return issue(issues, path, `Expected at least ${options.min} files`);
        if (options?.max !== undefined && list.length > options.max) return issue(issues, path, `Expected at most ${options.max} files`);
        const before = issues.length;
        list.forEach((f, i) => {
          const problem = fileProblem(f as File, options);
          if (problem) issue(issues, child(path, i), problem.message);
        });
        if (issues.length > before) return INVALID;
        return finish(list, path, issues, pipeline);
      },
    }) as unknown as Checked<O, File[]>;
  },

  /**
   * A UUID string, lowercased. `version` limits it to one version (4, 7...).
   *
   * ```ts
   * @is.uuid({ version: 4 }) id!: string;
   * ```
   */
  uuid<const O extends IsOptions<string, O> & { version?: number } = {}>(options?: O): Checked<O, string> {
    const check = uuid(options?.version);
    return primitive<string>((v) => {
      if (typeof v !== "string") return INVALID;
      const id = v.trim().toLowerCase();
      return check(id) === true ? id : INVALID;
    }, options?.version !== undefined ? `a version ${options.version} UUID` : "a UUID")(options as never) as unknown as Checked<O, string>;
  },

  /**
   * An email address, trimmed (see the `email` validator for how loose the
   * check is). Not lowercased; add `transform: lower` if you compare them.
   *
   * ```ts
   * @is.email({ transform: lower }) email!: string;
   * ```
   */
  email<const O extends IsOptions<string, O> = {}>(options?: O): Checked<O, string> {
    const check = email();
    return primitive<string>((v) => {
      if (typeof v !== "string") return INVALID;
      const address = v.trim();
      return check(address) === true ? address : INVALID;
    }, "an email address")(options as never) as unknown as Checked<O, string>;
  },

  /**
   * An absolute URL, normalized (`new URL(v).href`). Only http and https
   * unless `protocols` says otherwise, so a `javascript:` link can't sneak in.
   *
   * ```ts
   * @is.url({ optional: true }) website?: string;
   * @is.url({ protocols: ["https", "mailto"] }) contact!: string;
   * ```
   */
  url<const O extends IsOptions<string, O> & { protocols?: readonly string[] } = {}>(options?: O): Checked<O, string> {
    const protocols = (options?.protocols ?? ["http", "https"]).map((p) => p.replace(/:$/, "").toLowerCase() + ":");
    return primitive<string>((v) => {
      const parsed = typeof v === "string" ? URL.parse(v.trim()) : null;
      return parsed && protocols.includes(parsed.protocol) ? parsed.href : INVALID;
    }, `a ${protocols.map((p) => p.slice(0, -1)).join(" or ")} URL`)(options as never) as unknown as Checked<O, string>;
  },

  /**
   * A date: an ISO 8601 string (`2026-10-17`, `2026-10-17T09:30:00Z`) or a
   * Date, as a Date. A date-only string is midnight UTC. Impossible dates
   * (`2026-02-30`) are rejected rather than rolled over. Pairs with
   * `<input type="date">`, which sends the date-only form.
   *
   * ```ts
   * @is.date() due!: Date;
   * ```
   */
  date<const O extends IsOptions<Date, O> = {}>(options?: O): Checked<O, Date> {
    return primitive<Date>((v) => {
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? INVALID : v;
      if (typeof v !== "string") return INVALID;
      const match = ISO_DATE.exec(v.trim());
      if (!match) return INVALID;
      const date = new Date(match[4] ? v.trim() : `${match[0]}T00:00:00Z`);
      if (Number.isNaN(date.getTime())) return INVALID;
      // new Date() rolls 2026-02-30 over to March; the calendar date must survive.
      const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
      const check = match[4] && !/Z|[+-]\d{2}:?\d{2}$/i.test(v.trim()) ? [date.getFullYear(), date.getMonth() + 1, date.getDate()] : null;
      if (check ? check[0] !== year || check[1] !== month || check[2] !== day : !sameUtcDay(year, month, day)) return INVALID;
      return date;
    }, "an ISO 8601 date")(options as never) as unknown as Checked<O, Date>;
  },

  /**
   * Anything a function can turn `unknown` into. Throw (an HttpError or any
   * Error) to reject; the error's message becomes the issue. The field type
   * is the function's return type.
   *
   * ```ts
   * @is.custom((v) => {
   *   if (typeof v !== "string" || !/^[A-Z]{3}$/.test(v)) throw new Error("Expected a currency code");
   *   return v;
   * })
   * currency!: string;
   * ```
   */
  custom<T, const O extends IsOptions<T, O> = {}>(parse: (value: unknown) => T, options?: O): Checked<O, T> {
    const pipeline = pipelineOf(options);
    return makeDecorator({
      optional: options?.optional ?? false,
      parse(value, path, issues) {
        let parsed: T;
        try {
          parsed = parse(value);
        } catch (error) {
          return issue(issues, path, messageOf(error));
        }
        return finish(parsed, path, issues, pipeline);
      },
    }) as unknown as Checked<O, T>;
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A DTO class's is.* fields. A class without any can't validate anything, so
 * it's a TypeError, raised where the class is handed over (`@body(Dto)`,
 * is.object(Dto), dto(Dto)) rather than on the first request.
 */
function dtoFields(dto: DtoClass<unknown>): readonly DtoField[] {
  const fields = DTO_FIELDS.from(metadataOf(dto));
  if (!fields || fields.length === 0) {
    throw new TypeError(`${dto.name} has no is.* field decorators, so it can't validate anything`);
  }
  return fields;
}

function parseDto<T>(dto: DtoClass<T>, raw: unknown, path: Path, issues: Issue[]): T | typeof INVALID {
  const fields = dtoFields(dto);
  if (!isPlainObject(raw)) return issue(issues, path, "Expected an object");
  // `new` runs field initializers, which double as defaults. Only declared
  // fields are copied over; unknown keys in the input are dropped.
  const instance = new dto() as Record<string, unknown>;
  const before = issues.length;
  for (const { key, spec } of fields) {
    const at = child(path, key);
    const value = Object.hasOwn(raw, key) ? raw[key] : undefined;
    if (value === undefined) {
      if (instance[key] === undefined) {
        if (!spec.optional) issue(issues, at, "Required");
        // `title?: string` still becomes an own `title: undefined` on the
        // instance (class fields are defined, not just declared). Remove it,
        // so the DTO holds exactly what was sent: spreading or Object.assign-ing
        // a partial update (a PATCH) then can't wipe fields the client left out.
        else delete instance[key];
      }
      continue;
    }
    const parsed = spec.parse(value, at, issues);
    if (parsed !== INVALID) instance[key] = parsed;
  }
  return issues.length > before ? INVALID : (instance as T);
}

/**
 * Validate `raw` against a DTO class. Returns an instance, or throws a 400
 * HttpError whose `details.issues` lists every issue. Inside a request
 * `@body(Dto)` and `form.parse(Dto)` do this for you; use parse() for
 * anything else: queue messages, config files, webhook payloads.
 *
 * ```ts
 * class EmailJob {
 *   @is.email() to!: string;
 *   @is.string() template!: string;
 * }
 *
 * const job = parse(EmailJob, JSON.parse(message)); // throws a 400 HttpError listing every issue
 * ```
 */
export function parse<T>(dto: DtoClass<T>, raw: unknown): T {
  const issues: Issue[] = [];
  const result = parseDto(dto, raw, "", issues);
  if (result === INVALID) throw new HttpError(400, "Validation failed", { details: { issues } });
  return result;
}

/**
 * A transform that validates into a DTO, for use in any `transform` option:
 * a JSON query parameter, or a body that may be absent (`@body(Dto)` alone
 * makes it required).
 *
 * ```ts
 * @route("/issues")
 * export class Issues {
 *   @query("filter", { transform: [JSON.parse, dto(Filter)] }) accessor filter: Filter | undefined;
 *   @body({ transform: dto(Signup) }) accessor signup!: Promise<Signup | undefined>;
 * }
 * ```
 */
export function dto<T>(cls: DtoClass<T>): Transform<unknown, T> {
  dtoFields(cls);
  return (raw) => parse(cls, raw);
}
