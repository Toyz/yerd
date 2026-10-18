/**
 * Sitemaps (sitemaps.org 0.9) and robots.txt, turned on with app.sitemap().
 * The app hands its routes over at boot; this module decides which of them
 * go in, asks @sitemap methods for the rest, renders the XML and serves it
 * compressed and cached. Nothing here runs unless app.sitemap() was called.
 */

import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, gzip } from "node:zlib";
import { metadataOf } from "../decorators/keys.js";
import { createMethodDecorator, type DecoratorTarget } from "../decorators/kit.js";
import type { Outgoing } from "../respond/coerce.js";
import { Logger } from "../log/logger.js";
import { parseDuration } from "../util/duration.js";
import { requestOrigin } from "../server/http.js";
import { acceptsEncoding } from "../server/static.js";

const sitemapLog = new Logger("yerd::sitemap");
const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);

/**
 * How often a page is expected to change, as sitemaps.org spells it. A hint
 * for crawlers, not a schedule they follow.
 *
 * ```ts
 * @route("/news", { sitemap: { changefreq: "hourly" } })
 * class News {
 *   @get page() { return <NewsList />; }
 * }
 * ```
 */
export type Changefreq = "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";

const CHANGEFREQS: ReadonlySet<string> = new Set<Changefreq>(["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"]);

/**
 * A page's sitemap hints: how often it changes and how it ranks against the
 * site's other pages (0 to 1). The `sitemap` option of @route and @group,
 * and `defaults` in app.sitemap().
 *
 * ```ts
 * @route("/pricing", { sitemap: { changefreq: "monthly", priority: 0.9 } })
 * class Pricing {
 *   @get page() { return <PricingTable />; }
 * }
 * ```
 */
export interface SitemapFields {
  /** How often the page changes. */
  changefreq?: Changefreq;
  /** Its priority relative to the site's other pages, from 0 to 1. Crawlers assume 0.5. */
  priority?: number;
}

/**
 * Options for the robots.txt app.sitemap() serves with `robots`. With none,
 * every crawler may fetch everything.
 *
 * ```ts
 * yerd().sitemap({ origin: "https://shop.example", robots: { disallow: ["/admin", "/cart"] } });
 * ```
 */
export interface RobotsOptions {
  /** Paths crawlers may fetch (`Allow:` lines), usually carve-outs from `disallow`. */
  allow?: string[];
  /** Paths crawlers should stay out of (`Disallow:` lines). */
  disallow?: string[];
  /** The crawler the rules are for. Default "*", every one. */
  userAgent?: string;
}

/**
 * Options for app.sitemap(). Every field is optional.
 *
 * ```ts
 * yerd().sitemap({
 *   origin: "https://shop.example",
 *   exclude: ["/api/**"],
 *   robots: { disallow: ["/admin"] },
 *   defaults: { changefreq: "weekly" },
 * });
 * ```
 */
export interface SitemapOptions {
  /**
   * The site's origin, which every URL starts with. Without it, each request
   * uses the origin it was sent to (X-Forwarded-* under `trustProxy`), and a
   * build writes no sitemap file.
   */
  origin?: string;
  /** Where the sitemap is served. Default "/sitemap.xml". */
  path?: string;
  /** Path globs to leave out, on top of the default rules: `*` is one segment, `**` any depth. */
  exclude?: readonly string[];
  /** How long a generated sitemap is kept in memory: ms or a duration like "1h". 0 builds it per request. Default "10m". */
  maxAge?: number | string;
  /** Also serve /robots.txt, pointing crawlers at the sitemap. Default false. */
  robots?: boolean | RobotsOptions;
  /** changefreq and priority for every entry that doesn't set its own. */
  defaults?: SitemapFields;
}

/**
 * One URL a @sitemap method yields for its route: `params` fill the route's
 * pattern (or `path` gives the whole path), plus optional sitemap fields.
 *
 * ```ts
 * @sitemap async *entries() {
 *   for (const post of await this.posts.published()) {
 *     yield { params: { slug: post.slug }, lastmod: post.updatedAt, priority: 0.7 };
 *   }
 * }
 * ```
 */
