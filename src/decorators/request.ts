import { HttpError } from "../respond/response.js";
import { createAccessor, type AccessorDecorator, type Resolves } from "./kit.js";
import type { YerdContext } from "../server/context.js";
import { formFields, withFiles, type FormFields } from "../server/body.js";
import { dto, parse, type DtoClass } from "./dto.js";
import { shapeSession, type Session, type SessionApi, type SessionShape } from "../session/session.js";

/** Turns one value into another. Throw an HttpError to reject the request. */
export type Transform<I = string, O = unknown> = (value: I) => O;

/** A single transform, or a pipeline run left to right. */
// The tuple member matters: it makes TypeScript infer array literals as tuples,
// so each step can be checked against the one before it.
export type Pipe = Transform<any, any> | readonly [] | readonly [Transform<any, any>, ...Transform<any, any>[]];

/** The value a pipe produces from a `Raw` input (a string, unless noted). An empty pipe leaves it `Raw`. */
export type PipeOutput<T, Raw = string> = T extends readonly []
  ? Raw
  : T extends readonly [...unknown[], (value: never) => infer O]
    ? O
    : T extends (value: never) => infer O
      ? O
      : Raw;

type ValidPipe<T, In> = T extends readonly []
  ? true
  : T extends readonly [(value: In) => infer O, ...infer Rest]
    ? ValidPipe<Rest, O>
    : false;

/** True when every transform accepts the previous one's output, starting from `Raw`. */
export type IsValidPipe<T, Raw = string> = T extends readonly unknown[]
  ? ValidPipe<T, Raw>
  : T extends (value: Raw) => unknown
    ? true
    : false;

/** What a decorator factory returns for a pipe whose steps don't line up. Not callable, so `@` fails. */
export interface PipeError {
  /** The key and value are the error message TypeScript shows. */
  "transform pipeline error": "each transform must accept the previous one's output";
}


/**
 * Checks a value without changing it. Return `true` (or nothing) to accept,
 * `false` to reject with a generic 400, or a string to reject with that message.
 * Throwing an HttpError also works.
 */
export type Validator<T> = (value: T) => boolean | string | void;

/** The value an options object produces: its pipeline's output, or the raw value. */
export type FieldOutput<O, Raw = string> = O extends { transform: infer T } ? PipeOutput<T, Raw> : Raw;

/**
 * Options for @param. `O` is the options object itself (inferred whole, which
 * is what keeps inference working for pipelines like `[trim, oneOf("a", "b")]`),
 * so validators are typed by the pipeline's output.
 */
export interface FieldOptions<O = unknown> {
  /** Transform or pipeline applied to the raw string. Skipped when the value is missing. */
  transform?: Pipe;
  /**
   * Validator(s) run on the transformed value, in order. Inline functions need
   * their parameter annotated: `validate: (n: number) => n > 0`.
   */
  validate?: Validator<FieldOutput<O>> | readonly Validator<FieldOutput<O>>[];
}

/** Options for @query and @header. */
export interface OptionalFieldOptions<O = unknown> extends FieldOptions<O> {
  /** Missing value means 400 instead of the field's initializer. */
  required?: boolean;
}

/**
 * The decorator a field factory returns. Checks run when it's applied: a
 * pipeline whose steps don't line up, or a field whose type can't hold the
 * value, make the return type something TypeScript rejects at the `@`.
 */
export type FieldDecorator<O, Out, Raw = string> = (<This, V>(
  target: ClassAccessorDecoratorTarget<This, V>,
  context: ClassAccessorDecoratorContext<This, V>,
) => (O extends { transform: infer T } ? IsValidPipe<T, Raw> : true) extends true
  ? [NonNullable<Out>] extends [V]
    ? ClassAccessorDecoratorResult<This, V>
    : { "accessor type does not accept the decorator's value": Out }
  : PipeError) &
  Resolves<Out>;

type Optional<O, V> = O extends { required: true } ? V : V | undefined;

type AnyOptions = {
  transform?: Pipe;
  validate?: Validator<any> | readonly Validator<any>[];
  required?: boolean;
};

function resolveField(kind: string, name: string, raw: unknown, options: AnyOptions | undefined): unknown {
  let value: unknown = raw;
  const pipe = options?.transform;
  if (pipe) for (const step of typeof pipe === "function" ? [pipe] : pipe) value = step(value);

  const validate = options?.validate;
  if (validate) {
    for (const check of typeof validate === "function" ? [validate] : validate) {
      const verdict = check(value);
      if (verdict === false) throw new HttpError(400, `Invalid ${kind}: ${name}`);
      if (typeof verdict === "string") throw new HttpError(400, verdict);
    }
  }
  return value;
}

