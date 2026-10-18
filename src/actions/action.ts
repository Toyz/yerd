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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createKey } from "../decorators/keys.js";
import { resolveRoute, routeRegistry } from "../decorators/route.js";
import { HttpError } from "../respond/response.js";
import { Logger } from "../log/logger.js";
import { currentContext, type YerdContext } from "../server/context.js";
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

/**
 * The shape of an action method: bound args first, then the form. The form
 * is optional here so a component can call one in an action lambda
 * (`() => bump({ id })`) without inventing one.
 */
// Method syntax, so an action declared with a required form still fits.
export type Action<A = {}> = { bivarianceHack(args: A, form?: ActionForm): unknown }["bivarianceHack"];

/**
 * An element's live state, read in an action lambda: `el.value` is whatever
 * the input holds when the action fires. Values are filled in by the browser,
 * so pass them straight into the action's arguments (`{ q: el.value }`);
 * computing with them while the page renders (`el.value.trim()`) throws.
 */
export interface ActionElement {
  /** An input's, select's or textarea's value. */
  readonly value: string;
  /** `value` as a number (NaN when empty): number, range and date inputs. */
  readonly valueAsNumber: number;
  /** A checkbox or radio's state. */
  readonly checked: boolean;
  /** A select's selected option index (-1 when none). */
  readonly selectedIndex: number;
  /** A `<details>` or `<dialog>` is open. */
  readonly open: boolean;
  readonly disabled: boolean;
  readonly textContent: string;
  readonly id: string;
  readonly name: string;
  /** How far the element is scrolled. */
  readonly scrollTop: number;
  readonly scrollLeft: number;
  /** `data-*` attributes ("" when missing). */
  readonly dataset: Readonly<Record<string, string>>;
}

/** What an action lambda gets. Use what you need: `({ el }) => ...`, `({ ctx }) => ...`. */
export interface ActionScope {
  /** The element the action is on (the form, for a form's action), as it is when the action fires. */
  readonly el: ActionElement;
  /** Another element on the page, by CSS selector, as it is when the action fires: `ref("#sort").value`. */
  ref(selector: string): ActionElement;
  /** The request rendering this page (params, query, session...). Read now, not when the action fires. */
  readonly ctx: YerdContext;
  /** A stand-in form for actions that take one: `({ form }) => this.rename({ id }, form)`. */
  readonly form: ActionForm;
}

/**
 * What `action={...}` takes: a lambda that calls one @action method with its
 * arguments, `() => this.remove({ id })`. It runs while the page renders, but
 * the action doesn't: yerd records which action was called with what and
 * signs that into the element, with `el` / `ref()` values left for the
 * browser to fill in when it fires. An action that takes no arguments can be
 * passed as is: `action={this.add}`.
 */
export type ActionLambda = (scope: ActionScope, form: ActionForm) => unknown;

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
  /** Values the browser fills in when the action fires (from an action lambda's `el` / `ref()`). */
  readonly holes?: HoleSource[];
}

/** Set while an action lambda runs at render time: action calls are recorded, not run. */
let capturing: { fn?: Function; args?: unknown; calls: number } | undefined;

/**
 * Mark a route method as an action. Its first parameter is the arguments the
 * page passed (`action={() => this.remove({ id })}`), the second the
 * submitted form.
 *
 * ```ts
 * @action add(_: {}, form: ActionForm) { ... }
 * @action remove({ id }: { id: string }) { ... }
 * ```
 */
export function action<M extends Action<any>>(method: M, context: ClassMethodDecoratorContext): M {
  if (context.static || context.private || typeof context.name !== "string") {
    throw new TypeError(`@action must decorate a public, string-named instance method (got ${String(context.name)})`);
  }
  const set = ACTIONS.hasOwn(context.metadata) ? ACTIONS.from(context.metadata)! : new Set(ACTIONS.from(context.metadata));
  set.add(context.name);
  ACTIONS.set(context.metadata, set);
  const info = { name: context.name, metadata: context.metadata };
  // Called inside an action lambda while the page renders, the action only
  // says who it is and what it was given; otherwise it runs.
  const wrapped = function (this: unknown, args: unknown, form?: ActionForm): unknown {
    if (capturing) {
      capturing.calls++;
      capturing.fn = wrapped;
      capturing.args = args;
      return undefined;
    }
    return method.call(this, args, form);
  };
  Object.defineProperty(wrapped, "name", { value: method.name });
  actionFunctions.set(method, info);
  actionFunctions.set(wrapped, info);
  return wrapped as unknown as M;
}