export interface SitemapItem extends SitemapFields {
  /** Values for the pattern's params, each URL-encoded. */
  params?: Record<string, string | number>;
  /** The page's path, used as given instead of filling the pattern. */
  path?: string;
  /** When the page last changed: a Date, or a date string ("2026-05-01" stays date-only). */
  lastmod?: Date | string;
  /** The page in other languages: a path or absolute URL per hreflang. */
  alternates?: ReadonlyArray<{ hreflang: string; href: string }>;
}

/**
 * One URL in the sitemap, resolved: an absolute `loc`, `lastmod` as a W3C
 * datetime, and the fields that apply to it. What app.sitemapEntries()
 * returns.
 *
 * ```ts
 * const entries = await app.sitemapEntries();
 * expect(entries.map((e) => e.loc)).toContain("https://shop.example/products/disco-gnome");
 * ```
 */
export interface SitemapEntry extends SitemapFields {
  /** The page's absolute URL. */
  loc: string;
  /** When it last changed, as a W3C datetime. */
  lastmod?: string;
  /** The page in other languages, with absolute URLs. */
  alternates?: Array<{ hreflang: string; href: string }>;
}

/** Per class: the method its own @sitemap decorated (a subclass's own one wins over its parent's). */
const ownSitemap = new WeakMap<object, string | symbol>();

const SITEMAP = createMethodDecorator("sitemap", {
  bare: true,
  apply(context) {
    if (ownSitemap.has(context.metadata)) {
      throw new TypeError(`@sitemap: ${String(context.name)} is a second @sitemap method on its class (one per route class)`);
    }
    ownSitemap.set(context.metadata, context.name);
  },
});

/** The method a route class's @sitemap decorated: its own, else the nearest parent's. */
export function sitemapMethod(target: DecoratorTarget): string | symbol | undefined {
  for (let metadata: object | null = typeof target === "function" ? metadataOf(target) : target; metadata && metadata !== Object.prototype; metadata = Object.getPrototypeOf(metadata)) {
    const method = ownSitemap.get(metadata);
    if (method !== undefined) return method;
  }
  return undefined;
}

/**
 * Mark the route method that lists the URLs of a route with params. It runs
 * with services available (@inject, resolve(), scoped ones too) and returns
 * or yields SitemapItems: an array, a promise of one, or a (async) generator.
 *
 * ```tsx
 * @route("/products/:slug")
 * class ProductPage {
 *   @inject(Catalog) accessor catalog!: Catalog;
 *   @param("slug") accessor slug!: string;
 *
 *   @get page() { return <Product slug={this.slug} />; }
 *
 *   @sitemap *entries() {
 *     for (const p of this.catalog.all()) yield { params: { slug: p.slug }, lastmod: p.updated, priority: 0.8 };
 *   }
 * }
 * ```
 */
export function sitemap(method: Function, context: ClassMethodDecoratorContext): void {
  SITEMAP(method, context);
}

/** Throw a TypeError naming `where` unless changefreq and priority are values sitemaps.org allows. */
export function checkSitemapFields(fields: SitemapFields, where: string): void {
  if (fields.changefreq !== undefined && !CHANGEFREQS.has(fields.changefreq)) {
    throw new TypeError(`${where}: changefreq ${JSON.stringify(fields.changefreq)} isn't one of ${[...CHANGEFREQS].join(", ")}`);
  }
  const priority = fields.priority;
  if (priority !== undefined && !(typeof priority === "number" && priority >= 0 && priority <= 1)) {
    throw new TypeError(`${where}: priority must be a number from 0 to 1 (got ${JSON.stringify(priority)})`);
  }
}

