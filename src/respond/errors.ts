import type { Issue } from "../decorators/dto.js";
import { assertStatus, checkHeader, type HeaderInit } from "./response.js";

/**
 * Options for a YerdError and its subclasses.
 *
 * ```ts
 * throw new YerdError(409, "Username taken", { code: "username_taken", details: { field: "username" } });
 * ```
 */
export interface YerdErrorOptions {
  /**
   * A machine-readable name for the failure, sent as `code` in the JSON body.
   * Every subclass has a default ("not_found", "conflict"...).
   *
   * ```ts
   * throw new Conflict("That SKU is out of stock", { code: "out_of_stock" });
   * ```
   */
  code?: string;
  /**
   * Whether the message, code and details reach the client. Default: true below 500.
   *
   * ```ts
   * throw new ServiceUnavailable("Search is reindexing, try again in a minute", { expose: true });
   * ```
   */
  expose?: boolean;
  /**
   * Extra fields merged into the JSON body when exposed.
   *
   * ```ts
   * throw new BadRequest("Pick a delivery day", { details: { field: "day" } });
   * ```
   */
  details?: Record<string, unknown>;
  /**
   * Headers for the error response, sent whether it's exposed or not.
   *
   * ```ts
   * throw new Gone("API v1 is retired", { headers: { link: '</api/v2>; rel="successor-version"' } });
   * ```
   */
  headers?: HeaderInit;
  /**
   * The underlying error, kept for logs.
   *
   * ```ts
   * throw new ServiceUnavailable("Payments are down", { cause: error });
   * ```
   */
  cause?: unknown;
}

/**
 * Throw to answer with a status, from a handler, guard, transform or
 * service. yerd's own failures are subclasses too, so `@catches(NotFound)`
 * sees an unknown path.
 *
 * ```tsx
 * @route("/links/:id")
 * export class LinkPage {
 *   @inject(Db) accessor db!: Db;
 *   @param("id") accessor id!: string;
 *
 *   @get async show() {
 *     const link = await this.db.links.get(this.id);
 *     if (!link) throw new NotFound("No such link");
 *     return link;
 *   }
 *
 *   @catches(NotFound)
 *   gone() {
 *     return res(<p>That link is gone.</p>, { status: 404 });
 *   }
 * }
 * ```
 *
 * - Exposed (below 500 by default): the body is `toJSON()` when there's a code or details, else the message as text.
 * - Unexposed: the body is the status text; message, code and details stay on the server.
 * - `headers` go out either way, on the error page too.
 */
export class YerdError extends Error {
  /**
   * A machine-readable name for the failure; undefined unless given (or set by a subclass).
   *
   * ```ts
   * if (error instanceof YerdError && error.code === "out_of_stock") showRestockForm();
   * ```
   */
  readonly code: string | undefined;
  /**
   * Whether `message`, `code` and `details` reach the client. Default: true below 500.
   *
   * ```ts
   * throw new YerdError(503, "Search is reindexing, try again in a minute", { expose: true });
   * ```
   */
  readonly expose: boolean;
  /**
   * Extra fields merged into the JSON body when exposed.
   *
   * ```ts
   * throw new YerdError(409, "Username taken", { details: { field: "username" } });
   * // -> 409 {"error":"Username taken","field":"username"}
   * ```
   */
  readonly details: Record<string, unknown> | undefined;
  /**
   * Headers sent with the error response, names lowercased.
   *
   * ```ts
   * new TooManyRequests(undefined, { retryAfter: 30 }).headers["retry-after"]; // "30"
   * ```
   */
  readonly headers: HeaderInit;

  /**
   * `message` defaults to "HTTP <status>". A status outside 200-599 or a bad header is a TypeError.
   *
   * ```ts
   * throw new YerdError(422, "Invalid order", { code: "invalid_order", details: { field: "qty" } });
   * ```
   */
  constructor(
    readonly status: number,
    message?: string,
    options: YerdErrorOptions = {},
  ) {
    super(message ?? `HTTP ${status}`, { cause: options.cause });
    // Caught here rather than when the response is written, past every error handler.
    assertStatus(status, `new ${new.target.name}()`);
    // The class's own name, so a subclass of yours logs as itself.
    this.name = new.target.name;
    this.code = options.code;
    this.expose = options.expose ?? status < 500;
    this.details = options.details;
    const headers: HeaderInit = {};
    for (const name in options.headers) {
      const value = options.headers[name]!;
      checkHeader(name, value);
      headers[name.toLowerCase()] = value;
    }
    this.headers = headers;
  }