/** Stand-in form for action lambdas; the action never sees it. */
const STAND_IN = new ActionForm(Object.create(null) as FormFields);

/** Where a hole's value comes from: ["el", ...path] or ["ref", selector, ...path]. */
export type HoleSource = string[];

const HOLE: unique symbol = Symbol("yerd.hole");
/** How a hole travels in signed args: `{ "__yxHole": n }`, filled from the posted `_yxh<n>` field. */
const HOLE_KEY = "__yxHole";

const ELEMENT_FIELDS = new Set(["value", "valueAsNumber", "checked", "selectedIndex", "open", "disabled", "textContent", "id", "name", "scrollTop", "scrollLeft"]);
const BOOLEAN_FIELDS = new Set(["checked", "open", "disabled"]);
const NUMBER_FIELDS = new Set(["valueAsNumber", "selectedIndex", "scrollTop", "scrollLeft"]);

/** A live element at render time: every field read is a hole for the browser to fill. */
function liveElement(base: HoleSource, holes: HoleSource[]): ActionElement {
  const hole = (path: string[]) => {
    const key = JSON.stringify(path);
    let index = holes.findIndex((h) => JSON.stringify(h) === key);
    if (index < 0) index = holes.push(path) - 1;
    const label = `${path[0] === "ref" ? `ref(${JSON.stringify(path[1])})` : "el"}.${path.slice(path[0] === "ref" ? 2 : 1).join(".")}`;
    const fail = () => {
      throw new TypeError(`${label} is filled in by the browser when the action fires; pass it straight into the action's arguments ({ q: ${label} }), don't compute with it`);
    };
    // Anything but being placed in the args (el.value.trim(), `${el.value}`, el.value + 1) explains itself.
    return new Proxy(Object.create(null) as object, {
      get(_h, key) {
        if (key === HOLE) return index;
        if (key === "then" || key === "toJSON") return undefined;
        if (key === Symbol.toPrimitive) return fail;
        return fail();
      },
      has: (_h, key) => key === HOLE,
    });
  };
  const name = base[0] === "ref" ? `ref(${JSON.stringify(base[1])})` : "el";
  return new Proxy({} as ActionElement, {
    get(_t, key) {
      if (typeof key === "symbol") return undefined;
      if (key === "dataset") {
        return new Proxy({}, { get: (_d, attr) => (typeof attr === "string" ? hole([...base, "dataset", attr]) : undefined) });
      }
      if (ELEMENT_FIELDS.has(key)) return hole([...base, key]);
      throw new TypeError(`${name}.${key} can't be read in an action lambda; use one of: ${[...ELEMENT_FIELDS, "dataset"].join(", ")}`);
    },
  });
}

function isHole(value: unknown): value is { [HOLE]: number } {
  return typeof value === "object" && value !== null && HOLE in value;
}

/** Holes become `{ __yxHole: n }` so they survive JSON signing. */
function encodeHoles(value: unknown): unknown {
  if (isHole(value)) return { [HOLE_KEY]: value[HOLE] };
  if (Array.isArray(value)) return value.map(encodeHoles);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeHoles(v)]));
  }
  return value;
}

/**
 * Fill a verified token's holes from the posted `_yxh<n>` fields, typed by
 * what was read (`checked` is a boolean, `valueAsNumber` a number, the rest
 * strings). The holes' places are signed; only their values come from the
 * browser, like any form field. A missing one is a 400 (the action needs
 * the client runtime: a plain form post can't fill it).
 */