/** A route as the sitemap sees it, worked out by the app at boot. */
export interface SitemapRoute {
  className: string;
  pattern: string;
  /** The `sitemap` option through the route's groups: false leaves it out. */
  settings: SitemapFields | false | undefined;
  /** The route's own option is an object: listed even behind guards. */
  optedIn: boolean;
  /** It has a GET handler that can answer with HTML (not a stream, not only JSON). */
  page: boolean;
  /** That handler sits behind group, class or method guards. */
  guarded: boolean;
  /** Calls the @sitemap method, inside the generation's DI scope. */
  items?: () => unknown;
  /** @prerender's paths, for a route with params and no @sitemap. */
  paths?: readonly string[] | (() => readonly string[] | Promise<readonly string[]>);
}

/** Runs generation inside a DI scope (scoped services resolve), disposed afterwards. */
export type InScope = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * The protocol's limits per file. Internal and mutable so tests can split
 * a sitemap without generating fifty thousand URLs.
 */
export const SITEMAP_LIMITS = { urls: 50_000, bytes: 50 * 1024 * 1024 };

const ROBOTS_PATH = "/robots.txt";
const XML_TYPE = "application/xml; charset=utf-8";
/** Origins remembered at once when the origin comes from requests: a stream of made-up Host headers can't grow it. */
const MAX_ORIGINS = 16;

interface Asset {
  type: string;
  etag: string;
  raw: Buffer;
  br?: Promise<Buffer>;
  gzip?: Promise<Buffer>;
}

interface Generation {
  at: number;
  files: Map<string, Asset>;
}

/** The app's sitemap: options checked once, routes attached at boot, generations cached per origin. */
export class Sitemap {
  readonly origin: string | undefined;
  readonly path: string;
  readonly #exclude: RegExp[];
  readonly #maxAge: number;
  readonly #robots: RobotsOptions | undefined;
  readonly #defaults: SitemapFields;
  /** `/sitemap-1.xml` and so on, derived from `path`, for a sitemap split into an index and parts. */
  readonly #part: { prefix: string; suffix: string; pattern: RegExp };
  #routes: readonly SitemapRoute[] = [];
  #inScope: InScope = (fn) => fn();
  readonly #cache = new Map<string, Generation>();
  readonly #building = new Map<string, Promise<Generation>>();
  readonly #robotsAssets = new Map<string, Asset>();
  #warned = false;