function missing(kind: string, name: string, options: AnyOptions | undefined): undefined {
  if (options?.required) throw new HttpError(400, `Missing required ${kind}: ${name}`);
  return undefined;
}

const paramAccessor = createAccessor<unknown, [name: string, options?: AnyOptions]>(
  (ctx, name, options) => {
    const raw = ctx.params[name];
    return raw === undefined ? undefined : resolveField("path parameter", name, raw, options);
  },
  {
    name: "param",
    validate: (route, name) =>
      route.paramNames.includes(name) ? undefined : `:${name} is not a parameter of ${route.pattern}`,
  },
);

/**
 * A path parameter. Boot fails if the route pattern doesn't declare it.
 *
 * ```ts
 * @param("id") accessor id!: string;
 * @param("id", { transform: toInt, validate: between(1, 1000) }) accessor id!: number;
 * ```
 */
export function param<const O extends FieldOptions<O> = {}>(
  name: string,
  options?: O,
): FieldDecorator<O, FieldOutput<O>> {
  return paramAccessor(name, options as AnyOptions | undefined) as unknown as FieldDecorator<O, FieldOutput<O>>;
}

/** All path parameters. */
export const params = createAccessor((ctx): Record<string, string> => ({ ...ctx.params }), { name: "params" });

const queryAccessor = createAccessor<unknown, [name: string, options?: AnyOptions]>(
  (ctx, name, options) => {
    const raw = ctx.query.get(name);
    return raw === null ? missing("query parameter", name, options) : resolveField("query parameter", name, raw, options);
  },
  { name: "query" },
);

/**
 * First value of a query string parameter. Missing means the field's
 * initializer, or a 400 with `required: true`.
 *
 * ```ts
 * @query("tab") accessor tab = "posts";
 * @query("page", { transform: toInt, validate: between(1, 500) }) accessor page = 1;
 * @query("sort", { transform: [trim, lower, oneOf("asc", "desc")] }) accessor sort = "asc";
 * ```
 */
export function query<const O extends OptionalFieldOptions<O> = {}>(
  name: string,
  options?: O,
): FieldDecorator<O, Optional<O, FieldOutput<O>>> {
  return queryAccessor(name, options as AnyOptions | undefined) as unknown as FieldDecorator<O, Optional<O, FieldOutput<O>>>;
}

const headerAccessor = createAccessor<unknown, [name: string, options?: AnyOptions]>(
  (ctx, name, options) => {
    const value = ctx.headers[name.toLowerCase()];
    const raw = Array.isArray(value) ? value.join(", ") : value;
    return raw === undefined ? missing("header", name, options) : resolveField("header", name, raw, options);
  },
  { name: "header" },
);

/** A request header. Repeated headers are joined with ", ". Same options as @query. */
export function header<const O extends OptionalFieldOptions<O> = {}>(
  name: string,
  options?: O,
): FieldDecorator<O, Optional<O, FieldOutput<O>>> {
  return headerAccessor(name, options as AnyOptions | undefined) as unknown as FieldDecorator<O, Optional<O, FieldOutput<O>>>;
}

/** Options for @body. The pipeline starts from the parsed body (`unknown`). */
export interface BodyOptions<O = unknown> {
  /** Transform or pipeline applied to the parsed body, e.g. a schema parser. */
  transform?: Pipe;
  /** Validator(s) run on the transformed body. Inline functions annotate their parameter. */
  validate?: Validator<FieldOutput<O, unknown>> | readonly Validator<FieldOutput<O, unknown>>[];
  /** No body means 400 instead of `undefined`. */
  required?: boolean;
}

const bodyAccessor = createAccessor<Promise<unknown>, [options?: AnyOptions]>(
  async (ctx, options) => {
    const parsed = await ctx.body();
    if (parsed.kind === "none") return missing("request body", "body", options);
    // A multipart form's files sit next to its fields, for is.file() in DTOs.
    const value = parsed.kind === "form" ? withFiles(parsed.value, parsed.files) : parsed.value;
    return resolveField("request body", "body", value, options);
  },
  { name: "body" },
);

type BodyValue<A> = A extends DtoClass<infer T> ? T : Optional<A, FieldOutput<A, unknown>>;

