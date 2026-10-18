import type { IncomingMessage } from "node:http";
import type { Outgoing } from "../respond/coerce.js";
import { serializeCookie } from "../server/cookies.js";
import { CookieStore, DAY, Session, newSessionId, seal, unseal, type SessionOptions, type SessionRecord, type SessionStore } from "./session.js";

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

export interface LoadedSession {
  session: Session;
  payload: CookiePayload | undefined;
  secure: boolean;
}

/** Refuse options that can't work, at the sessions() call. */
export function checkSessionOptions(options: SessionOptions): void {
  if (options.generateId && (options.store?.kind ?? "cookie") !== "id") {
    throw new TypeError("sessions({ generateId }) needs a store that keeps ids (kind: \"id\"), like MemoryStore; a CookieStore keeps the data in the cookie and has no ids");
  }
}

/** Loads a request's session before the handler and writes it back after. */
export class SessionManager {
  readonly #store: SessionStore;
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
    checkSessionOptions(options);
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
    if ((req.socket as { encrypted?: boolean }).encrypted) return true;
    // Anyone can send the header; only a proxy we were told about gets believed.
    if (!this.options.trustProxy) return false;
    const forwarded = req.headers["x-forwarded-proto"];
    // Proxies chain it ("https, http"): the first is what the client used.
    const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim().toLowerCase();
    return proto === "https";
  }

  #cookieName(secure: boolean): string {
    // __Host- cookies must be Secure, Path=/, no Domain: they can't be planted by a subdomain.
    return secure ? `__Host-${this.#name}` : this.#name;
  }

  async load(req: IncomingMessage, cookies: Record<string, string>): Promise<LoadedSession> {
    const secure = this.#secure(req);
    const raw = cookies[this.#cookieName(secure)];
    const now = Date.now();
    const payload = raw ? unseal<CookiePayload>(this.secrets, raw) : undefined;
    // Written as "not unexpired" so a payload or record without a usable time
    // (sealed by something else with the app secret, a custom store's bad
    // record) counts as expired rather than never expiring.
    if (!payload || !(payload.e >= now)) return { session: new Session(undefined, undefined), payload: undefined, secure };

    let record: SessionRecord | undefined;
    if (this.#store.kind === "cookie") record = payload.r;
    else if (payload.i) record = await this.#store.get(payload.i);
    if (!record || !(record.createdAt + this.#absolute >= now)) {
      return { session: new Session(undefined, undefined), payload: undefined, secure };
    }
    return { session: new Session(record, payload.i), payload, secure };
  }

  async commit(loaded: LoadedSession, out: Outgoing): Promise<void> {
    const { session, payload, secure } = loaded;
    const state = session.state;
    const name = this.#cookieName(secure);
    const now = Date.now();

    const empty = Object.keys(state.record.data).length === 0 && Object.keys(state.record.flash).length === 0;
    // Destroyed and started again with nothing in it (a bare regenerate()) is still destroyed.
    if (state.destroyed || (state.replaced && empty)) {
      if (session.id && this.#store.kind === "id") await this.#store.destroy(session.id);
      if (payload) (out.cookies ??= []).push(serializeCookie(name, "", { maxAge: 0, secure }));
      return;
    }

    const refreshDue = payload !== undefined && this.#rolling && now - payload.s > this.#maxAge / 10;
    if (!state.dirty && !refreshDue && !state.hadIncomingFlash) return;
    // Nothing to keep and nothing to clear: don't hand out empty sessions.
    if (!payload && empty) return;

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

    const value = seal(this.secrets, next);
    if (value.length > COOKIE_LIMIT) {
      throw new Error(`Session data is too big for a cookie (${value.length} bytes); use MemoryStore or your own SessionStore`);
    }
    (out.cookies ??= []).push(serializeCookie(name, value, { maxAge: ttl / 1000, secure }));
  }
}
