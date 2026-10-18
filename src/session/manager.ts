import type { IncomingMessage } from "node:http";
import type { Outgoing } from "../respond/coerce.js";
import { serializeCookie } from "../server/cookies.js";
import { requestIsHttps } from "../server/http.js";
import { CSRF_FIELD, CookieStore, DAY, ENSURE_NONCE, Session, newSessionId, sealFor, unsealFor, type SessionOptions, type SessionRecord, type SessionStore } from "./session.js";

/** What the cookie carries, always sealed: the record itself (cookie store) or an id (id stores). */
interface CookiePayload {
  /** record, cookie store */
  r?: SessionRecord;
  /** id, id stores */
  i?: string;
  /** idle expiry (ms epoch) */
  e: number;
  /** when the cookie was last (re)issued */
  s: number;
}

const COOKIE_LIMIT = 4000;

const fresh = (secure: boolean): LoadedSession => ({ session: new Session(undefined, undefined), payload: undefined, secure });

/** Whether session data holds anything besides the CSRF nonce. */
function hasValues(data: Record<string, unknown>): boolean {
  for (const key in data) if (key !== CSRF_FIELD) return true;
  return false;
}

export interface LoadedSession {
  session: Session;
  payload: CookiePayload | undefined;
  secure: boolean;
}

/** Refuse options that can't work, at the sessions() call (the one way a SessionManager gets its options). */
export function checkSessionOptions(options: SessionOptions): void {
  if (options.generateId && (options.store?.kind ?? "cookie") !== "id") {
    throw new TypeError("sessions({ generateId }) needs a store that keeps ids (kind: \"id\"), like MemoryStore; a CookieStore keeps the data in the cookie and has no ids");
  }
  // Otherwise the first session write would be a 500.
  if (options.cookieName !== undefined) serializeCookie(options.cookieName, "");
}

/**
 * Opens a request's session from its cookie (when something first uses it;
 * see RequestContext) and writes it back after the handler.
 */
export class SessionManager {
  readonly #store: SessionStore | CookieStore;
  readonly #maxAge: number;
  readonly #absolute: number;
  readonly #rolling: boolean;
  readonly #name: string;

  constructor(
    readonly options: SessionOptions,
    readonly secrets: readonly string[],
  ) {
    this.#store = options.store ?? new CookieStore();
    this.#maxAge = options.maxAge ?? 14 * DAY;
    this.#absolute = options.absoluteMaxAge ?? 30 * DAY;
    this.#rolling = options.rolling ?? true;
    this.#name = options.cookieName ?? "yerd_session";
  }

