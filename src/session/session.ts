/**
 * Sessions.
 *
 * Enabled with `app.sessions(...)`. Read with `@session accessor session!: Session`
 * or `currentContext().session`. Give it a shape per route, whose fields
 * become typed properties (`session.items`):
 *
 * ```ts
 * interface Cart { items?: string[]; coupon?: string }
 * @session accessor session!: Session<Cart>;
 * ```
 *
 * or app-wide, through declaration merging (what plain `Session` uses):
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

/** Augment this to type session keys app-wide; `Session<T>` types one route's view instead. */
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
  /**
   * Under the Vite dev server, stores with the same name share their records
   * across app reloads, so editing a file doesn't sign everyone out. Default
   * "default"; give two stores in one app different names.
   */
  name?: string;
}

/** Set by the Vite dev plugin; see src/vite. */
const DEV_SERVER = Symbol.for("yerd.devAssets");

/**
 * Data in this process, keyed by a hash of the cookie's random id. Expired
 * sessions are swept out lazily, on saves, at most once per `sweepInterval`.
 */
export class MemoryStore implements SessionStore {
  readonly kind = "id" as const;
  // Insertion order is save order: set() re-inserts, so the first entry is the least recently saved.
  readonly #records: Map<string, { record: SessionRecord; expires: number }>;
  readonly #maxSize: number;
  readonly #sweepInterval: number;
  #lastSweep = Date.now();

  /** See MemoryStoreOptions for the defaults. */
  constructor(options: MemoryStoreOptions = {}) {
    this.#maxSize = options.maxSize ?? Infinity;
    this.#sweepInterval = options.sweepInterval ?? 60_000;
    const globals = globalThis as Record<symbol, unknown>;
    if (globals[DEV_SERVER]) {
      // The dev server re-imports the app on every change; the records outlive it.
      const key = Symbol.for(`yerd.memoryStore:${options.name ?? "default"}`);
      this.#records = (globals[key] ??= new Map()) as Map<string, { record: SessionRecord; expires: number }>;
    } else {
      this.#records = new Map();
    }
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

/**
 * Session values as properties (`session.cart`), read and written through
 * get/set/delete. Optional as you declare them: mark a field `?` unless it
 * has a default (a field initializer on a shape class). Fields named like a
 * Session member (`get`, `id`, `flash`, ...) are left out: use get()/set()
 * for those.
 */
export type SessionFields<D> = Omit<D, keyof SessionApi<D>>;

/** A class describing a session's shape: data fields (initializers are defaults), getters and methods. */
export type SessionShape<T extends object = object> = new () => T;

/** The real instance behind a session proxy. */
const RAW: unique symbol = Symbol("yerd.session.raw");
/** Put a default into the data without counting it as a change. */
const ADOPT: unique symbol = Symbol("yerd.session.adopt");

const NO_SHAPE = { proto: null as object | null, defaults: {} as Data };

/**
 * Routes a property the session doesn't have to the shape class (its methods
 * and accessors, called with `this` as the session) and then to the data
 * (get/set/delete, falling back to the shape's defaults). Session members
 * are read off the real instance, methods bound to it: private fields don't
 * work through a proxy.
 */
function handler({ proto, defaults }: { proto: object | null; defaults: Data }): ProxyHandler<SessionApi<Data>> {
  const onShape = (key: string) => proto !== null && key in proto;
  return {
    get(target, key, receiver) {
      if (typeof key === "symbol" || key in target) {
        const value = Reflect.get(target, key, target);
        return typeof value === "function" && key !== RAW ? value.bind(target) : value;
      }
      if (onShape(key)) {
        const value = Reflect.get(proto!, key, receiver);
        return typeof value === "function" ? value.bind(receiver) : value;
      }
      const value = target.get(key);
      if (value !== undefined || !Object.hasOwn(defaults, key)) return value;
      // Kept in the data so in-place changes (`cart.items.push(x)`) stick; saved only if changed.
      target[ADOPT](key, defaults[key]);
      return defaults[key];
    },
    set(target, key, value, receiver) {
      if (typeof key === "symbol" || key in target) return Reflect.set(target, key, value, target);
      if (onShape(key)) return Reflect.set(proto!, key, value, receiver);
      if (value === undefined) target.delete(key);
      else target.set(key, value);
      return true;
    },
    deleteProperty(target, key) {
      if (typeof key === "symbol" || key in target) return Reflect.deleteProperty(target, key);
      target.delete(key);
      return true;
    },
    has(target, key) {
      if (key in target) return true;
      if (typeof key !== "string") return false;
      return onShape(key) || Object.hasOwn(defaults, key) || target.get(key) !== undefined;
    },
  };
}

const plain = handler(NO_SHAPE);
const views = new WeakMap<object, Map<SessionShape, object>>();
const checkedShapes = new WeakSet<SessionShape>();

/**
 * Session members win over the shape's own (the proxy reads them first), so
 * a shape method named like one (`clear()`, `delete()`, `flash()`) would
 * silently call the session's instead: `cart.clear()` wiping the whole
 * session, sign-in included. Refuse such a shape the first time it's used.
 */
function checkShape(shape: SessionShape, raw: object): void {
  if (checkedShapes.has(shape)) return;
  for (let proto = shape.prototype as object | null; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key !== "constructor" && key in raw) {
        throw new TypeError(`@session(${shape.name}): "${key}" is a Session member (session.${key}), so ${shape.name}'s own ${key} would never run; rename it`);
      }
    }
  }
  checkedShapes.add(shape);
}