  constructor(options: SitemapOptions) {
    if (options.origin !== undefined) {
      let url: URL;
      try {
        url = new URL(options.origin);
      } catch {
        throw new TypeError(`sitemap({ origin }): ${JSON.stringify(options.origin)} isn't a URL (e.g. "https://shop.example")`);
      }
      if ((url.protocol !== "https:" && url.protocol !== "http:") || url.pathname !== "/" || url.search || url.hash) {
        throw new TypeError(`sitemap({ origin }): ${JSON.stringify(options.origin)} must be an http(s) origin with no path (e.g. "https://shop.example")`);
      }
      this.origin = url.origin;
    }
    this.path = options.path ?? "/sitemap.xml";
    if (!this.path.startsWith("/") || this.path.startsWith("/_yerd/") || this.path === ROBOTS_PATH || /[?#\s]/.test(this.path)) {
      throw new TypeError(`sitemap({ path }): ${JSON.stringify(this.path)} must be a plain path starting with "/" (not /robots.txt or under /_yerd/)`);
    }
    this.#exclude = (options.exclude ?? []).map((glob) => {
      if (typeof glob !== "string" || !glob.startsWith("/")) throw new TypeError(`sitemap({ exclude }): ${JSON.stringify(glob)} must be a path glob starting with "/"`);
      return globPattern(glob);
    });
    this.#maxAge = parseDuration(options.maxAge ?? "10m");
    if (!(this.#maxAge >= 0) || !Number.isFinite(this.#maxAge)) throw new TypeError(`sitemap({ maxAge }): ${JSON.stringify(options.maxAge)} must be 0 or more`);
    if (options.robots) {
      this.#robots = options.robots === true ? {} : options.robots;
      const values = [this.#robots.userAgent ?? "*", ...(this.#robots.allow ?? []), ...(this.#robots.disallow ?? [])];
      for (const value of values) {
        if (typeof value !== "string" || /[\r\n]/.test(value)) throw new TypeError(`sitemap({ robots }): ${JSON.stringify(value)} must be a string on one line`);
      }
    }
    checkSitemapFields(options.defaults ?? {}, "sitemap({ defaults })");
    this.#defaults = options.defaults ?? {};
    const dot = this.path.lastIndexOf(".");
    const cut = dot > this.path.lastIndexOf("/") ? dot : this.path.length;
    const prefix = `${this.path.slice(0, cut)}-`;
    const suffix = this.path.slice(cut);
    this.#part = { prefix, suffix, pattern: new RegExp(`^${escapeRegExp(prefix)}[1-9]\\d*${escapeRegExp(suffix)}$`) };
  }

  /** The app's routes, and how to run generation in a DI scope. Called at boot. */
  attach(routes: readonly SitemapRoute[], inScope: InScope): void {
    this.#routes = routes;
    this.#inScope = inScope;
  }

  /** Whether a request for `path` is the sitemap's: the sitemap, one of its parts, or robots.txt. */
  handles(path: string): boolean {
    return path === this.path || (this.#robots !== undefined && path === ROBOTS_PATH) || this.#part.pattern.test(path);
  }

  /** The URL of part `n` of a split sitemap. */
  #partPath(n: number): string {
    return `${this.#part.prefix}${n}${this.#part.suffix}`;
  }

  /** Paths that are never listed: yerd's own and the sitemap's. */
  #reserved(path: string): boolean {
    return path.startsWith("/_yerd/") || this.handles(path) || path === ROBOTS_PATH;
  }

  #excluded(path: string): boolean {
    return this.#reserved(path) || this.#exclude.some((glob) => glob.test(path));
  }