  /**
   * The JSON body: `{ error: message, code, ...details }`. Override it for a
   * shape of your own; an override makes the body JSON even without a code.
   *
   * ```ts
   * class Problem extends YerdError {
   *   override toJSON() {
   *     return { type: `https://example.com/problems/${this.code}`, title: this.message, status: this.status };
   *   }
   * }
   * ```
   */
  toJSON(): Record<string, unknown> {
    return this.code === undefined ? { error: this.message, ...this.details } : { error: this.message, code: this.code, ...this.details };
  }
}

/** The options with one more header set, for the subclasses whose own option is a header. */
function withHeader(options: YerdErrorOptions | undefined, name: string, value: string | undefined): YerdErrorOptions {
  if (value === undefined) return { ...options };
  return { ...options, headers: { ...options?.headers, [name]: value } };
}

/** Retry-After from seconds (rounded up) or a Date. */
function retryAfterValue(when: number | Date | undefined): string | undefined {
  if (when === undefined) return undefined;
  if (when instanceof Date) {
    if (Number.isNaN(when.getTime())) throw new TypeError("retryAfter is an invalid Date");
    return when.toUTCString();
  }
  if (!Number.isFinite(when) || when < 0) throw new TypeError(`retryAfter: ${when} isn't a number of seconds`);
  return String(Math.ceil(when));
}

/**
 * 400, code "bad_request": malformed input, like a body that isn't JSON.
 *
 * ```ts
 * if (!signature) throw new BadRequest("Missing webhook signature");
 * ```
 */
export class BadRequest extends YerdError {
  /**
   * Message default "Bad Request".
   *
   * ```ts
   * throw new BadRequest("Send the date as YYYY-MM-DD");
   * ```
   */
  constructor(message?: string, options?: YerdErrorOptions) {
    super(400, message ?? "Bad Request", { code: "bad_request", ...options });
  }
}

/**
 * 401, code "unauthorized": not signed in. `challenge` becomes the WWW-Authenticate header.
 *
 * ```ts
 * throw new Unauthorized("Bad API key", { challenge: 'Bearer realm="api"' });
 * ```
 */
export class Unauthorized extends YerdError {
  /**
   * The WWW-Authenticate challenge, if given.
   *
   * ```ts
   * new Unauthorized(undefined, { challenge: "Basic" }).challenge; // "Basic"
   * ```
   */
  readonly challenge: string | undefined;

  /**
   * Message default "Unauthorized".
   *
   * ```ts
   * throw new Unauthorized("Sign in first");
   * ```
   */
  constructor(message?: string, options?: YerdErrorOptions & { challenge?: string }) {
    super(401, message ?? "Unauthorized", { code: "unauthorized", ...withHeader(options, "www-authenticate", options?.challenge) });
    this.challenge = options?.challenge;
  }
}

/**
 * 403, code "forbidden": signed in, but not allowed.
 *
 * ```ts
 * export const staffOnly = createGuard("staffOnly", (ctx) => isStaff(ctx) || new Forbidden("Staff only"));
 * ```
 */
export class Forbidden extends YerdError {
  /**
   * Message default "Forbidden".
   *
   * ```ts
   * throw new Forbidden("Come back during business hours");
   * ```
   */
  constructor(message?: string, options?: YerdErrorOptions) {
    super(403, message ?? "Forbidden", { code: "forbidden", ...options });
  }
}

/**
 * 404, code "not_found". Extend it for your own not-found errors.
 *
 * ```ts
 * class ProductNotFound extends NotFound {
 *   constructor(readonly id: string) {
 *     super(`No product with id ${id}`, { code: "product_not_found", details: { id } });
 *   }
 * }
 * ```
 */
export class NotFound extends YerdError {
  /**
   * Message default "Not Found".
   *
   * ```ts
   * if (!todo) throw new NotFound(`No todo with id ${this.id}`);
   * ```
   */
  constructor(message?: string, options?: YerdErrorOptions) {
    super(404, message ?? "Not Found", { code: "not_found", ...options });
  }
}

/**
 * 405, code "method_not_allowed". `allow` becomes the Allow header.
 *
 * ```ts
 * throw new MethodNotAllowed(undefined, { allow: ["GET", "HEAD"] });
 * ```
 */
