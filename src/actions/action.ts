/**
 * Actions: route methods that forms call.
 *
 * `<form action={this.add}>` renders as a plain POST form, so it works with
 * JavaScript off: the action runs and the browser is redirected back to the
 * page (post/redirect/get). With yerd's client runtime loaded, the same form
 * is submitted with fetch, the action's JSX comes back without layouts, and the
 * `<Region>`s in it are morphed into the page.
 *
 * The form carries a signed `_yx` token naming the route class, the action and
 * any bound arguments. The signature (HMAC-SHA256 with the app secret) means a
 * client can't call other actions or change the arguments. It doesn't mean the
 * user is allowed to act on them: actions still check ownership.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createKey } from "../decorators/keys.js";
import { resolveRoute, routeRegistry } from "../decorators/route.js";
import { HttpError } from "../respond/response.js";
import { Logger } from "../log/logger.js";
import { currentContext } from "../server/context.js";
import { withFiles, type FormFields, type FormFiles } from "../server/body.js";
import { parse, type DtoClass } from "../decorators/dto.js";

/** The submitted form fields, with typed getters. */
export class ActionForm {
  /** `uploads` holds files from a multipart form (the runtime sends file forms as multipart). */
  constructor(
    readonly fields: FormFields,
    readonly uploads: FormFiles = Object.create(null) as FormFiles,
  ) {}

  /** The first file uploaded under `name` (an empty file input counts as none), or undefined. */
  file(name: string): File | undefined {
    return this.files(name)[0];
  }

  /** Every file uploaded under `name`. */
  files(name: string): File[] {
    return (this.uploads[name] ?? []).filter((f) => f.size > 0 || f.name !== "");
  }

  /** Whether the form sent a field called `name` (even an empty one). Doesn't look at uploads. */
  has(name: string): boolean {
    return this.fields[name] !== undefined;
  }

  /** First value of a field, or undefined. */
  get(name: string): string | undefined {
    const value = this.fields[name];
    return Array.isArray(value) ? value[0] : value;
  }

  /** First value of a field; a 400 if it's missing. */
  string(name: string): string {
    const value = this.get(name);
    if (value === undefined) throw new HttpError(400, `Missing form field: ${name}`);
    return value;
  }

  /** Every value of a repeated field. */
  all(name: string): string[] {
    const value = this.fields[name];
    return value === undefined ? [] : Array.isArray(value) ? value : [value];
  }

  /** Validate the form into a DTO class (400 with every issue on failure). */
  parse<T>(dto: DtoClass<T>): T {
    // No prototype: a field named "__proto__" is plain data, not a prototype swap.
    // Uploads join the fields, for is.file() / is.files().
    const plain = withFiles(this.fields, this.uploads);
    for (const key of Object.keys(plain)) if (key.startsWith("_yx")) delete plain[key];
    return parse(dto, plain);
  }
}

/** The shape of an action method: bound args first, then the form. */
export type Action<A = {}> = (args: A, form: ActionForm) => unknown;

interface ActionInfo {
  name: string;
  metadata: DecoratorMetadataObject;
}

export const ACTIONS = createKey<Set<string>>("actions");
const actionFunctions = new WeakMap<Function, ActionInfo>();

const BOUND: unique symbol = Symbol.for("yerd.bound-action");

/** An action with its arguments attached, from bind(). Pass it as a form's `action`. */
export interface BoundAction<A = unknown> {
  /** Brand that marks a bind() result. */
  readonly [BOUND]: true;
  /** The @action method. */
  readonly fn: Action<A>;
  /** The arguments signed into the form's token and passed as the action's first parameter. */
  readonly args: A;
}

/**
 * Mark a route method as an action. Its first parameter is the bound
 * arguments (see `bind`), the second the submitted form.
 *
 * ```ts
 * @action add(_: {}, form: ActionForm) { ... }
 * @action remove({ id }: { id: string }) { ... }
 * ```
 */
export function action<A>(method: Action<A>, context: ClassMethodDecoratorContext): void {
  if (context.static || context.private || typeof context.name !== "string") {
    throw new TypeError(`@action must decorate a public, string-named instance method (got ${String(context.name)})`);
  }
  const set = ACTIONS.hasOwn(context.metadata) ? ACTIONS.from(context.metadata)! : new Set(ACTIONS.from(context.metadata));
  set.add(context.name);
  ACTIONS.set(context.metadata, set);
  actionFunctions.set(method, { name: context.name, metadata: context.metadata });
}

/** Attach arguments to an action for one form. They're signed, so the client can't change them. */
export function bind<A>(fn: Action<A>, args: A): BoundAction<A> {
  return { [BOUND]: true, fn, args };
}

export function isBoundAction(value: unknown): value is BoundAction {
  return typeof value === "object" && value !== null && (value as BoundAction)[BOUND] === true;
}

export function isAction(value: unknown): value is Action<unknown> {
  return typeof value === "function" && actionFunctions.has(value);
}

// ── signing ──

let processSecret: string | undefined;

/**
 * The app's secrets, newest first: options.secret, else YERD_SECRET (comma
 * separated for rotation), else one random secret per process. New tokens and
 * sessions use the first; any of them is accepted, so rotating is: prepend a
 * new secret, deploy, drop the old one later.
 */
