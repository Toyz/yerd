/**
 * Sessions.
 *
 * Enabled with `app.sessions(...)`. Read with `@session accessor session!: Session`
 * or `currentContext().session`. Typed through declaration merging:
 *
 * ```ts
 * declare module "@toyz/yerd" { interface SessionData { userId?: string; cart?: string[] } }
 * ```
 *
 * Two built-in stores: CookieStore (default; the data lives in the cookie,
 * sealed with AES-256-GCM) and MemoryStore (data in this process, the cookie
 * holds a random id; dev, tests, single-process deploys). Bring your own by
 * implementing SessionStore.
 *
 * Cookies are HttpOnly, SameSite=Lax, Path=/, and Secure with a `__Host-` name
 * prefix when the request came over HTTPS (the socket itself, or
 * `X-Forwarded-Proto` when `trustProxy` is on). Sessions expire after `maxAge` idle
 * time (refreshed when `rolling`) and `absoluteMaxAge` from creation, which
 * rolling never extends.
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/** Augment this to type session keys. */
export interface SessionData {}

type Data = Record<string, unknown>;

/** What a SessionStore saves for one session. */
export interface SessionRecord {
  /** The session's values. */
  data: Data;
  /** Flash values set this request, readable next request. */
  flash: Data;
  /** When the session started, in ms since the epoch; absoluteMaxAge counts from here. */
  createdAt: number;
}

/**
 * Where session data lives. Implement it to keep sessions in Redis, a
 * database, etc. ("id" kind); methods may be sync or async.
 */
export interface SessionStore {
  /** "cookie" stores keep the sealed record in the cookie itself; "id" stores keep an id there. */
  readonly kind: "cookie" | "id";
  /** The record for `id`, or undefined when unknown or expired. */
  get(id: string): SessionRecord | undefined | Promise<SessionRecord | undefined>;
  /** Save `record` under `id`, replacing any old one; it may be dropped after `ttlMs`. */
  set(id: string, record: SessionRecord, ttlMs: number): void | Promise<void>;
  /** Delete the record for `id` (logout, regenerate). */
  destroy(id: string): void | Promise<void>;
}

/** Data in the cookie, sealed. No server state. ~4KB limit. */
export class CookieStore implements SessionStore {
  readonly kind = "cookie" as const;
  /** No-op: the session manager reads the record from the cookie itself. */
  get(): undefined {
    return undefined;
  }
  /** No-op: the record is written into the cookie. */
  set(): void {}
  /** No-op: destroying clears the cookie. */
  destroy(): void {}
}

/** Options for MemoryStore. */
export interface MemoryStoreOptions {
  /** Most sessions kept; past it, the least recently saved are evicted. Default: no cap. */
  maxSize?: number;
  /** How often (ms, at most) a save also sweeps out expired sessions. Default 60s. */
  sweepInterval?: number;
}

/**
 * Data in this process, keyed by a hash of the cookie's random id. Expired
 * sessions are swept out lazily, on saves, at most once per `sweepInterval`.
 */
export class MemoryStore implements SessionStore {
  readonly kind = "id" as const;
  // Insertion order is save order: set() re-inserts, so the first entry is the least recently saved.
  readonly #records = new Map<string, { record: SessionRecord; expires: number }>();
  readonly #maxSize: number;
  readonly #sweepInterval: number;
  #lastSweep = Date.now();

  /** See MemoryStoreOptions for the defaults. */
  constructor(options: MemoryStoreOptions = {}) {
    this.#maxSize = options.maxSize ?? Infinity;
    this.#sweepInterval = options.sweepInterval ?? 60_000;
  }

  #key(id: string): string {
    // Hashed so a dump of the store can't be replayed as cookies.
    return createHash("sha256").update(id).digest("base64url");
  }

  /** A copy of the record, or undefined when missing or expired. */
  get(id: string): SessionRecord | undefined {
    const entry = this.#records.get(this.#key(id));
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.#records.delete(this.#key(id));
      return undefined;
    }
    return structuredClone(entry.record);
  }

  /** Save a copy of the record for `ttlMs`, evicting the least recently saved past `maxSize`. */
  set(id: string, record: SessionRecord, ttlMs: number): void {
    const now = Date.now();
    const key = this.#key(id);
    this.#records.delete(key);
    this.#records.set(key, { record: structuredClone(record), expires: now + ttlMs });
    if (now - this.#lastSweep >= this.#sweepInterval) {
      this.#lastSweep = now;
      for (const [k, entry] of this.#records) if (entry.expires < now) this.#records.delete(k);
    }
    for (const k of this.#records.keys()) {
      if (this.#records.size <= this.#maxSize) break;
      this.#records.delete(k);
    }
  }

  /** Forget the session. */
  destroy(id: string): void {
    this.#records.delete(this.#key(id));
  }

  /** How many sessions are held, expired ones not yet swept included. */
  get size(): number {
    return this.#records.size;
  }
}

// ── sealing ──

function keyFor(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "yerd:session", "aes-256-gcm", 32));
}