export class MethodNotAllowed extends YerdError {
  /**
   * The allowed methods, as given (empty when none were).
   *
   * ```ts
   * app.onError((error) => (error instanceof MethodNotAllowed ? { allowed: error.allow } : undefined));
   * ```
   */
  readonly allow: readonly string[];

  /**
   * Message default "Method Not Allowed".
   *
   * ```ts
   * throw new MethodNotAllowed("Read-only", { allow: ["GET", "HEAD"] });
   * ```
   */
  constructor(message?: string, options?: YerdErrorOptions & { allow?: readonly string[] }) {
    const allow = options?.allow ?? [];
    super(405, message ?? "Method Not Allowed", { code: "method_not_allowed", ...withHeader(options, "allow", options?.allow?.join(", ")) });
    this.allow = allow;
  }
}

/**
 * 406, code "not_acceptable": nothing the client's Accept header takes.
 *
 * ```ts
 * if (!ctx.headers.accept?.includes("text/csv")) throw new NotAcceptable("This export is CSV only");
 * ```
 */
export class NotAcceptable extends YerdError {
  /**
   * Message default "Not Acceptable".
   *
   * ```ts
   * throw new NotAcceptable("Ask for application/json");
   * ```
   */
  constructor(message?: string, options?: YerdErrorOptions) {
    super(406, message ?? "Not Acceptable", { code: "not_acceptable", ...options });
  }
}

/**
 * 409, code "conflict": clashes with the current state. A good base for domain errors.
 *
 * ```ts
 * class OutOfStock extends Conflict {
 *   constructor(readonly sku: string) {
 *     super(`${sku} is out of stock`, { code: "out_of_stock", details: { sku } });
 *   }
 * }
 * ```
 */
export class Conflict extends YerdError {
  /**
   * Message default "Conflict".
   *
   * ```ts
   * throw new Conflict("Username taken", { details: { field: "username" } });
   * ```
   */
  constructor(message?: string, options?: YerdErrorOptions) {
    super(409, message ?? "Conflict", { code: "conflict", ...options });
  }
}

/**
 * 410, code "gone": it was here, and won't be back.
 *
 * ```ts
 * if (invite.usedAt) throw new Gone("This invite was already used");
 * ```
 */
export class Gone extends YerdError {
  /**
   * Message default "Gone".
   *
   * ```ts
   * throw new Gone("API v1 is retired; use /api/v2");
   * ```
   */
  constructor(message?: string, options?: YerdErrorOptions) {
    super(410, message ?? "Gone", { code: "gone", ...options });
  }
}

/**
 * 413, code "payload_too_large": the body or a file is too big.
 *
 * ```ts
 * if (rows.length > 10_000) throw new PayloadTooLarge("Import at most 10,000 rows at a time");
 * ```
 */
export class PayloadTooLarge extends YerdError {
  /**
   * Message default "Content Too Large" (RFC 9110's name for 413).
   *
   * ```ts
   * throw new PayloadTooLarge("Keep descriptions under 10 kB");
   * ```
   */
  constructor(message?: string, options?: YerdErrorOptions) {
    super(413, message ?? "Content Too Large", { code: "payload_too_large", ...options });
  }
}

/**
 * 415, code "unsupported_media_type": a content or file type that isn't accepted.
 *
 * ```ts
 * if ((await ctx.body()).kind !== "json") throw new UnsupportedMediaType("Send JSON");
 * ```
 */
export class UnsupportedMediaType extends YerdError {
  /**
   * Message default "Unsupported Media Type".
   *
   * ```ts
   * throw new UnsupportedMediaType("Upload a PNG or a JPEG");
   * ```
   */
  constructor(message?: string, options?: YerdErrorOptions) {
    super(415, message ?? "Unsupported Media Type", { code: "unsupported_media_type", ...options });
  }
}

/**
 * 400, code "validation_failed": input that broke its rules. `issues` is
 * sent in the body; without it, the message is one issue at "(root)".
 *
 * ```ts
 * throw new ValidationFailed("The trip ends before it starts", { issues: [{ path: "end", message: "Must be after the start" }] });
 * ```
 */
export class ValidationFailed extends YerdError {
  /**
   * What was wrong, one entry per problem.
   *
   * ```tsx
   * @catches(ValidationFailed)
   * invalid(error: ValidationFailed) {
   *   return res(<SignupForm issues={error.issues} />, { status: 400 });
   * }
   * ```
   */
  readonly issues: Issue[];

