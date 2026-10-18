import { HttpError } from "../respond/response.js";
import { createAccessor, type AccessorDecorator, type Resolves } from "./kit.js";
import type { YerdContext } from "../server/context.js";
import { formFields, withFiles, type FormFields } from "../server/body.js";
import { dto, parse, type DtoClass } from "./dto.js";
import { shapeSession, type Session, type SessionApi, type SessionShape } from "../session/session.js";

/**
 * Turns one value into another. Throw an HttpError to reject the request.
 * Transforms are plain functions, so writing your own is writing a function;
 * put it in any `transform` option, alone or in a pipeline.
 *
 * ```ts
 * export const slug: Transform<string, string> = (raw) => {
 *   if (!/^[a-z0-9-]+$/.test(raw)) throw new HttpError(400, `Not a slug: ${raw}`);
 *   return raw;
 * };
 *
 * @route("/posts/:slug")
 * export class PostBySlug {
 *   @param("slug", { transform: [trim, lower, slug] }) accessor slug!: string;
 * }
 * ```
 */
export type Transform<I = string, O = unknown> = (value: I) => O;

/**
 * A single transform, or a pipeline run left to right, each step taking the
 * previous one's output. The last step decides the field's type, and a step
 * that can't take what the one before it made is a compile error.
 *
 * ```ts
 * @query("sort", { transform: [trim, lower, oneOf("asc", "desc")] }) accessor sort: "asc" | "desc" = "asc";
 * // Doesn't compile: toInt makes a number, and trim only takes a string.
 * @query("n", { transform: [toInt, trim] }) accessor n = 0;
 * ```
 */
// The tuple member matters: it makes TypeScript infer array literals as tuples,
// so each step can be checked against the one before it.
export type Pipe = Transform<any, any> | readonly [] | readonly [Transform<any, any>, ...Transform<any, any>[]];

/**
 * The value a pipe produces from a `Raw` input (a string, unless noted). An
 * empty pipe leaves it `Raw`. Mostly for typing helpers that wrap the field
 * decorators; the decorators apply it for you.
 *
 * ```ts
 * const sortPipe = [trim, lower, oneOf("asc", "desc")] as const;
 * type Sort = PipeOutput<typeof sortPipe>; // "asc" | "desc"
 * ```
 */
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

/**
 * True when every transform accepts the previous one's output, starting from
 * `Raw`. The field decorators use it to reject a broken pipeline at the `@`;
 * reach for it when writing your own decorator factory that takes a pipe.
 *
 * ```ts
 * type Fits = IsValidPipe<[typeof trim, typeof toInt]>;   // true
 * type Breaks = IsValidPipe<[typeof toInt, typeof trim]>; // false: trim can't take a number
 * ```
 */
export type IsValidPipe<T, Raw = string> = T extends readonly unknown[]
  ? ValidPipe<T, Raw>
  : T extends (value: Raw) => unknown
    ? true
    : false;

/**
 * What a decorator factory returns for a pipe whose steps don't line up. Not
 * callable, so `@` fails, and the error names the problem. You never write
 * this type; you meet it in a compile error.
 *
 * ```ts
 * // error: ... "transform pipeline error": "each transform must accept the previous one's output"
 * @query("n", { transform: [toInt, trim] }) accessor n = 0;
 * ```
 */
export interface PipeError {
  /** The key and value are the error message TypeScript shows. */
  "transform pipeline error": "each transform must accept the previous one's output";
}


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

/**
 * The value an options object produces: its pipeline's output, or the raw
 * value. Type-level only, for typing helpers around the field decorators.
 *
 * ```ts
 * type Page = FieldOutput<{ transform: typeof toInt }>; // number
 * type Raw = FieldOutput<{}>;                           // string
 * ```
 */
export type FieldOutput<O, Raw = string> = O extends { transform: infer T } ? PipeOutput<T, Raw> : Raw;

/**
 * Options for @param, and the base of the options for @query, @header,
 * @cookie and @field. `O` is the options object itself (inferred whole, which
 * is what keeps inference working for pipelines like `[trim, oneOf("a", "b")]`),
 * so validators are typed by the pipeline's output.
 *
 * ```ts
 * @param("id", { transform: toInt, validate: (n: number) => n > 0 || "ids start at 1" }) accessor id!: number;
 * ```
 */
export interface FieldOptions<O = unknown> {
  /**
   * Transform or pipeline applied to the raw string. Skipped when the value is missing.
   *
   * ```ts
   * @param("id", { transform: [trim, toInt] }) accessor id!: number;
   * ```
   */
  transform?: Pipe;
  /**
   * Validator(s) run on the transformed value, in order. Inline functions need
   * their parameter annotated: `validate: (n: number) => n > 0`.
   *
   * ```ts
   * @param("code", { validate: [length(1, 12), matches(/^\d+$/)] }) accessor code!: string;
   * ```
   */
  validate?: Validator<FieldOutput<O>> | readonly Validator<FieldOutput<O>>[];
}

