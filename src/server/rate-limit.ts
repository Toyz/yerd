/**
 * Rate limiting as a value guard: rateLimit() counts requests per key (the
 * client's address unless told otherwise) in fixed windows, and answers 429
 * with Retry-After once a key is over its limit. Because it's a guard, it
 * goes anywhere guards go: a route, a group, one handler, one action, or
 * the whole app.
 *
 * Fixed windows are cheap and map onto any shared store (one INCR with an
 * expiry), at the price of a burst at the edge: a client can spend its whole
 * limit at the end of one window and again at the start of the next.
 */

import { createGuard, type GuardRef, type GuardResult } from "../decorators/guards.js";
import { TooManyRequests } from "../respond/errors.js";
import { parseDuration } from "../util/duration.js";
import type { YerdContext } from "./context.js";

/** A key's count in its current window, as a store reports it after counting a request. */
export interface RateLimitHit {
  /** Requests in this window, the one just counted included. */
  count: number;
  /** When the window ends, in ms since the epoch. */
  resetAt: number;
}

/**
 * Where counts live. The default keeps them in the process
 * (MemoryRateLimitStore); with several instances behind a load balancer,
 * give them a shared one so a client's requests add up wherever they land.
 *
 * ```ts
 * class RedisRateLimitStore implements RateLimitStore {
 *   constructor(private redis: Redis) {}
 *   async hit(key: string, windowMs: number) {
 *     const [[, count], [, ttl]] = await this.redis.multi().incr(key).pexpire(key, windowMs, "NX").pttl(key).exec();
 *     return { count: Number(count), resetAt: Date.now() + Number(ttl) };
 *   }
 * }
 * ```
 */
export interface RateLimitStore {
  /** Count one request for `key`, starting a window of `windowMs` if there's none, and report the count. */
  hit(key: string, windowMs: number): RateLimitHit | Promise<RateLimitHit>;
}

/** Most keys a MemoryRateLimitStore holds by default. */
const MEMORY_MAX_KEYS = 100_000;

/**
 * Counts in a Map, for one process. Expired windows are swept as it's used,
 * with no timer to keep the process alive. Past `maxKeys` (default 100,000)
 * the oldest window is dropped, so a flood of new addresses costs bounded
 * memory, at the price of forgetting that key's count early.
 *
 * ```ts
 * const store = new MemoryRateLimitStore({ maxKeys: 10_000 });
 * export const loginLimit = rateLimit({ name: "login", limit: 5, window: "1m", store });
 * export const signupLimit = rateLimit({ name: "signup", limit: 3, window: "1h", store });
 * ```
 */
export class MemoryRateLimitStore implements RateLimitStore {
  readonly #windows = new Map<string, RateLimitHit>();
  readonly #maxKeys: number;
  #nextSweep = 0;

  constructor(options: { maxKeys?: number } = {}) {
    this.#maxKeys = options.maxKeys ?? MEMORY_MAX_KEYS;
    if (!Number.isInteger(this.#maxKeys) || this.#maxKeys < 1) throw new TypeError(`maxKeys must be a positive integer, not ${options.maxKeys}`);
  }

  hit(key: string, windowMs: number): RateLimitHit {
    const now = Date.now();
    if (now >= this.#nextSweep) {
      for (const [k, w] of this.#windows) if (w.resetAt <= now) this.#windows.delete(k);
      this.#nextSweep = now + windowMs;
    }
    let window = this.#windows.get(key);
    if (!window || window.resetAt <= now) {
      // Re-inserted, so the Map's order stays oldest window first.
      this.#windows.delete(key);
      if (this.#windows.size >= this.#maxKeys) this.#windows.delete(this.#windows.keys().next().value!);
      window = { count: 0, resetAt: now + windowMs };
      this.#windows.set(key, window);
    }
    window.count++;
    return { count: window.count, resetAt: window.resetAt };
  }

  /** How many keys have a window open (expired ones count until the next sweep). */
  get size(): number {
    return this.#windows.size;
  }
}

/**
 * Options for rateLimit().
 *
 * ```ts
 * rateLimit({ limit: 100, window: "1m", key: (ctx) => ctx.headers["x-api-key"] as string | undefined });
 * ```
 */
export interface RateLimitOptions {
  /** Requests allowed per key in each window. */
  limit: number;
  /** The window: ms, or a duration like "30s", "1m", "1h". */
  window: number | string;
  /**
   * The guard's label in logs, and the prefix of its keys in the store
   * (default "rateLimit"). Give each limiter its own when they share a store.
   */
  name?: string;
  /**
   * Who a request counts against. Default ctx.ip (see trustProxy). Return
   * undefined (or "") to let the request through uncounted: a signed-in
   * user's id when there is one, say, with anonymous traffic left to another
   * limiter.
   *
   * ```ts
   * key: (ctx) => `${ctx.ip}:${ctx.params.slug}`, // per client, per post
   * ```
   */
  key?: (ctx: YerdContext) => string | undefined | Promise<string | undefined>;
  /** Where counts live. Default: a MemoryRateLimitStore of its own. */
  store?: RateLimitStore;
  /** The 429's message. Default "Too Many Requests". */
  message?: string;
}

/**
 * A guard that allows `limit` requests per key per `window`, then answers
 * 429 Too Many Requests with Retry-After until the window ends. Use it like
 * any value guard: as a decorator, in a `guards` list, or app-wide with
 * app.guard().
 *
 * Under a reverse proxy, turn on `trustProxy` so the default key is the
 * client's address rather than the proxy's (see ctx.ip). Prerendering a
 * page at build time isn't counted.
 *
 * ```tsx
 * export const loginLimit = rateLimit({ name: "login", limit: 5, window: "1m" });
 *
 * @route("/login")
 * export class Login {
 *   @get page() { return <LoginForm action={this.signIn} />; }
 *   @action @loginLimit async signIn(_: {}, form: ActionForm) { ... }
 * }
 *
 * @group("/api", { guards: [rateLimit({ name: "api", limit: 600, window: "1m" })] })
 * export class Api {}
 * ```
 */
export function rateLimit(options: RateLimitOptions): GuardRef {
  const { limit, name = "rateLimit", message } = options;
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError(`rateLimit: limit must be a positive integer, not ${limit}`);
  const windowMs = parseDuration(options.window);
  if (!(windowMs > 0)) throw new TypeError(`rateLimit: window must be longer than 0, not ${JSON.stringify(options.window)}`);
  const key = options.key ?? ((ctx: YerdContext) => ctx.ip);
  const store = options.store ?? new MemoryRateLimitStore();

  const judge = (hit: RateLimitHit): GuardResult =>
    hit.count <= limit || new TooManyRequests(message, { retryAfter: Math.max(1, Math.ceil((hit.resetAt - Date.now()) / 1000)) });
  const count = (id: string | undefined): GuardResult | Promise<GuardResult> => {
    if (!id) return true;
    const hit = store.hit(`${name}:${id}`, windowMs);
    return hit instanceof Promise ? hit.then(judge) : judge(hit);
  };
  return createGuard(name, (ctx) => {
    // Building a prerendered page: there's no client to count.
    if (ctx.prerendering) return true;
    const id = key(ctx);
    return id instanceof Promise ? id.then(count) : count(id);
  });
}