  /**
   * Message default "Validation failed".
   *
   * ```ts
   * throw new ValidationFailed(undefined, { issues: [{ path: "email", message: "Already registered" }] });
   * ```
   */
  constructor(message?: string, options?: YerdErrorOptions & { issues?: Issue[] }) {
    const text = message ?? "Validation failed";
    const issues = options?.issues ?? [{ path: "(root)", message: text }];
    super(400, text, { code: "validation_failed", ...options, details: { ...options?.details, issues } });
    this.issues = issues;
  }
}

/**
 * 429, code "too_many_requests". `retryAfter` (seconds, or a Date) becomes the Retry-After header.
 *
 * ```ts
 * if (!bucket.take()) throw new TooManyRequests("Easy there", { retryAfter: 30 });
 * ```
 */
export class TooManyRequests extends YerdError {
  /**
   * When to try again, as given.
   *
   * ```ts
   * new TooManyRequests(undefined, { retryAfter: 60 }).retryAfter; // 60
   * ```
   */
  readonly retryAfter: number | Date | undefined;

  /**
   * Message default "Too Many Requests". A negative `retryAfter` or an invalid Date is a TypeError.
   *
   * ```ts
   * throw new TooManyRequests(undefined, { retryAfter: new Date(resetsAt) });
   * ```
   */
  constructor(message?: string, options?: YerdErrorOptions & { retryAfter?: number | Date }) {
    super(429, message ?? "Too Many Requests", { code: "too_many_requests", ...withHeader(options, "retry-after", retryAfterValue(options?.retryAfter)) });
    this.retryAfter = options?.retryAfter;
  }
}

/**
 * 503, code "service_unavailable". `retryAfter` (seconds, or a Date) becomes
 * the Retry-After header. Unexposed unless you say so, like any 5xx.
 *
 * ```ts
 * throw new ServiceUnavailable("Back after the migration", { retryAfter: 300, expose: true });
 * ```
 */
export class ServiceUnavailable extends YerdError {
  /**
   * When to try again, as given.
   *
   * ```ts
   * new ServiceUnavailable(undefined, { retryAfter: 120 }).retryAfter; // 120
   * ```
   */
  readonly retryAfter: number | Date | undefined;

  /**
   * Message default "Service Unavailable". A negative `retryAfter` or an invalid Date is a TypeError.
   *
   * ```ts
   * throw new ServiceUnavailable("Read-only during maintenance", { retryAfter: 300 });
   * ```
   */
  constructor(message?: string, options?: YerdErrorOptions & { retryAfter?: number | Date }) {
    super(503, message ?? "Service Unavailable", { code: "service_unavailable", ...withHeader(options, "retry-after", retryAfterValue(options?.retryAfter)) });
    this.retryAfter = options?.retryAfter;
  }
}

/**
 * The JSON body for an exposed error, or undefined when it answers in
 * plain text: no code, no details and the stock toJSON().
 */
export function jsonBody(error: YerdError): string | undefined {
  if (error.code === undefined && error.details === undefined && error.toJSON === YerdError.prototype.toJSON) return undefined;
  return JSON.stringify(error.toJSON());
}

/**
 * Rebuild an error that crossed a process boundary (an events.call()
 * reply) as the class yerd has for its status, so `instanceof` and
 * @catches still work for the caller. A subclass of yours arrives as its
 * parent (an OutOfStock as a Conflict), code and details intact.
 */
export function errorForStatus(status: number, message: string, options: YerdErrorOptions): YerdError {
  const headers = options.headers ?? {};
  switch (status) {
    case 400:
      return Array.isArray(options.details?.issues)
        ? new ValidationFailed(message, { ...options, issues: options.details.issues as Issue[] })
        : new BadRequest(message, options);
    case 401:
      return new Unauthorized(message, { ...options, challenge: headers["www-authenticate"] });
    case 403:
      return new Forbidden(message, options);
    case 404:
      return new NotFound(message, options);
    case 405:
      return new MethodNotAllowed(message, { ...options, allow: headers.allow?.split(/\s*,\s*/) });
    case 406:
      return new NotAcceptable(message, options);
    case 409:
      return new Conflict(message, options);
    case 410:
      return new Gone(message, options);
    case 413:
      return new PayloadTooLarge(message, options);
    case 415:
      return new UnsupportedMediaType(message, options);
    case 429:
      return new TooManyRequests(message, options);
    case 503:
      return new ServiceUnavailable(message, options);
    default:
      return new YerdError(status, message, options);
  }
}