  /**
   * Every entry for `origin`: routes without params by path, then each
   * @sitemap (or @prerender paths) route's entries in their order, by
   * pattern. A URL listed twice keeps its first entry.
   */
  async entries(origin: string): Promise<SitemapEntry[]> {
    return this.#inScope(async () => {
      const statics: SitemapEntry[] = [];
      const listed: SitemapEntry[] = [];
      const routes = [...this.#routes].sort((a, b) => compare(a.pattern, b.pattern));
      for (const route of routes) {
        if (route.settings === false) continue;
        const fields = { ...this.#defaults, ...route.settings };
        const where = `@sitemap ${route.className}`;
        const hasParams = /\/[:*]/.test(route.pattern);
        if (route.items) {
          for (const item of await collect(route.items(), where)) {
            const entry = this.#entry(origin, route, item, fields, where);
            if (entry) listed.push(entry);
          }
          continue;
        }
        if (!route.page || (route.guarded && !route.optedIn)) continue;
        if (!hasParams) {
          if (!this.#excluded(route.pattern)) statics.push({ loc: origin + route.pattern, ...fields });
          continue;
        }
        if (!route.paths) continue;
        const paths = typeof route.paths === "function" ? await route.paths() : route.paths;
        for (const path of paths) {
          const entry = this.#entry(origin, route, { path }, fields, `@prerender ${route.className}`);
          if (entry) listed.push(entry);
        }
      }
      statics.sort((a, b) => compare(a.loc, b.loc));
      const seen = new Set<string>();
      return [...statics, ...listed].filter((entry) => !seen.has(entry.loc) && Boolean(seen.add(entry.loc)));
    });
  }

  /** An item resolved against its route and `origin`, or undefined when its path is excluded. */
  #entry(origin: string, route: SitemapRoute, item: SitemapItem, fields: SitemapFields, where: string): SitemapEntry | undefined {
    if (typeof item !== "object" || item === null) throw new TypeError(`${where}: entries must be objects (got ${JSON.stringify(item)})`);
    checkSitemapFields(item, where);
    let path: string;
    if (item.path !== undefined) {
      if (typeof item.path !== "string" || !item.path.startsWith("/") || item.path.startsWith("//")) {
        throw new TypeError(`${where}: path ${JSON.stringify(item.path)} must start with a single "/"`);
      }
      path = item.path;
    } else {
      path = fillPattern(route.pattern, item.params ?? {}, where);
    }
    if (this.#excluded(path.split(/[?#]/)[0]!)) return undefined;
    const entry: SitemapEntry = { loc: origin + path, ...fields };
    if (item.changefreq !== undefined) entry.changefreq = item.changefreq;
    if (item.priority !== undefined) entry.priority = item.priority;
    if (item.lastmod !== undefined) entry.lastmod = lastmodOf(item.lastmod, where);
    if (item.alternates?.length) {
      entry.alternates = item.alternates.map(({ hreflang, href }) => {
        if (typeof hreflang !== "string" || !hreflang) throw new TypeError(`${where}: an alternate needs an hreflang`);
        return { hreflang, href: absolute(href, origin, where) };
      });
    }
    return entry;
  }

  /** Every file for `origin`: the sitemap (or its index and parts) and robots.txt. */
  async files(origin: string): Promise<Map<string, string>> {
    const files = this.#render(await this.entries(origin), origin);
    if (this.#robots) files.set(ROBOTS_PATH, robotsText(this.#robots, origin + this.path));
    return files;
  }

  /** The sitemap's XML: one urlset, or an index at `path` and parts beside it when it outgrows a file. */
  #render(entries: readonly SitemapEntry[], origin: string): Map<string, string> {
    const chunks: string[][] = [[]];
    // Room for the XML declaration and the urlset element around the URLs.
    const overhead = 256;
    let bytes = overhead;
    for (const entry of entries) {
      const element = urlElement(entry);
      const size = Buffer.byteLength(element);
      let chunk = chunks[chunks.length - 1]!;
      if (chunk.length > 0 && (chunk.length >= SITEMAP_LIMITS.urls || bytes + size > SITEMAP_LIMITS.bytes)) {
        chunks.push((chunk = []));
        bytes = overhead;
      }
      chunk.push(element);
      bytes += size;
    }
    const files = new Map<string, string>();
    if (chunks.length === 1) {
      files.set(this.path, urlset(chunks[0]!));
      return files;
    }
    const parts = chunks.map((_, i) => this.#partPath(i + 1));
    files.set(
      this.path,
      `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${parts
        .map((part) => `  <sitemap><loc>${escapeXml(origin + part)}</loc></sitemap>\n`)
        .join("")}</sitemapindex>\n`,
    );
    chunks.forEach((chunk, i) => files.set(parts[i]!, urlset(chunk)));
    return files;
  }

  /**
   * Answer a GET or HEAD for one of the sitemap's paths, or undefined to let
   * routing have it (a part this sitemap doesn't have).
   */
  async serve(req: IncomingMessage, path: string, trustProxy: boolean): Promise<Outgoing | undefined> {
    const origin = this.origin ?? requestOrigin(req, trustProxy);
    if (!origin) return { status: 400, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Bad Request" };
    if (!this.origin && !this.#warned && process.env.NODE_ENV === "production") {
      this.#warned = true;
      sitemapLog.warn(`sitemap URLs use each request's origin (${origin}): set app.sitemap({ origin }) so crawlers always see the canonical one`);
    }
    let asset: Asset | undefined;
    if (path === ROBOTS_PATH && this.#robots) {
      asset = this.#robotsAssets.get(origin);
      if (!asset) remember(this.#robotsAssets, origin, (asset = makeAsset(robotsText(this.#robots, origin + this.path), "text/plain; charset=utf-8")));
    } else {
      let generation: Generation;
      try {
        generation = await this.#generation(origin);
      } catch (error) {
        sitemapLog.error("generating the sitemap failed", { error });
        return { status: 500, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, body: "Internal Server Error" };
      }
      asset = generation.files.get(path);
      if (!asset) return undefined;
    }
    return respond(req, asset, this.#maxAge);
  }

  /** The cached generation for `origin` while it's fresh, else a new one (shared by requests that arrive while it's built). */
  #generation(origin: string): Promise<Generation> {
    const cached = this.#cache.get(origin);
    if (cached && Date.now() - cached.at < this.#maxAge) return Promise.resolve(cached);
    let building = this.#building.get(origin);
    if (!building) {
      building = (async () => {
        const files = this.#render(await this.entries(origin), origin);
        const assets = new Map<string, Asset>();
        for (const [path, xml] of files) assets.set(path, makeAsset(xml, XML_TYPE));
        const generation: Generation = { at: Date.now(), files: assets };
        // A failure throws before this line: it's never cached, and the next request tries again.
        if (this.#maxAge > 0) remember(this.#cache, origin, generation);
        return generation;
      })().finally(() => this.#building.delete(origin));
      this.#building.set(origin, building);
    }
    return building;
  }

  /**
   * Write the sitemap files (and robots.txt) into a build's client directory,
   * for static hosts and CDNs. Needs `origin`: a build has no request to take
   * one from. Returns the paths written.
   */
  async write(outDir: string): Promise<string[]> {
    if (!this.origin) {
      sitemapLog.info(`no ${this.path} in the build: app.sitemap() has no origin, and a build has no request to take one from`);
      return [];
    }
    const files = await this.files(this.origin);
    for (const [path, text] of files) {
      const target = join(outDir, path.slice(1));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text);
    }
    return [...files.keys()];
  }
}

/** Keep `value` under `key`, forgetting the oldest entry past MAX_ORIGINS. */
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_ORIGINS) map.delete(map.keys().next().value!);
}

function makeAsset(text: string, type: string): Asset {
  const raw = Buffer.from(text);
  // Weak: one validator for the identity, gzip and brotli bytes alike.
  return { type, raw, etag: `W/"${createHash("sha256").update(raw).digest("base64url").slice(0, 16)}"` };
}

/** An asset as a response: 304 for a matching If-None-Match, else br or gzip (compressed once, on first ask) or plain. */
async function respond(req: IncomingMessage, asset: Asset, maxAge: number): Promise<Outgoing> {
  const headers: Record<string, string> = {
    "content-type": asset.type,
    "cache-control": maxAge > 0 ? `public, max-age=${Math.floor(maxAge / 1000)}` : "no-cache",
    etag: asset.etag,
    vary: "accept-encoding",
  };
  const inm = req.headers["if-none-match"];
  if (inm && inm.split(",").some((tag) => tag.trim() === "*" || tag.trim() === asset.etag || `W/${tag.trim()}` === asset.etag)) {
    return { status: 304, headers, body: null };
  }
  const accept = req.headers["accept-encoding"] ?? "";
  if (acceptsEncoding(accept, "br")) {
    return { status: 200, headers: { ...headers, "content-encoding": "br" }, body: await (asset.br ??= compressBrotli(asset.raw)) };
  }
  if (acceptsEncoding(accept, "gzip")) {
    return { status: 200, headers: { ...headers, "content-encoding": "gzip" }, body: await (asset.gzip ??= compressGzip(asset.raw)) };
  }
  return { status: 200, headers, body: asset.raw };
}

/** What a @sitemap method gave back, awaited and drained: an array, any iterable, or an async one. */
async function collect(result: unknown, where: string): Promise<SitemapItem[]> {
  const value = await result;
  const items: SitemapItem[] = [];
  if (value !== null && typeof value === "object" && Symbol.asyncIterator in value) {
    for await (const item of value as AsyncIterable<SitemapItem>) items.push(item);
  } else if (value !== null && typeof value === "object" && Symbol.iterator in value) {
    for (const item of value as Iterable<SitemapItem>) items.push(item);
  } else {
    throw new TypeError(`${where}: the @sitemap method must return or yield entries (an array, a generator, or a promise of one), got ${value === null ? "null" : typeof value}`);
  }
  return items;
}

/** The pattern with its params filled in, each value URL-encoded (a splat's segment by segment). */
function fillPattern(pattern: string, params: Record<string, string | number>, where: string): string {
  const trimmed = pattern.length > 1 && pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  const segments = trimmed === "/" ? [] : trimmed.slice(1).split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment[0] !== ":" && segment[0] !== "*") {
      out.push(segment);
      continue;
    }
    const name = segment.slice(1) || "wildcard";
    const value = params[name];
    if (value === undefined || value === null || (segment[0] === ":" && value === "")) {
      throw new Error(`${where}: an entry is missing param "${name}" for ${pattern}`);
    }
    const text = String(value);
    if (segment[0] === ":") out.push(encodeURIComponent(text));
    else if (text !== "") out.push(...text.split("/").map(encodeURIComponent));
  }
  return `/${out.join("/")}`;
}

/** A lastmod as a W3C datetime: a date-only string stays as it is, anything else becomes ISO 8601 in UTC. */
function lastmodOf(value: Date | string, where: string): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))) return value;
    const time = Date.parse(value);
    if (!Number.isNaN(time)) return new Date(time).toISOString();
  }
  throw new TypeError(`${where}: lastmod ${JSON.stringify(value)} isn't a valid date`);
}