  async #newId(old: string | undefined): Promise<string> {
    if (!this.options.generateId) return newSessionId();
    const id = await this.options.generateId();
    if (typeof id !== "string" || id === "") throw new TypeError(`sessions({ generateId }) returned ${JSON.stringify(id)}; it must return a non-empty string`);
    if (id === old) throw new TypeError("sessions({ generateId }) returned the session's old id on regenerate; ids must be unique");
    return id;
  }

  #secure(req: IncomingMessage): boolean {
    if (this.options.secure !== undefined) return this.options.secure;
    return requestIsHttps(req, this.options.trustProxy ?? false);
  }

  #cookieName(secure: boolean): string {
    // __Host- cookies must be Secure, Path=/, no Domain: they can't be planted by a subdomain.
    return secure ? `__Host-${this.#name}` : this.#name;
  }

  /**
   * Whether a session can be read synchronously whenever it's first used:
   * the cookie store, or an id store that says its get() is `sync`. Other
   * stores are read up front (see readsUpFront in RequestContext).
   */
  get readsOnUse(): boolean {
    return this.#store.kind === "cookie" || this.#store.sync === true;
  }

  /** Whether the request carries a cookie by the session's name (valid or not: it isn't opened). */
  hasCookie(req: IncomingMessage, cookies: Record<string, string>): boolean {
    return cookies[this.#cookieName(this.#secure(req))] !== undefined;
  }

  /**
   * The request's session: a fresh one unless the cookie opens to a live
   * session. Synchronous except when an id store's get() returns a promise.
   */
  load(req: IncomingMessage, cookies: Record<string, string>): LoadedSession | Promise<LoadedSession> {
    const secure = this.#secure(req);
    const raw = cookies[this.#cookieName(secure)];
    const now = Date.now();
    const payload = raw ? unsealFor<CookiePayload>("session-cookie", this.secrets, raw) : undefined;
    // Written as "not unexpired" so a payload or record without a usable time
    // (a malformed payload, a custom store's bad record) counts as expired
    // rather than never expiring.
    if (!payload || !(payload.e >= now)) return fresh(secure);
    if (this.#store.kind === "cookie") return this.#opened(payload.r, payload, secure, now);
    if (!payload.i) return fresh(secure);
    const got = this.#store.get(payload.i);
    if (typeof (got as PromiseLike<unknown> | undefined)?.then !== "function") return this.#opened(got as SessionRecord | undefined, payload, secure, now);
    // Any thenable a store hands back, as a real promise (callers test for one).
    const pending = Promise.resolve(got);
    if (this.#store.sync) {
      void pending.catch(() => {});
      throw new TypeError("The session store says it's sync, but its get() returned a promise; drop `sync: true` from it");
    }
    return pending.then((record) => this.#opened(record, payload, secure, now));
  }

  #opened(record: SessionRecord | undefined, payload: CookiePayload, secure: boolean, now: number): LoadedSession {
    if (!record || !(record.createdAt + this.#absolute >= now)) return fresh(secure);
    return { session: new Session(record, payload.i), payload, secure };
  }

  /**
   * Save the session onto `out` (a cookie, and the store). True when the
   * session's CSRF nonce is new to the page that sent the request: a session
   * just started, or regenerated (signing in), or cleared. Tokens rendered
   * before it no longer match.
   */
  async commit(loaded: LoadedSession, out: Outgoing): Promise<boolean> {
    const { session, payload, secure } = loaded;
    const state = session.state;
    const name = this.#cookieName(secure);
    const now = Date.now();

    // The CSRF nonce alone isn't something to keep.
    const empty = !hasValues(state.record.data) && Object.keys(state.record.flash).length === 0;
    // Destroyed and started again with nothing in it (a bare regenerate()) is still destroyed.
    if (state.destroyed || (state.replaced && empty)) {
      if (session.id && this.#store.kind === "id") await this.#store.destroy(session.id);
      if (payload) (out.cookies ??= []).push(serializeCookie(name, "", { maxAge: 0, secure }));
      return false;
    }

    const refreshDue = payload !== undefined && this.#rolling && now - payload.s > this.#maxAge / 10;
    // Every session that gets a cookie has a CSRF nonce. A new one usually got
    // it on its first write; one changed only in place (a shape default pushed
    // to) gets it here. One saved before it had a nonce (an older yerd) gets
    // one too, and is written to keep it: until then its visitor counts as
    // having no session for action tokens.
    const nonceless = typeof state.record.data[CSRF_FIELD] !== "string";
    if (!(payload !== undefined && nonceless) && !state.dirty && !refreshDue && !state.hadIncomingFlash) return false;
    // Nothing to keep and nothing to clear: don't hand out empty sessions.
    if (!payload && empty) return false;
    if (nonceless) session[ENSURE_NONCE]();

    const remainingAbsolute = state.record.createdAt + this.#absolute - now;
    const ttl = Math.max(0, Math.min(this.#maxAge, remainingAbsolute));
    const next: CookiePayload = { e: now + ttl, s: now };

    if (this.#store.kind === "cookie") {
      next.r = state.record;
    } else {
      let id = session.id;
      const old = id;
      if (state.regenerated && id) {
        await this.#store.destroy(id);
        id = undefined;
      }
      id ??= await this.#newId(old);
      await this.#store.set(id, state.record, ttl);
      session.id = id;
      next.i = id;
    }

    const value = sealFor("session-cookie", this.secrets, next);
    if (value.length > COOKIE_LIMIT) {
      throw new Error(`Session data is too big for a cookie (${value.length} bytes); use MemoryStore or your own SessionStore`);
    }
    (out.cookies ??= []).push(serializeCookie(name, value, { maxAge: ttl / 1000, secure }));
    return !payload || nonceless || state.regenerated || state.replaced;
  }
}