/**
 * Options for @query, @header, @cookie and @field: FieldOptions plus
 * `required`. Without it, a missing value leaves the field's initializer (or
 * undefined).
 *
 * ```ts
 * @query("q", { transform: trim, required: true }) accessor q!: string; // 400 without ?q=
 * @query("page", { transform: toInt }) accessor page = 1;               // 1 without ?page=
 * ```
 */
export interface OptionalFieldOptions<O = unknown> extends FieldOptions<O> {
  /**
   * Missing value means 400 instead of the field's initializer. Also drops
   * `undefined` from the value's type.
   *
   * ```ts
   * @header("x-api-key", { required: true }) accessor apiKey!: string;
   * ```
   */
  required?: boolean;
}

/**
 * The decorator a field factory returns. Checks run when it's applied: a
 * pipeline whose steps don't line up, or a field whose type can't hold the
 * value, make the return type something TypeScript rejects at the `@`. You
 * meet it when wrapping a factory in your own (the inferred return type keeps
 * every check) or in a compile error.
 *
 * ```ts
 * export function pageQuery() {
 *   return query("page", { transform: toInt, validate: between(1, 500) });
 * }
 *
 * @pageQuery() accessor page = 1;
 * // Doesn't compile: the pipeline makes a number, which a string field can't hold.
 * @query("n", { transform: toInt }) accessor n = "x";
 * ```
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

/**
 * All path parameters, as a fresh object of strings (URL-decoded, no
 * transforms). Handy for splat routes and generic handlers; for one param,
 * `@param` checks the name at boot and can transform it.
 *
 * ```ts
 * @route("/files/*path")
 * export class Files {
 *   @params accessor all!: Record<string, string>;
 *
 *   @get show() {
 *     return this.all; // /files/a/b.txt -> { path: "a/b.txt" }
 *   }
 * }
 * ```
 */
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

/**
 * A request header, by case-insensitive name. Repeated headers are joined
 * with ", ". Same options as @query: missing means the field's initializer
 * (or undefined), or a 400 with `required: true`.
 *
 * ```ts
 * @route("/api/reports")
 * export class Reports {
 *   @header("accept-language") accessor lang: string | undefined;
 *   @header("x-api-key", { required: true }) accessor apiKey!: string;
 * }
 * ```
 */
export function header<const O extends OptionalFieldOptions<O> = {}>(
  name: string,
  options?: O,
): FieldDecorator<O, Optional<O, FieldOutput<O>>> {
  return headerAccessor(name, options as AnyOptions | undefined) as unknown as FieldDecorator<O, Optional<O, FieldOutput<O>>>;
}