export function fillHoles(args: unknown, holes: HoleSource[] | undefined, fields: FormFields): unknown {
  if (!holes?.length) return args;
  const fill = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(fill);
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (typeof record[HOLE_KEY] === "number" && Object.keys(record).length === 1) {
      const index = record[HOLE_KEY] as number;
      const source = holes[index];
      const raw = fields[`_yxh${index}`];
      const text = Array.isArray(raw) ? raw[0] : raw;
      if (!source || text === undefined) throw new HttpError(400, "This action reads the page when it fires, which needs JavaScript");
      const field = source[source.length - 1]!;
      if (source.at(-2) !== "dataset" && BOOLEAN_FIELDS.has(field)) return text === "true";
      if (source.at(-2) !== "dataset" && NUMBER_FIELDS.has(field)) return Number(text);
      return text;
    }
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, fill(v)]));
  };
  return fill(args);
}

/**
 * Run an action lambda to find out which action it calls and with what.
 * Nothing runs for real: the action records the call and returns. `el` and
 * `ref()` reads become holes the browser fills when the action fires.
 */
export function captureAction(lambda: Function, holes: HoleSource[] = []): BoundAction {
  if (capturing) throw new TypeError("An action lambda can't render another action lambda");
  const box: { fn?: Function; args?: unknown; calls: number } = { calls: 0 };
  const scope: ActionScope = {
    el: liveElement(["el"], holes),
    ref: (selector: string) => liveElement(["ref", selector], holes),
    ctx: currentContext(),
    form: STAND_IN,
  };
  capturing = box;
  let result: unknown;
  try {
    result = lambda(scope, STAND_IN);
  } finally {
    capturing = undefined;
  }
  // An async lambda: the call before its first await was recorded; don't leave a rejection hanging.
  if (result instanceof Promise) result.catch(() => {});
  if (!box.fn) {
    throw new TypeError("An action lambda must call an @action method, like action={() => this.remove({ id })}");
  }
  if (box.calls > 1) throw new TypeError(`An action lambda calls one @action method, not ${box.calls}`);
  const bound = bind(box.fn as Action<unknown>, encodeHoles(box.args ?? {}));
  return holes.length ? { ...bound, holes } : bound;
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
  return [(processSecret ??= devSecret() ?? randomBytes(32).toString("base64url"))];
}

/**
 * In development, a random secret kept in node_modules/.cache/yerd/secret, so
 * a restarted dev server still accepts the open page's forms and sessions.
 * Undefined (a per-process secret) in production, under test, or when the
 * file can't be written.
 */
function devSecret(): string | undefined {
  const env = process.env.NODE_ENV;
  if (env !== undefined && env !== "development") return undefined;
  const file = join(process.cwd(), "node_modules", ".cache", "yerd", "secret");
  try {
    const saved = readFileSync(file, "utf8").trim();
    if (Buffer.byteLength(saved) >= 32) return saved;
  } catch {
    // not there yet
  }
  try {
    const secret = randomBytes(32).toString("base64url");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  } catch {
    return undefined;
  }
}

export interface TokenPayload {
  /** route class name */
  c: string;
  /** action name */
  a: string;
  /** bound args */
  p: unknown;
  /** where the args' holes are filled from (action lambdas' el / ref()) */
  h?: HoleSource[];
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
  /** Values for the browser to send with it (`_yxh<n>`), from an action lambda's `el` / `ref()`. */
  holes?: HoleSource[];
}

/**
 * Work out where a form for this action posts and what it carries. The URL is
 * the owning route's path, filled with the current request's params (plus the
 * query string, when that's the page being rendered).
 */
export function formAction(value: ActionLambda | Action<unknown> | BoundAction): FormAction {
  if (typeof value === "function" && !actionFunctions.has(value)) value = captureAction(value);
  const fn = isBoundAction(value) ? value.fn : (value as Action<unknown>);
  const args = isBoundAction(value) ? value.args : {};
  const info = actionFunctions.get(fn);
  if (!info) throw new TypeError("An action must be an @action method, a lambda calling one, or bind(...) of one");
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
  const holes = isBoundAction(value) ? value.holes : undefined;
  const token = ctx.signAction(holes?.length ? { c: def.className, a: info.name, p: args, h: holes } : { c: def.className, a: info.name, p: args });
  return { url: samePage ? url + ctx.url.search : url, token, ...(holes?.length ? { holes } : {}) };
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
