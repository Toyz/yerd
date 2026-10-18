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
import { createKey } from "./keys.js";
import type { FieldOutput, IsValidPipe, Pipe, PipeError, Transform, Validator } from "./request.js";
import { email, uuid } from "./request.js";

/** One problem found while validating, with a path like `address.city` or `tags[2]`. */
export interface Issue {
  /** Where the problem is: a field path, or "(root)" for the value itself. */
  path: string;
  /** What's wrong, e.g. "Required" or "Expected an integer". */
  message: string;
}

const INVALID: unique symbol = Symbol("yerd.invalid");

/** How to check and convert one value. Every `is.*` decorator carries one. */
export interface Spec<T> {
  /** Whether a missing value is allowed. */
  readonly optional: boolean;
  /** Check and convert `value`; on failure, push to `issues` and return the INVALID marker. */
  parse(value: unknown, path: string, issues: Issue[]): T | typeof INVALID;
}

interface DtoField {
  key: string;
  spec: Spec<unknown>;
}

export const DTO_FIELDS = createKey<DtoField[]>("dto:fields");

/**
 * A DTO class: constructible with no arguments, its fields decorated with
 * `is.*`. Field initializers act as defaults for missing values.
 */
export type DtoClass<T> = new () => T;

/**
 * The decorator an `is.*` factory returns. If the field's declared type can't
 * hold the validated value, the return type is something TypeScript rejects at
 * the `@`.
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
  /** Missing (or `undefined`) is allowed and leaves the field undefined, or its initializer. */
  optional?: boolean;
  /**
   * Transform(s) run after the type check, left to right; each takes the
   * previous one's output, so the last decides the field's type:
   * `[trim, lower]`, or `[trim, toUuid]` for a branded `Uuid`. Throw to reject.
   */
  transform?: Pipe;
  /**
   * Validator(s) run last, on the transformed value. `false` or a string
   * rejects it. Inline functions need their parameter annotated.
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

function fileProblem(file: File, rules: FileRules | undefined): string | undefined {
  if (rules?.maxSize !== undefined && file.size > rules.maxSize) return `File is larger than ${rules.maxSize} bytes`;
  const types = rules?.types;
  if (types && !types.some((t) => (t.endsWith("/*") ? file.type.startsWith(t.slice(0, -1)) : file.type === t))) {
    return `File type ${file.type || "(unknown)"} isn't accepted (${types.join(", ")})`;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type AnyIsOptions = { optional?: boolean; transform?: Pipe; validate?: Validator<any> | readonly Validator<any>[] };

function finish(input: unknown, path: string, issues: Issue[], options: AnyIsOptions | undefined): unknown {
  let value = input;
  try {
    const transforms = options?.transform;
    if (transforms) for (const step of typeof transforms === "function" ? [transforms] : transforms) value = step(value);
    const validators = options?.validate;
    if (validators) {
      for (const check of typeof validators === "function" ? [validators] : validators) {
        const verdict = check(value);
        if (verdict === false) return issue(issues, path, "Invalid value");
        if (typeof verdict === "string") return issue(issues, path, verdict);
      }
    }
    return value;
  } catch (error) {
    return issue(issues, path, messageOf(error));
  }
}

function issue(issues: Issue[], path: string, message: string): typeof INVALID {
  issues.push({ path: path || "(root)", message });
  return INVALID;
}

function makeDecorator<T>(spec: Spec<T>): IsDecorator<T> {
  const decorator = function (_value: undefined, context: ClassFieldDecoratorContext): void {
    if (context.static || context.private) {
      throw new TypeError(`DTO decorators must be on public instance fields (got ${String(context.name)})`);
    }
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
  return <const O extends IsOptions<B, O> = {}>(options?: O): Checked<O, B> =>
    makeDecorator({
      optional: options?.optional ?? false,
      parse(value, path, issues) {
        const base = check(value);
        if (base === INVALID) return issue(issues, path, `Expected ${expected}`);
        return finish(base, path, issues, options);
      },
    }) as unknown as Checked<O, B>;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

/** Whether year-month-day is a real calendar date. */
function sameUtcDay(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

const INTEGER = /^-?\d+$/;
const NUMBER = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/**
 * Field decorators for DTO classes. Numbers and booleans also accept their
 * string forms (`"42"`, `"true"`, `"on"`), so the same DTO works for JSON and
 * URL-encoded form bodies.
 */
export const is = {
  /** A string, as is. No coercion from other types. */
  string: primitive<string>((v) => (typeof v === "string" ? v : INVALID), "a string"),

  /** A safe integer, or a string of digits with an optional leading minus. */
  int: primitive<number>((v) => {
    if (typeof v === "number") return Number.isSafeInteger(v) ? v : INVALID;
    if (typeof v === "string" && INTEGER.test(v)) {
      const n = Number(v);
      return Number.isSafeInteger(n) ? n : INVALID;
    }
    return INVALID;
  }, "an integer"),

  /** A finite number, or a decimal string (exponents allowed). */
  number: primitive<number>((v) => {
    if (typeof v === "number") return Number.isFinite(v) ? v : INVALID;
    if (typeof v === "string" && NUMBER.test(v.trim())) return Number(v);
    return INVALID;
  }, "a number"),

  /**
   * A boolean, or "true" / "1" / "on" and "false" / "0" / "off". An unchecked
   * checkbox sends nothing, so give the field a default or `optional`.
   */
  boolean: primitive<boolean>((v) => {
    if (typeof v === "boolean") return v;
    if (v === "true" || v === "1" || v === "on") return true;
    if (v === "false" || v === "0" || v === "off") return false;
    return INVALID;
  }, "a boolean"),

  /** One of these exact strings; the field type is their union. */
  oneOf<const V extends string, const O extends IsOptions<V, O> = {}>(values: readonly V[], options?: O): Checked<O, V> {
    const allowed = new Set<string>(values);
    return makeDecorator({
      optional: options?.optional ?? false,
      parse(value, path, issues) {
        if (typeof value !== "string" || !allowed.has(value)) return issue(issues, path, `Expected one of ${values.join(", ")}`);
        return finish(value, path, issues, options);
      },
    }) as unknown as Checked<O, V>;
  },

  /** A nested DTO. */
  object<T, const O extends IsOptions<T, O> = {}>(dto: DtoClass<T>, options?: O): Checked<O, T> {
    return makeDecorator({
      optional: options?.optional ?? false,
      parse(value, path, issues) {
        const parsed = parseDto(dto, value, path, issues);
        return parsed === INVALID ? INVALID : finish(parsed, path, issues, options);
      },
    }) as unknown as Checked<O, T>;
  },

  /**
   * An array whose items match another `is.*` spec. A lone value (a form field
   * sent once) counts as a one-item array.
   */
  array<T, const O extends IsOptions<T[], O> & { min?: number; max?: number } = {}>(
    item: IsDecorator<T>,
    options?: O,
  ): Checked<O, T[]> {
    return makeDecorator({
      optional: options?.optional ?? false,
      parse(value, path, issues) {
        const list = Array.isArray(value) ? value : [value];
        if (options?.min !== undefined && list.length < options.min) return issue(issues, path, `Expected at least ${options.min} items`);
        if (options?.max !== undefined && list.length > options.max) return issue(issues, path, `Expected at most ${options.max} items`);
        const before = issues.length;
        const out = list.map((v, i) => item.spec.parse(v, `${path}[${i}]`, issues));
        if (issues.length > before) return INVALID;
        return finish(out, path, issues, options);
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
    return makeDecorator({
      optional: options?.optional ?? false,
      parse(value, path, issues) {
        if (!(value instanceof File)) return issue(issues, path, Array.isArray(value) ? "Expected one file" : "Expected a file");
        const problem = fileProblem(value, options);
        if (problem) return issue(issues, path, problem);
        return finish(value, path, issues, options);
      },
    }) as unknown as Checked<O, File>;
  },

  /** Several uploaded files under one name (one file counts as a list of one). */
  files<const O extends IsOptions<File[], O> & FileRules & { min?: number; max?: number } = {}>(options?: O): Checked<O, File[]> {
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
          if (problem) issue(issues, `${path}[${i}]`, problem);
        });
        if (issues.length > before) return INVALID;
        return finish(list, path, issues, options);
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

  /** An email address, trimmed (see the `email` validator for how loose the check is). */
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
   */
  url<const O extends IsOptions<string, O> & { protocols?: readonly string[] } = {}>(options?: O): Checked<O, string> {
    const protocols = (options?.protocols ?? ["http", "https"]).map((p) => p.replace(/:$/, "").toLowerCase() + ":");
    return primitive<string>((v) => {
      if (typeof v !== "string" || !URL.canParse(v.trim())) return INVALID;
      const parsed = new URL(v.trim());
      return protocols.includes(parsed.protocol) ? parsed.href : INVALID;
    }, `a ${protocols.map((p) => p.slice(0, -1)).join(" or ")} URL`)(options as never) as unknown as Checked<O, string>;
  },

  /**
   * A date: an ISO 8601 string (`2026-10-17`, `2026-10-17T09:30:00Z`) or a
   * Date, as a Date. A date-only string is midnight UTC. Impossible dates
   * (`2026-02-30`) are rejected rather than rolled over.
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

  /** Anything a function can turn `unknown` into. Throw (an HttpError or any Error) to reject. */
  custom<T, const O extends IsOptions<T, O> = {}>(parse: (value: unknown) => T, options?: O): Checked<O, T> {
    return makeDecorator({
      optional: options?.optional ?? false,
      parse(value, path, issues) {
        let parsed: T;
        try {
          parsed = parse(value);
        } catch (error) {
          return issue(issues, path, messageOf(error));
        }
        return finish(parsed, path, issues, options);
      },
    }) as unknown as Checked<O, T>;
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function parseDto<T>(dto: DtoClass<T>, raw: unknown, path: string, issues: Issue[]): T | typeof INVALID {
  if (!isPlainObject(raw)) return issue(issues, path, "Expected an object");
  const fields = DTO_FIELDS.from((dto as unknown as Record<symbol, DecoratorMetadataObject>)[Symbol.metadata!] ?? {});
  if (!fields || fields.length === 0) {
    throw new TypeError(`${dto.name} has no is.* field decorators, so it can't validate anything`);
  }
  // `new` runs field initializers, which double as defaults. Only declared
  // fields are copied over; unknown keys in the input are dropped.
  const instance = new dto() as Record<string, unknown>;
  const before = issues.length;
  for (const { key, spec } of fields) {
    const at = path ? `${path}.${key}` : key;
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
 * HttpError whose `details` lists every issue.
 */
export function parse<T>(dto: DtoClass<T>, raw: unknown): T {
  const issues: Issue[] = [];
  const result = parseDto(dto, raw, "", issues);
  if (result === INVALID) throw new HttpError(400, "Validation failed", { details: { issues } });
  return result;
}

/** A transform that validates into a DTO, for use in any `transform` option. */
export function dto<T>(cls: DtoClass<T>): Transform<unknown, T> {
  return (raw) => parse(cls, raw);
}
