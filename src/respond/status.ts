/**
 * HTTP status codes by name, for anywhere yerd takes a status: a handler's
 * return value, `@status()`, `res()`, `redirect()`, `ctx.status()` and
 * `new YerdError()`. Plain numbers still work everywhere; these read better.
 *
 * A frozen object rather than a TypeScript `enum`, so it survives Node's
 * type stripping (`erasableSyntaxOnly`) and tree-shakes like any constant.
 * Names follow RFC 9110 (413 is ContentTooLarge, 422 UnprocessableContent).
 *
 * ```ts
 * import { HttpStatus, del, post, route, status } from "@toyz/yerd";
 *
 * @route("/products/:id")
 * class ProductRoute {
 *   @del remove() {
 *     this.catalog.remove(this.id);
 *     return HttpStatus.NoContent; // 204, no body
 *   }
 *
 *   @post @status(HttpStatus.Created) create() {
 *     return this.catalog.add(this.input); // 201 with the product as JSON
 *   }
 * }
 * ```
 */
export const HttpStatus = Object.freeze({
  Ok: 200,
  Created: 201,
  Accepted: 202,
  NonAuthoritativeInformation: 203,
  NoContent: 204,
  ResetContent: 205,
  PartialContent: 206,

  MultipleChoices: 300,
  MovedPermanently: 301,
  Found: 302,
  SeeOther: 303,
  NotModified: 304,
  TemporaryRedirect: 307,
  PermanentRedirect: 308,

  BadRequest: 400,
  Unauthorized: 401,
  PaymentRequired: 402,
  Forbidden: 403,
  NotFound: 404,
  MethodNotAllowed: 405,
  NotAcceptable: 406,
  RequestTimeout: 408,
  Conflict: 409,
  Gone: 410,
  LengthRequired: 411,
  PreconditionFailed: 412,
  ContentTooLarge: 413,
  UriTooLong: 414,
  UnsupportedMediaType: 415,
  RangeNotSatisfiable: 416,
  ExpectationFailed: 417,
  ImATeapot: 418,
  MisdirectedRequest: 421,
  UnprocessableContent: 422,
  Locked: 423,
  FailedDependency: 424,
  TooEarly: 425,
  UpgradeRequired: 426,
  PreconditionRequired: 428,
  TooManyRequests: 429,
  RequestHeaderFieldsTooLarge: 431,
  UnavailableForLegalReasons: 451,

  InternalServerError: 500,
  NotImplemented: 501,
  BadGateway: 502,
  ServiceUnavailable: 503,
  GatewayTimeout: 504,
  HttpVersionNotSupported: 505,
} as const);

/**
 * One of the codes in `HttpStatus`: `204`, `404`... Statuses are plain
 * numbers, so this is a narrower type for your own signatures, not a wrapper.
 *
 * ```ts
 * function answer(ok: boolean): HttpStatus {
 *   return ok ? HttpStatus.NoContent : HttpStatus.Conflict;
 * }
 * ```
 */
export type HttpStatus = (typeof HttpStatus)[keyof typeof HttpStatus];