/** An alternate's href: a path on `origin`, or an absolute http(s) URL. */
function absolute(href: string, origin: string, where: string): string {
  if (typeof href === "string" && href.startsWith("/") && !href.startsWith("//")) return origin + href;
  try {
    const url = new URL(href);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch {
    // reported below
  }
  throw new TypeError(`${where}: alternate href ${JSON.stringify(href)} must be a path or an absolute http(s) URL`);
}

function urlElement(entry: SitemapEntry): string {
  let xml = `  <url><loc>${escapeXml(entry.loc)}</loc>`;
  if (entry.lastmod !== undefined) xml += `<lastmod>${escapeXml(entry.lastmod)}</lastmod>`;
  if (entry.changefreq !== undefined) xml += `<changefreq>${entry.changefreq}</changefreq>`;
  if (entry.priority !== undefined) xml += `<priority>${entry.priority}</priority>`;
  for (const alt of entry.alternates ?? []) {
    xml += `<xhtml:link rel="alternate" hreflang="${escapeXml(alt.hreflang)}" href="${escapeXml(alt.href)}"/>`;
  }
  return `${xml}</url>\n`;
}

/** A urlset around rendered url elements, declaring the xhtml namespace only when an alternate needs it. */
function urlset(elements: readonly string[]): string {
  const xhtml = elements.some((e) => e.includes("<xhtml:link ")) ? ` xmlns:xhtml="http://www.w3.org/1999/xhtml"` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${xhtml}>\n${elements.join("")}</urlset>\n`;
}

function robotsText(options: RobotsOptions, sitemapUrl: string): string {
  const lines = [`User-agent: ${options.userAgent ?? "*"}`];
  for (const path of options.allow ?? []) lines.push(`Allow: ${path}`);
  for (const path of options.disallow ?? []) lines.push(`Disallow: ${path}`);
  // An empty Disallow is the protocol's way of saying "everything is allowed".
  if (!options.allow?.length && !options.disallow?.length) lines.push("Disallow:");
  lines.push("", `Sitemap: ${sitemapUrl}`, "");
  return lines.join("\n");
}

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A path glob as a RegExp: `*` is one segment, `**` any depth, and a trailing `/**` covers the prefix itself. */
function globPattern(glob: string): RegExp {
  const source = glob
    .split(/(\/\*\*|\*\*|\*)/)
    .map((token) => (token === "/**" ? "(?:/.*)?" : token === "**" ? ".*" : token === "*" ? "[^/]*" : escapeRegExp(token)))
    .join("");
  return new RegExp(`^${source}$`);
}

/** Plain code-unit order, the same on every machine (localeCompare isn't). */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
