import { HttpError, createGuard, currentContext, resolve, service, singleton, token, type Middleware } from "@toyz/yerd";

/** Settings that aren't a class: registered in code with `app.services((s) => s.value(ShopConfig, ...))`. */
export interface ShopConfig {
  name: string;
  /** Lets scripts write to the REST API without a browser session (`x-api-key`). */
  apiKey: string;
  /** Every write (POST, PUT, PATCH, DELETE) is refused with a 503 while this is on. */
  readOnly: boolean;
  /** Orders at or above this total ship free. */
  freeShippingCents: number;
}
export const ShopConfig = token<ShopConfig>("ShopConfig");

/**
 * Something that can email receipts. Nothing registers one in this example,
 * so Orders injects it with @maybe and skips the email; register your own with
 * `app.services((s) => s.value(Mailer, myMailer))`.
 */
export interface Mailer {
  send(to: string, subject: string, body: string): Promise<void>;
}
export const Mailer = token<Mailer>("Mailer");

/** Who's here right now: one per open sales ticker (every shop tab has one). */
@singleton
@service
export class Presence {
  #online = 0;

  join(): void {
    this.#online++;
  }

  leave(): void {
    this.#online = Math.max(0, this.#online - 1);
  }

  get online(): number {
    return this.#online;
  }
}

/**
 * App-wide guard (`app.guard(readOnlyMode)`): during maintenance the shop
 * stays browsable but every write is a 503. Logging in still works, so staff
 * can get in to see what's going on.
 */
export const readOnlyMode = createGuard("readOnlyMode", (ctx) => {
  if (!resolve(ShopConfig).readOnly || ctx.method === "GET" || ctx.method === "HEAD") return true;
  if (ctx.path === "/login" || ctx.path === "/logout") return true;
  return new HttpError(503, "The Bazaar is in read-only mode for a moment. Browse away; buying resumes shortly.");
});

/**
 * Middleware: how long the app took, as a Server-Timing header (the browser's
 * dev tools show it under Timing). Wraps guards and handlers, so it counts both.
 */
export const timing: Middleware = async (ctx, next) => {
  const started = performance.now();
  const out = await next();
  out.headers["server-timing"] = `app;dur=${(performance.now() - started).toFixed(1)};desc="${ctx.route.className}"`;
  return out;
};

/**
 * Whether this request came from yerd's client runtime (it sends a `yx`
 * header) rather than a plain form post. With the runtime, validation errors
 * can be thrown and land in the form's field boxes; a plain post would get
 * the error page, so forms flash the message and redirect back instead.
 */
export function fromScript(): boolean {
  return currentContext().headers["yx"] !== undefined;
}

/** The first message of a validation failure (an HttpError listing issues), or the error's own message. */
export function firstIssue(error: HttpError): string {
  const issues = (error.details as { issues?: Array<{ message: string }> } | undefined)?.issues;
  return issues?.[0]?.message ?? error.message;
}