/** AES-256-GCM with the first secret. Output: base64url(iv | tag | ciphertext). */
export function seal(secrets: readonly string[], value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secrets[0]!), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/** Open with any of the secrets (rotation: new first, old still accepted). Undefined if tampered or unknown. */
export function unseal<T>(secrets: readonly string[], sealed: string): T | undefined {
  let raw: Buffer;
  try {
    raw = Buffer.from(sealed, "base64url");
  } catch {
    return undefined;
  }
  if (raw.length < 29) return undefined;
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  for (const secret of secrets) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), iv);
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8")) as T;
    } catch {
      // wrong key or tampered; try the next secret
    }
  }
  return undefined;
}

// ── the session object ──

type Key<D> = Extract<keyof D, string>;

/** One request's view of the session. Changes are saved after the handler runs. */
export class Session<D = SessionData> {
  #data: Data;
  #incomingFlash: Data;
  #outgoingFlash: Data = {};
  #dirty = false;
  #regenerated = false;
  #destroyed = false;
  #replaced = false;
  #createdAt: number;

  /** yerd creates sessions per request; you get one through @session or ctx.session. */
  constructor(
    record: SessionRecord | undefined,
    /** Store id, or undefined for a new session or a cookie store. */
    public id: string | undefined,
    createdAt: number = record?.createdAt ?? Date.now(),
  ) {
    this.#data = record ? { ...record.data } : {};
    this.#incomingFlash = record ? { ...record.flash } : {};
    this.#createdAt = createdAt;
  }

  /** When the session started, in ms since the epoch. */
  get createdAt(): number {
    return this.#createdAt;
  }

  /**
   * Writing after destroy() starts a fresh session (logout, then login or a
   * flash): a new id and creation time; the old record is still dropped.
   */
  #revive(): void {
    if (!this.#destroyed) return;
    this.#destroyed = false;
    this.#replaced = true;
    this.#regenerated = true;
    this.#createdAt = Date.now();
  }

  /** True when this request started without a session. */
  get isNew(): boolean {
    return this.id === undefined && Object.keys(this.#data).length === 0 && !this.#dirty;
  }

  /**
   * A value, or undefined. Changing a returned object in place doesn't mark
   * the session changed; set() it again to be sure it's saved.
   */
  get<K extends Key<D>>(key: K): D[K] | undefined {
    return this.#data[key] as D[K] | undefined;
  }

  /** Set a value. Keep it JSON-safe: the cookie store serializes the session as JSON. */
  set<K extends Key<D>>(key: K, value: D[K]): void {
    this.#revive();
    this.#data[key] = value;
    this.#dirty = true;
  }

  /** Remove a value. */
  delete(key: Key<D>): void {
    if (key in this.#data) {
      delete this.#data[key];
      this.#dirty = true;
    }
  }

  /** Remove every value but keep the session (same id, same creation time). Use destroy() to end it. */
  clear(): void {
    this.#data = {};
    this.#dirty = true;
  }

  /**
   * `flash(key, value)` keeps a value for the next request only (a notice after
   * a redirect). `flash(key)` reads (and consumes) one set by the previous request.
   */
  flash(key: string): unknown;
  flash(key: string, value: unknown): void;
  flash(key: string, value?: unknown): unknown {
    if (arguments.length === 1) {
      const out = this.#incomingFlash[key];
      if (key in this.#incomingFlash) {
        delete this.#incomingFlash[key];
        this.#dirty = true;
      }
      return out;
    }
    this.#revive();
    this.#outgoingFlash[key] = value;
    this.#dirty = true;
    return undefined;
  }

  /** New id, same data. Call on login, so a session id set before login can't be reused (fixation). */
  regenerate(): void {
    this.#revive();
    this.#regenerated = true;
    this.#dirty = true;
  }

  /** Drop the session and its cookie. Setting values afterwards starts a new one. */
  destroy(): void {
    this.#destroyed = true;
    this.#data = {};
    this.#incomingFlash = {};
    this.#outgoingFlash = {};
  }

  /** @internal */
  get state() {
    return {
      dirty: this.#dirty,
      regenerated: this.#regenerated,
      destroyed: this.#destroyed,
      /** Destroyed, then started again this request: the old record goes, a new id comes. */
      replaced: this.#replaced,
      record: {
        data: this.#data,
        // Unread flash from the last request is dropped; new flash goes out.
        flash: this.#outgoingFlash,
        createdAt: this.#createdAt,
      } satisfies SessionRecord,
      hadIncomingFlash: Object.keys(this.#incomingFlash).length > 0,
    };
  }
}

/** Options for app.sessions(). */
export interface SessionOptions {
  /** Where data lives. Default: a CookieStore. */
  store?: SessionStore;
  /** Idle lifetime in ms. Default 14 days. */
  maxAge?: number;
  /** Lifetime from creation in ms, never extended. Default 30 days. */
  absoluteMaxAge?: number;
  /** Refresh the idle expiry on activity. Default true. */
  rolling?: boolean;
  /** Cookie name (without the __Host- prefix). Default "yerd_session". */
  cookieName?: string;
  /** Force Secure on or off. Default: on when the request came over HTTPS. */
  secure?: boolean;
  /**
   * Believe `X-Forwarded-Proto` when deciding whether the request came over
   * HTTPS. Only turn this on behind a proxy that sets it (and strips any the
   * client sent). Default false: the socket decides, or `secure`.
   */
  trustProxy?: boolean;
}

export const DAY = 86_400_000;

export function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}