/** Options for @body. The pipeline starts from the parsed body (`unknown`). */
export interface BodyOptions<O = unknown> {
  /**
   * Transform or pipeline applied to the parsed body, e.g. a schema parser.
   *
   * ```ts
   * @body({ transform: parseCsv }) accessor rows!: Promise<Row[] | undefined>;
   * ```
   */
  transform?: Pipe;
  /**
   * Validator(s) run on the transformed body. Inline functions annotate their parameter.
   *
   * ```ts
   * @body({ validate: (b: unknown) => typeof b === "string" || "Send text/plain" }) accessor note!: Promise<unknown>;
   * ```
   */
  validate?: Validator<FieldOutput<O, unknown>> | readonly Validator<FieldOutput<O, unknown>>[];
  /**
   * No body means 400 instead of `undefined`.
   *
   * ```ts
   * @body({ required: true }) accessor payload!: Promise<unknown>;
   * ```
   */
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
 * multipart forms likewise with their files next to the fields, text/* as a
 * string, anything else as a Uint8Array.
 *
 * ```ts
 * @body(Signup) accessor signup!: Promise<Signup>;
 * @post @args(body(Signup)) create(signup: Signup) { return { email: signup.email }; }
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
    const sent = fields?.[name];
    // A repeated field takes its first value, like @query; an empty JSON array is missing.
    const value = Array.isArray(sent) ? sent[0] : sent;
    if (value === undefined) return missing("form field", name, options);
    return resolveField("form field", name, value, options);
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

/**
 * Options for @file and @files. An empty file input counts as no file.
 *
 * ```ts
 * @file("avatar", { required: true, types: ["image/png", "image/jpeg"], maxSize: 2_000_000 }) accessor avatar!: Promise<File>;
 * @files("extras", { types: ["image/*"] }) accessor extras!: Promise<File[]>;
 * ```
 */
export interface FileOptions {
  /**
   * A 400 when no file was uploaded under the name. On @file it also narrows
   * the type to `Promise<File>`.
   *
   * ```ts
   * @file("resume", { required: true }) accessor resume!: Promise<File>;
   * ```
   */
  required?: boolean;
  /**
   * Largest file accepted, in bytes (413 beyond). The request's `bodyLimit` still caps the whole body.
   *
   * ```ts
   * @file("doc", { maxSize: 5 * 1024 * 1024 }) accessor doc!: Promise<File | undefined>;
   * ```
   */
  maxSize?: number;
  /**
   * Accepted mime types; `image/*` style wildcards allowed (415 otherwise).
   *
   * ```ts
   * @files("photos", { types: ["image/*", "application/pdf"] }) accessor photos!: Promise<File[]>;
   * ```
   */
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

/**
 * A request cookie. Same options as @query: missing means the field's
 * initializer (or undefined), or a 400 with `required: true`. To set or
 * delete cookies, use `res(..., { cookies })` or `ctx.setCookie()`.
 *
 * ```ts
 * @route("/prefs")
 * export class Prefs {
 *   @cookie("theme") accessor theme = "light";
 *   @cookie("visits", { transform: toInt }) accessor visits = 0;
 * }
 * ```
 */
export function cookie<const O extends OptionalFieldOptions<O> = {}>(
  name: string,
  options?: O,
): FieldDecorator<O, Optional<O, FieldOutput<O>>> {
  return cookieAccessor(name, options as AnyOptions | undefined) as unknown as FieldDecorator<O, Optional<O, FieldOutput<O>>>;
}

/**
 * The request's AbortSignal: aborts when the client disconnects or the server
 * shuts down. Pass it to anything slow (fetch, a queue wait, a subscription)
 * so the work stops when nobody is waiting for it.
 *
 * ```ts
 * @route("/slow")
 * export class Slow {
 *   @signal accessor stop!: AbortSignal;
 *
 *   @get async page() {
 *     const r = await fetch("https://example.com", { signal: this.stop });
 *     return r.text();
 *   }
 * }
 * ```
 */
export const signal = createAccessor((ctx): AbortSignal => ctx.signal, { name: "signal" });

/**
 * The raw node:http `IncomingMessage`, for what the other accessors don't
 * cover (the socket, the HTTP version). Don't read its body stream yourself:
 * use @body, @field or `ctx.lines()`.
 *
 * ```ts
 * @route("/whoami")
 * export class WhoAmI {
 *   @request accessor req!: IncomingMessage;
 *
 *   @get show() {
 *     return { ip: this.req.socket.remoteAddress, http: this.req.httpVersion };
 *   }
 * }
 * ```
 */
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
export const toInt: Transform<string, number> = (input) => {
  // Trimmed, like toNumber: " 42 " from a form is 42.
  const raw = input.trim();
  if (!INTEGER.test(raw)) throw new HttpError(400, `Expected an integer, got ${JSON.stringify(input)}`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new HttpError(400, `Integer out of range: ${raw}`);
  return n;
};

/**
 * Parse a decimal number: optional minus, digits with an optional fraction,
 * optional exponent, surrounding spaces allowed (`"3.5"`, `"-.5"`, `"1e3"`).
 * Anything else is a 400, including blanks, hex (`"0x10"`), `"Infinity"` and
 * values that overflow to Infinity.
 *
 * ```ts
 * @query("lat", { transform: toNumber, validate: between(-90, 90) }) accessor lat = 0;
 * ```
 */
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
 * false; anything else is a 400. Case-sensitive. A missing parameter
 * leaves the field's initializer, so default flags to `false`.
 *
 * ```ts
 * @query("verbose", { transform: toBool }) accessor verbose = false; // ?verbose, ?verbose=1, ?verbose=true
 * ```
 */
export const toBool: Transform<string, boolean> = (raw) => {
  if (raw === "true" || raw === "1" || raw === "") return true;
  if (raw === "false" || raw === "0") return false;
  throw new HttpError(400, `Expected a boolean, got ${JSON.stringify(raw)}`);
};

/**
 * Strip leading and trailing whitespace. Put it first in a pipeline:
 * `{ transform: [trim, lower, oneOf("asc", "desc")] }`.
 *
 * ```ts
 * @field("name", { transform: trim, validate: length(1, 60), required: true }) accessor name!: Promise<string>;
 * ```
 */
export const trim: Transform<string, string> = (raw) => raw.trim();

/**
 * Lower-case the value. Usually after `trim`, for case-insensitive values
 * like tags, emails and sort keys.
 *
 * ```ts
 * @query("tag", { transform: [trim, lower] }) accessor tag: string | undefined;
 * ```
 */
export const lower: Transform<string, string> = (raw) => raw.toLowerCase();

/**
 * Only these exact values (a 400 otherwise); the output type is their union,
 * so the field can be typed as that union.
 *
 * ```ts
 * @query("view", { transform: oneOf("list", "grid") }) accessor view: "list" | "grid" = "list";
 * ```
 */
export function oneOf<const V extends string>(...values: V[]): Transform<string, V> {
  const allowed = new Set<string>(values);
  return (raw) => {
    if (!allowed.has(raw)) throw new HttpError(400, `Expected one of ${values.join(", ")}, got ${JSON.stringify(raw)}`);
    return raw as V;
  };
}

// Built-in validators.

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