/**
 * The request body, as a promise: reading a body is async, and nothing is read
 * unless something awaits the field. In `@args(...)` the promise is awaited for
 * you.
 *
 * Pass a DTO class to validate into it (required, 400 with every issue on
 * failure), or options for anything else. Raw bodies are JSON as parsed,
 * URL-encoded forms as an object of strings (repeated keys become arrays),
 * text/* as a string, anything else as a Uint8Array.
 *
 * ```ts
 * @body(Signup) accessor signup!: Promise<Signup>;
 * @args(body(Signup)) create(signup: Signup) { ... }
 * @body({ transform: parseCsv }) accessor rows!: Promise<Row[] | undefined>;
 * ```
 */
export function body<const A extends BodyOptions<A> | DtoClass<unknown> = {}>(
  schema?: A,
): FieldDecorator<A extends DtoClass<unknown> ? {} : A, Promise<BodyValue<A>>, unknown> {
  const options: AnyOptions | undefined =
    typeof schema === "function" ? { transform: dto(schema as DtoClass<unknown>), required: true } : (schema as AnyOptions | undefined);
  return bodyAccessor(options) as unknown as FieldDecorator<A extends DtoClass<unknown> ? {} : A, Promise<BodyValue<A>>, unknown>;
}

function fieldsOf(value: unknown, kind: string): FormFields | undefined {
  if (kind === "form") return value as FormFields;
  if (kind === "json" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const fields: FormFields = Object.create(null);
    for (const [key, v] of Object.entries(value)) {
      if (typeof v === "string") fields[key] = v;
      else if (typeof v === "number" || typeof v === "boolean") fields[key] = String(v);
      else if (Array.isArray(v) && v.every((x) => typeof x === "string")) fields[key] = v;
    }
    return fields;
  }
  if (kind === "text") return formFields(new URLSearchParams());
  return undefined;
}

const fieldAccessor = createAccessor<Promise<unknown>, [name: string, options?: AnyOptions]>(
  async (ctx, name, options) => {
    const parsed = await ctx.body();
    const fields = parsed.kind === "none" ? undefined : fieldsOf(parsed.value, parsed.kind);
    const value = fields?.[name];
    if (value === undefined) return missing("form field", name, options);
    // A repeated field takes its first value, like @query.
    return resolveField("form field", name, Array.isArray(value) ? value[0]! : value, options);
  },
  { name: "field" },
);

/**
 * One field of a URL-encoded form (or a top-level string, number or boolean
 * of a JSON object body), as a promise like @body. Same options as @query:
 * the pipeline starts from a string.
 *
 * ```ts
 * @field("email", { transform: [trim, lower], validate: matches(/@/), required: true }) accessor email!: Promise<string>;
 * ```
 */
export function field<const O extends OptionalFieldOptions<O> = {}>(
  name: string,
  options?: O,
): FieldDecorator<O, Promise<Optional<O, FieldOutput<O>>>> {
  return fieldAccessor(name, options as AnyOptions | undefined) as unknown as FieldDecorator<O, Promise<Optional<O, FieldOutput<O>>>>;
}

// ── uploads ──

/** Options for @file and @files. */
export interface FileOptions {
  /** A 400 when no file was uploaded under the name. */
  required?: boolean;
  /** Largest file accepted, in bytes (413 beyond). The request's `bodyLimit` still caps the whole body. */
  maxSize?: number;
  /** Accepted mime types; `image/*` style wildcards allowed (415 otherwise). */
  types?: string[];
}

function checkFile(name: string, file: File, options: FileOptions | undefined): File {
  if (options?.maxSize !== undefined && file.size > options.maxSize) {
    throw new HttpError(413, `${name}: ${file.name || "the file"} is larger than ${options.maxSize} bytes`);
  }
  const types = options?.types;
  if (types && !types.some((t) => (t.endsWith("/*") ? file.type.startsWith(t.slice(0, -1)) : file.type === t))) {
    throw new HttpError(415, `${name}: ${file.type || "this file type"} isn't accepted (${types.join(", ")})`);
  }
  return file;
}

async function uploads(ctx: YerdContext, name: string, options: FileOptions | undefined): Promise<File[]> {
  const parsed = await ctx.body();
  // An empty file input still posts a part: no name, no bytes. That's "no file".
  const found = parsed.kind === "form" ? (parsed.files[name] ?? []).filter((f) => f.size > 0 || f.name !== "") : [];
  if (found.length === 0 && options?.required) throw new HttpError(400, `Missing file: ${name}`);
  return found.map((f) => checkFile(name, f, options));
}