/**
 * The session seen through a shape class: its methods and getters work on
 * the session (`this.items` is the session's `items`), and its field
 * initializers are defaults for missing values. One view per session and
 * class, so `@session(Cart)` on two classes in a request share it.
 */
export function shapeSession<T extends object>(session: Session<object>, shape: SessionShape<T>): Session<T> {
  const raw = (session as unknown as { [RAW]: SessionApi<Data> })[RAW];
  let byShape = views.get(raw);
  if (!byShape) views.set(raw, (byShape = new Map()));
  let view = byShape.get(shape);
  if (!view) {
    checkShape(shape, raw);
    // A fresh instance per request: its field values are this request's defaults.
    // (`coupon?: string` is an own field holding undefined: not a default.)
    const defaults = Object.fromEntries(Object.entries(new shape()).filter(([, v]) => v !== undefined));
    view = new Proxy(raw, handler({ proto: shape.prototype as object, defaults }));
    byShape.set(shape, view);
  }
  return view as Session<T>;
}

export class SessionApi<D> {
  #data: Data;
  /** The data as loaded (plus adopted defaults), to notice changes made in place (`session.cart.push(x)`). */
  #base: Data;
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
    this.#base = structuredClone(this.#data);
    this.#incomingFlash = record ? { ...record.flash } : {};
    this.#createdAt = createdAt;
    return new Proxy(this, plain as ProxyHandler<this>);
  }

  /** @internal */
  get [RAW](): this {
    return this;
  }

  /** @internal */
  [ADOPT](key: string, value: unknown): void {
    this.#data[key] = value;
    this.#base[key] = structuredClone(value);
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

  /** A value, or undefined. Changing a returned object in place is saved too. */
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
      dirty: this.#dirty || JSON.stringify(this.#data) !== JSON.stringify(this.#base),
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

/**
 * One request's view of the session. Changes are saved after the handler
 * runs. `D` is the shape it's typed by: your own interface (`Session<Cart>`),
 * or the merged `SessionData` by default. Values read and write as
 * properties too:
 *
 * ```ts
 * session.cart ??= [];
 * session.cart.push("socks"); // changed in place: still saved
 * session.coupon = undefined; // same as delete("coupon")
 * ```
 */
// Session<any> (what bare @session resolves to) is any, so the declared type decides.
export type Session<D extends object = SessionData> = unknown extends D ? any : SessionApi<D> & SessionFields<D>;

export const Session = SessionApi as new <D extends object = SessionData>(
  record: SessionRecord | undefined,
  id: string | undefined,
  createdAt?: number,
) => Session<D>;

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
  /**
   * Makes the id for a new (or regenerated) session, for stores that keep
   * an id in the cookie (`kind: "id"`; a CookieStore has none, so it's
   * refused there). Use it for ids your store or logs expect: a prefix, a
   * ULID, a database sequence. Ids must be unique; the cookie is sealed so
   * they can't be forged, but keep them unguessable anyway (a leaked store
   * dump shouldn't name live sessions). Default: 32 random bytes, base64url.
   *
   * ```ts
   * app.sessions({ store: redisStore, generateId: () => `sess_${randomUUID()}` });
   * ```
   */
  generateId?: () => string | Promise<string>;
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