export function resolveSecrets(explicit: string | string[] | undefined): string[] {
  const secrets = explicit === undefined
    ? (process.env.YERD_SECRET ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    : Array.isArray(explicit) ? explicit : [explicit];
  if (secrets.length > 0) {
    for (const s of secrets) if (Buffer.byteLength(s) < 32) throw new Error("Every yerd secret must be at least 32 bytes");
    return secrets;
  }
  if (process.env.NODE_ENV === "production") {
    new Logger("yerd::boot").warn("no YERD_SECRET set; using a random secret, so forms and sessions break across restarts and instances");
  }
  return [(processSecret ??= randomBytes(32).toString("base64url"))];
}

export interface TokenPayload {
  /** route class name */
  c: string;
  /** action name */
  a: string;
  /** bound args */
  p: unknown;
  /** expiry, unix seconds; absent on prerendered pages */
  e?: number;
  /** tag of the session's CSRF nonce; ties the token to one visitor's session */
  s?: string;
}

/** The session field holding the per-session CSRF nonce. */
export const CSRF_FIELD = "__yerd_csrf";

declare module "../session/session.js" {
  interface SessionData {
    /** yerd's per-session CSRF nonce (action tokens carry a hash of it). */
    __yerd_csrf?: string;
  }
}

/**
 * What a token carries for a session nonce: a hash of it rather than the
 * nonce itself, so a token seen in page source says nothing about the session.
 */
export function csrfTag(nonce: string): string {
  return createHash("sha256").update(nonce).digest("base64url").slice(0, 22);
}

/**
 * Check a verified token against the request: not expired, and made for this
 * session. Tokens without an expiry come from prerendered pages (built with
 * no visitor), and are accepted on their signature and the origin check alone.
 */
export function checkActionToken(payload: TokenPayload, sessionNonce: string | undefined, sessionsOn: boolean): void {
  if (payload.e === undefined) return;
  if (payload.e < Date.now() / 1000) throw new HttpError(403, "This form has expired; reload the page and try again");
  if (sessionsOn && (payload.s === undefined || sessionNonce === undefined || payload.s !== csrfTag(sessionNonce))) {
    throw new HttpError(403, "This form was made for a different session; reload the page and try again");
  }
}

function mac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signAction(secret: string, payload: TokenPayload): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${mac(secret, data)}`;
}

export function verifyAction(secrets: readonly string[], token: string): TokenPayload {
  const dot = token.indexOf(".");
  if (dot <= 0) throw new HttpError(400, "Malformed action token");
  const data = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const valid = secrets.some((secret) => {
    const expected = Buffer.from(mac(secret, data));
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!valid) throw new HttpError(400, "Invalid action signature");
  try {
    return JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as TokenPayload;
  } catch {
    throw new HttpError(400, "Malformed action token");
  }
}

// ── rendering a form ──

export interface FormAction {
  /** URL the form posts to. */
  url: string;
  /** Signed token for the hidden _yx field. */
  token: string;
}

/**
 * Work out where a form for this action posts and what it carries. The URL is
 * the owning route's path, filled with the current request's params (plus the
 * query string, when that's the page being rendered).
 */
export function formAction(value: Action<unknown> | BoundAction): FormAction {
  const fn = isBoundAction(value) ? value.fn : value;
  const args = isBoundAction(value) ? value.args : {};
  const info = actionFunctions.get(fn);
  if (!info) throw new TypeError("A form's action must be an @action method (or bind(...) of one)");
  const def = routeRegistry.find((d) => d.metadata === info.metadata);
  if (!def) throw new TypeError(`@action ${info.name} belongs to a class that isn't a @route`);
  const ctx = currentContext();
  const pattern = resolveRoute(def).pattern;
  const url = pattern.replace(/[:*]([A-Za-z0-9_]+)/g, (_, name: string) => {
    const value = ctx.params[name];
    if (value === undefined) {
      throw new Error(`Can't render a form for ${def.className}.${info.name}: the current page has no :${name} param`);
    }
    return encodeURIComponent(value);
  });
  // Keep the page's query string when posting to the page's own route, so the
  // action sees the same @query values (filters, sort) as the page did.
  const samePage = url === ctx.path;
  return { url: samePage ? url + ctx.url.search : url, token: ctx.signAction({ c: def.className, a: info.name, p: args }) };
}

/**
 * Only same-site paths are followed after an action: "/x", not "//evil.com",
 * "/\\evil.com", "https://..." or "javascript:...". Browsers drop tabs and
 * newlines anywhere in a URL and read a backslash as "/", so "/\t/evil.com" is
 * "//evil.com" to them: control characters and backslashes are refused
 * outright, then the URL parser has the last word on the origin.
 */
export function safeBack(value: string | null | undefined, fallback: string): string {
  if (!value || !value.startsWith("/") || /[\x00-\x1f\x7f\\]/.test(value)) return fallback;
  let url: URL;
  try {
    url = new URL(value, "http://x");
  } catch {
    return fallback;
  }
  return url.origin === "http://x" ? url.pathname + url.search + url.hash : fallback;
}