const filesAccessor = createAccessor<Promise<File[]>, [name: string, options?: FileOptions]>(uploads, { name: "files" });

/**
 * Files uploaded under `name` in a multipart form, as a promise like @body.
 * Raise the app's `bodyLimit` for anything beyond small files.
 *
 * ```ts
 * @files("photos", { types: ["image/*"], maxSize: 5_000_000 }) accessor photos!: Promise<File[]>;
 * ```
 */
export function files(name: string, options?: FileOptions): AccessorDecorator<Promise<File[]>> {
  return filesAccessor(name, options);
}

const fileAccessor = createAccessor<Promise<File | undefined>, [name: string, options?: FileOptions]>(
  async (ctx, name, options) => (await uploads(ctx, name, options))[0],
  { name: "file" },
);

/**
 * The first file uploaded under `name`. Typed `File` with `required: true`,
 * else `File | undefined`.
 *
 * ```ts
 * @file("avatar", { required: true, types: ["image/png", "image/jpeg"] }) accessor avatar!: Promise<File>;
 * ```
 */
export function file(name: string, options: FileOptions & { required: true }): AccessorDecorator<Promise<File>>;
export function file(name: string, options?: FileOptions): AccessorDecorator<Promise<File | undefined>>;
export function file(name: string, options?: FileOptions): AccessorDecorator<Promise<File | undefined>> {
  return fileAccessor(name, options);
}

type LineValue<A> = A extends DtoClass<infer T> ? T : A extends { transform: infer T } ? PipeOutput<T, unknown> : unknown;

async function* checkedLines(source: AsyncIterable<unknown>, schema: DtoClass<unknown> | { transform?: Pipe } | undefined) {
  let line = 0;
  for await (const value of source) {
    line++;
    if (typeof schema === "function") {
      try {
        yield parse(schema, value);
      } catch (error) {
        if (error instanceof HttpError && error.details) {
          throw new HttpError(400, `Line ${line} failed validation`, { details: { line, ...error.details } });
        }
        throw error;
      }
    } else if (schema?.transform) {
      let out: unknown = value;
      const pipe = schema.transform;
      for (const step of typeof pipe === "function" ? [pipe] : pipe) out = step(out);
      yield out;
    } else {
      yield value;
    }
  }
}

const ndjsonBodyAccessor = createAccessor<AsyncIterable<unknown>, [schema?: DtoClass<unknown> | { transform?: Pipe }]>(
  (ctx, schema) => checkedLines(ctx.lines(), schema),
  { name: "ndjsonBody" },
);

/**
 * A streamed NDJSON request body: an async iterable of values, parsed (and
 * validated, with a DTO class or transform) one line at a time as they arrive.
 * Only each line is size-limited, not the whole upload.
 *
 * ```ts
 * @post @args(ndjsonBody(Row)) async import(rows: AsyncIterable<Row>) {
 *   for await (const row of rows) await this.repo.insert(row);
 * }
 * ```
 */
export function ndjsonBody<const A extends DtoClass<unknown> | { transform?: Pipe } = {}>(
  schema?: A,
): FieldDecorator<{}, AsyncIterable<LineValue<A>>, unknown> {
  return ndjsonBodyAccessor(schema) as unknown as FieldDecorator<{}, AsyncIterable<LineValue<A>>, unknown>;
}

/**
 * `@session` / `@session(Shape)`: see `session`.
 */
export interface SessionDecorator extends Resolves<Session<any>> {
  <This, V extends SessionApi<any>>(target: ClassAccessorDecoratorTarget<This, V>, context: ClassAccessorDecoratorContext<This, V>): ClassAccessorDecoratorResult<This, V>;
  <T extends object>(shape: SessionShape<T>): AccessorDecorator<Session<T>>;
}

/**
 * The session (needs app.sessions()). The accessor's type picks the shape:
 * `Session<Cart>` makes `Cart`'s fields typed properties (and types
 * get/set); plain `Session` uses the app-wide `SessionData` interface.
 *
 * ```ts
 * interface Cart { items?: string[]; coupon?: string }
 *
 * @session accessor session!: Session<Cart>;
 * (this.session.items ??= []).push("socks"); // saved, even changed in place
 * this.session.itmes; // doesn't compile
 * ```
 *
 * Pass a class to give the session methods, getters and defaults: they run
 * with `this` as the session, and field initializers fill in missing values
 * (saved only once changed). No `#private` fields: `this` is a proxy.
 *
 * ```ts
 * class Cart {
 *   items: string[] = [];
 *   coupon?: string;
 *   get count() { return this.items.length; }
 *   add(item: string) { this.items.push(item); }
 * }
 *
 * @session(Cart) accessor cart!: Session<Cart>;
 * this.cart.add("socks"); // this.cart.count is 1, and it's saved
 * ```
 */
export const session = createAccessor(
  (ctx, shape?: SessionShape) => (shape ? shapeSession(ctx.session, shape) : ctx.session),
  { name: "session" },
) as unknown as SessionDecorator;

const cookieAccessor = createAccessor<unknown, [name: string, options?: AnyOptions]>(
  (ctx, name, options) => {
    const raw = ctx.cookies[name];
    return raw === undefined ? missing("cookie", name, options) : resolveField("cookie", name, raw, options);
  },
  { name: "cookie" },
);

/** A request cookie. Same options as @query. */
export function cookie<const O extends OptionalFieldOptions<O> = {}>(
  name: string,
  options?: O,
): FieldDecorator<O, Optional<O, FieldOutput<O>>> {
  return cookieAccessor(name, options as AnyOptions | undefined) as unknown as FieldDecorator<O, Optional<O, FieldOutput<O>>>;
}

/** Aborts when the client disconnects or the server shuts down. */
export const signal = createAccessor((ctx): AbortSignal => ctx.signal, { name: "signal" });

/** The raw Node request. */
export const request = createAccessor((ctx) => ctx.request, { name: "request" });

// Built-in transforms. Plain functions, so users write their own the same way.

const INTEGER = /^-?\d+$/;

/**
 * Parse a base-10 integer (optional leading minus, digits only). Anything
 * else, or a value beyond Number.MAX_SAFE_INTEGER, is a 400.
 *
 * ```ts
 * @param("id", { transform: toInt }) accessor id!: number;
 * ```
 */
export const toInt: Transform<string, number> = (raw) => {
  if (!INTEGER.test(raw)) throw new HttpError(400, `Expected an integer, got ${JSON.stringify(raw)}`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new HttpError(400, `Integer out of range: ${raw}`);
  return n;
};

/** Parse any number `Number()` accepts (decimals, exponents). Blank or NaN is a 400. */
export const toNumber: Transform<string, number> = (raw) => {
  // Decimal notation only: Number() would also take "Infinity", "0x10" and "1e999".
  const n = Number(raw);
  if (!/^\s*-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(raw) || !Number.isFinite(n)) {
    throw new HttpError(400, `Expected a number, got ${JSON.stringify(raw)}`);
  }
  return n;
};

/**
 * Parse "true", "1" or "" (a bare `?flag`) as true and "false" or "0" as
 * false; anything else is a 400. Case-sensitive.
 */
export const toBool: Transform<string, boolean> = (raw) => {
  if (raw === "true" || raw === "1" || raw === "") return true;
  if (raw === "false" || raw === "0") return false;
  throw new HttpError(400, `Expected a boolean, got ${JSON.stringify(raw)}`);
};

/**
 * Strip leading and trailing whitespace. Put it first in a pipeline:
 * `{ transform: [trim, lower, oneOf("asc", "desc")] }`.
 */
export const trim: Transform<string, string> = (raw) => raw.trim();

/** Lower-case the value. */
export const lower: Transform<string, string> = (raw) => raw.toLowerCase();

/** Only these exact values; the output type is their union. */
export function oneOf<const V extends string>(...values: V[]): Transform<string, V> {
  const allowed = new Set<string>(values);
  return (raw) => {
    if (!allowed.has(raw)) throw new HttpError(400, `Expected one of ${values.join(", ")}, got ${JSON.stringify(raw)}`);
    return raw as V;
  };
}

// Built-in validators.

/** Numbers within [min, max], inclusive. */
export function between(min: number, max: number): Validator<number> {
  return (n) => (n >= min && n <= max) || `Expected a number from ${min} to ${max}, got ${n}`;
}

/** String or array length within [min, max], inclusive. `max` defaults to unlimited. */
export function length(min: number, max = Infinity): Validator<string | readonly unknown[]> {
  return (value) =>
    (value.length >= min && value.length <= max) ||
    (max === Infinity
      ? `Expected a length of at least ${min}, got ${value.length}`
      : `Expected a length from ${min} to ${max}, got ${value.length}`);
}

/** String matching a regular expression. */
export function matches(pattern: RegExp, message?: string): Validator<string> {
  return (value) => {
    pattern.lastIndex = 0;
    return pattern.test(value) || (message ?? `Expected a value matching ${pattern}`);
  };
}
