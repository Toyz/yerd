import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import {
  ILogger, accepts, createGuard, get, group, guards, inject, ndjson, onBoot, param, post, prerender, resolve, route, service, sitemap, sse, yerd,
  type LogRecord, type SitemapOptions,
} from "@toyz/yerd";
import { SITEMAP_LIMITS } from "../../src/seo/sitemap.js";

const ORIGIN = "https://shop.example";
const signedIn = createGuard("signedIn", () => false);

function app(routes: Function[], options: SitemapOptions = { origin: ORIGIN }, services: Function[] = []) {
  return yerd({ routes, services, handleSignals: false }).sitemap(options);
}

async function locs(routes: Function[], options?: SitemapOptions, services?: Function[]): Promise<string[]> {
  return (await app(routes, options, services).sitemapEntries()).map((e) => e.loc.slice(ORIGIN.length));
}

describe("which routes are listed", () => {
  it("lists public GET pages without params, sorted by path", async () => {
    @route("/") class Home { @get page() { return <h1>home</h1>; } }
    @route("/about") class About { @get page() { return <p>about</p>; } }
    @route("/catalog") class Catalog {
      @get page() { return <p>catalog</p>; }
      @get @accepts("json") data() { return []; }
    }
    @route("/submit") class Submit { @post send() { return 204; } }
    @route("/u/:id") class User { @param("id") accessor id!: string; @get page() { return <p />; } }
    expect(await locs([User, Submit, Catalog, About, Home])).toEqual(["/", "/about", "/catalog"]);
  });

  it("leaves out guarded pages (class, group, method guards) but not app-wide guards", async () => {
    @guards(signedIn) @route("/account") class Account { @get page() { return <p />; } }
    @group("/members", { guards: [signedIn] }) class Members {}
    @route("/feed", { group: Members }) class Feed { @get page() { return <p />; } }
    @route("/inbox") class Inbox { @get @guards(signedIn) page() { return <p />; } }
    @route("/settings", { guards: [signedIn] }) class Settings { @get page() { return <p />; } }
    @route("/open") class Open { @get page() { return <p />; } }
    const everywhere = createGuard("everywhere", () => true);
    const entries = await yerd({ routes: [Account, Feed, Inbox, Settings, Open], services: [], handleSignals: false })
      .guard(everywhere)
      .sitemap({ origin: ORIGIN })
      .sitemapEntries();
    expect(entries.map((e) => e.loc)).toEqual([`${ORIGIN}/open`]);
  });

  it("lists a guarded route that sets its own sitemap object", async () => {
    @route("/pro", { guards: [signedIn], sitemap: { priority: 0.3 } }) class Pro { @get page() { return <p />; } }
    expect(await app([Pro]).sitemapEntries()).toEqual([{ loc: `${ORIGIN}/pro`, priority: 0.3 }]);
  });

  it("leaves out streams and JSON-only handlers", async () => {
    @route("/events") class Events { @get @sse async *feed() { yield 1; } }
    @route("/rows") class Rows { @get @ndjson({ heartbeat: 1000 }) async *rows() { yield 1; } }
    @route("/data") class Data { @get @accepts("json") data() { return {}; } }
    @route("/page") class Page { @get page() { return <p />; } }
    expect(await locs([Events, Rows, Data, Page])).toEqual(["/page"]);
  });

  it("honours sitemap: false on routes and groups, and a route's own object inside a false group", async () => {
    @route("/checkout", { sitemap: false }) class Checkout { @get page() { return <p />; } }
    @group("/auth", { sitemap: false }) class Auth {}
    @route("/login", { group: Auth }) class Login { @get page() { return <p />; } }
    @route("/signup", { group: Auth, sitemap: { changefreq: "yearly" } }) class Signup { @get page() { return <p />; } }
    @group("/docs", { sitemap: { changefreq: "weekly", priority: 0.4 } }) class Docs {}
    @group("/v2", { group: Docs, sitemap: { priority: 0.6 } }) class V2 {}
    @route("/intro", { group: V2 }) class Intro { @get page() { return <p />; } }
    expect(await app([Checkout, Login, Signup, Intro]).sitemapEntries()).toEqual([
      { loc: `${ORIGIN}/auth/signup`, changefreq: "yearly" },
      { loc: `${ORIGIN}/docs/v2/intro`, changefreq: "weekly", priority: 0.6 },
    ]);
  });

  it("applies the app's exclude globs and never lists built-in or sitemap paths", async () => {
    @route("/api/items") class Items { @get page() { return <p />; } }
    @route("/api") class Api { @get page() { return <p />; } }
    @route("/admin/users") class Users { @get page() { return <p />; } }
    @route("/admin/users/new") class NewUser { @get page() { return <p />; } }
    @route("/_yerd/custom") class Custom { @get page() { return <p />; } }
    @route("/robots.txt") class Robots { @get page() { return <p />; } }
    @route("/sitemap.xml") class Own { @get page() { return <p />; } }
    @route("/kept") class Kept { @get page() { return <p />; } }
    const listed = await locs([Items, Api, Users, NewUser, Custom, Robots, Own, Kept], { origin: ORIGIN, exclude: ["/api/**", "/admin/*"], robots: true });
    expect(listed).toEqual(["/admin/users/new", "/kept"]);
  });

  it("applies app defaults under route settings", async () => {
    @route("/a", { sitemap: { priority: 0.9 } }) class A { @get page() { return <p />; } }
    @route("/b") class B { @get page() { return <p />; } }
    expect(await app([A, B], { origin: ORIGIN, defaults: { changefreq: "daily", priority: 0.5 } }).sitemapEntries()).toEqual([
      { loc: `${ORIGIN}/a`, changefreq: "daily", priority: 0.9 },
      { loc: `${ORIGIN}/b`, changefreq: "daily", priority: 0.5 },
    ]);
  });
});

describe("@sitemap", () => {
  it("takes a generator, an async generator, an array or a promise, after the static pages", async () => {
    @route("/g/:id") class Gen { @get page() { return <p />; } @sitemap *entries() { yield { params: { id: "1" } }; yield { params: { id: "2" } }; } }
    @route("/a/:id") class Async { @get page() { return <p />; } @sitemap async *entries() { yield { params: { id: "x" } }; } }
    @route("/l/:id") class List { @get page() { return <p />; } @sitemap entries() { return [{ params: { id: "y" } }]; } }
    @route("/p/:id") class Later { @get page() { return <p />; } @sitemap async entries() { return [{ params: { id: "z" } }]; } }
    @route("/z") class Static { @get page() { return <p />; } }
    expect(await locs([Gen, Async, List, Later, Static])).toEqual(["/z", "/a/x", "/g/1", "/g/2", "/l/y", "/p/z"]);
  });

  it("runs with services: singletons and scoped ones, disposed afterwards", async () => {
    let disposed = 0;
    @service({ lifetime: "singleton" }) class Slugs { all() { return ["one", "two"]; } }
    @service({ lifetime: "scoped" }) class Db {
      readonly prefix = "db";
      [Symbol.dispose]() { disposed++; }
    }
    @route("/items/:slug")
    class Item {
      @inject(Slugs) accessor slugs!: Slugs;
      @inject(Db) accessor db!: Db;
      @get page() { return <p />; }
      @sitemap entries() {
        return this.slugs.all().map((slug) => ({ params: { slug: `${this.db.prefix}-${slug}` } }));
      }
    }
    expect(await locs([Item], undefined, [Slugs, Db])).toEqual(["/items/db-one", "/items/db-two"]);
    expect(disposed).toBe(1);
  });

  it("encodes params, splats segment by segment, and takes a path as given", async () => {
    @route("/p/:slug/*rest") class P {
      @get page() { return <p />; }
      @sitemap entries() {
        return [{ params: { slug: "a b/c", rest: "x/y z" } }, { path: "/elsewhere?x=1" }];
      }
    }
    expect(await locs([P])).toEqual(["/p/a%20b%2Fc/x/y%20z", "/elsewhere?x=1"]);
  });

  it("a missing param names the route", async () => {
    @route("/m/:slug") class Missing { @get page() { return <p />; } @sitemap entries() { return [{ params: {} }]; } }
    await expect(app([Missing]).sitemapEntries()).rejects.toThrow('@sitemap Missing: an entry is missing param "slug" for /m/:slug');
  });

  it("checks entry fields at generation, naming the route", async () => {
    @route("/x/:id") class Bad { @get page() { return <p />; } @sitemap entries() { return [{ params: { id: "1" }, priority: 3 }]; } }
    await expect(app([Bad]).sitemapEntries()).rejects.toThrow("@sitemap Bad: priority must be a number from 0 to 1 (got 3)");
    @route("/y/:id") class Freq { @get page() { return <p />; } @sitemap entries() { return [{ params: { id: "1" }, changefreq: "sometimes" as never }]; } }
    await expect(app([Freq]).sitemapEntries()).rejects.toThrow(/@sitemap Freq: changefreq "sometimes" isn't one of always/);
    @route("/w/:id") class When { @get page() { return <p />; } @sitemap entries() { return [{ params: { id: "1" }, lastmod: "soon" }]; } }
    await expect(app([When]).sitemapEntries()).rejects.toThrow('@sitemap When: lastmod "soon" isn\'t a valid date');
    @route("/v/:id") class Nothing { @get page() { return <p />; } @sitemap entries() { return 5 as never; } }
    await expect(app([Nothing]).sitemapEntries()).rejects.toThrow(/@sitemap Nothing: the @sitemap method must return or yield entries/);
  });

  it("falls back to @prerender paths, and skips a param route with neither", async () => {
    @prerender({ paths: ["/docs/b", "/docs/a"] }) @route("/docs/:slug") class Doc { @param("slug") accessor slug!: string; @get page() { return <p />; } }
    @service({ lifetime: "singleton" }) class Posts { slugs() { return ["hello"]; } }
    @prerender({ paths: () => resolve(Posts).slugs().map((s) => `/blog/${s}`) }) @route("/blog/:slug") class Post { @get page() { return <p />; } }
    @route("/plain/:id") class Plain { @get page() { return <p />; } }
    expect(await locs([Doc, Post, Plain], undefined, [Posts])).toEqual(["/blog/hello", "/docs/b", "/docs/a"]);
  });

  it("refuses bad fields and a second @sitemap at decoration time", () => {
    expect(() => route("/r", { sitemap: { priority: 1.5 } })).toThrow(TypeError);
    expect(() => route("/r", { sitemap: { changefreq: "often" as never } })).toThrow('@route /r { sitemap }: changefreq "often" isn\'t one of always, hourly, daily, weekly, monthly, yearly, never');
    expect(() => group("/g", { sitemap: { priority: -0.1 } })).toThrow("@group /g { sitemap }: priority must be a number from 0 to 1 (got -0.1)");
    expect(() => {
      class Twice { @sitemap a() { return []; } @sitemap b() { return []; } }
      return Twice;
    }).toThrow("@sitemap: b is a second @sitemap method on its class (one per route class)");
  });

  it("refuses bad app options", () => {
    expect(() => yerd().sitemap({ origin: "shop.example" })).toThrow(/isn't a URL/);
    expect(() => yerd().sitemap({ origin: "https://shop.example/store" })).toThrow(/must be an http\(s\) origin/);
    expect(() => yerd().sitemap({ path: "sitemap.xml" })).toThrow(/must be a plain path/);
    expect(() => yerd().sitemap({ exclude: ["api/**"] })).toThrow(/must be a path glob/);
    expect(() => yerd().sitemap({ maxAge: "soon" })).toThrow(/Invalid duration/);
    expect(() => yerd().sitemap({ defaults: { priority: 2 } })).toThrow(/priority must be a number/);
    expect(() => yerd().sitemap({ robots: { disallow: ["/a\nSitemap: x"] } })).toThrow(/on one line/);
  });
});

describe("the XML", () => {
  async function xml(routes: Function[], options: SitemapOptions = { origin: ORIGIN }) {
    const res = await app(routes, options).request("/sitemap.xml");
    expect(res.status).toBe(200);
    return res.text();
  }

  it("is a sitemaps.org urlset with escaped values and the fields set", async () => {
    @route("/q/:name") class Q {
      @get page() { return <p />; }
      @sitemap entries() {
        return [
          { params: { name: "it's" }, lastmod: "2026-05-01", changefreq: "weekly" as const, priority: 0.8 },
          { path: "/s?a=1&b=<2>", lastmod: new Date(Date.UTC(2026, 4, 2, 3, 4, 5)) },
          { path: "/t", lastmod: "2026-05-01T10:00:00+02:00" },
        ];
      }
    }
    expect(await xml([Q])).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        `  <url><loc>${ORIGIN}/q/it&apos;s</loc><lastmod>2026-05-01</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>\n` +
        `  <url><loc>${ORIGIN}/s?a=1&amp;b=&lt;2&gt;</loc><lastmod>2026-05-02T03:04:05.000Z</lastmod></url>\n` +
        `  <url><loc>${ORIGIN}/t</loc><lastmod>2026-05-01T08:00:00.000Z</lastmod></url>\n` +
        `</urlset>\n`,
    );
  });

  it("declares the xhtml namespace only when an entry has alternates", async () => {
    @route("/en/:slug") class En {
      @get page() { return <p />; }
      @sitemap entries() {
        return [{ params: { slug: "a" }, alternates: [{ hreflang: "fr", href: "/fr/a" }, { hreflang: "de", href: "https://de.example/a?x&y" }] }];
      }
    }
    @route("/plain") class Plain { @get page() { return <p />; } }
    const body = await xml([En, Plain]);
    expect(body).toContain(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">`);
    expect(body).toContain(`<xhtml:link rel="alternate" hreflang="fr" href="${ORIGIN}/fr/a"/><xhtml:link rel="alternate" hreflang="de" href="https://de.example/a?x&amp;y"/>`);
    expect(await xml([Plain])).not.toContain("xmlns:xhtml");
  });

  describe("past the limits", () => {
    const saved = { ...SITEMAP_LIMITS };
    afterEach(() => Object.assign(SITEMAP_LIMITS, saved));

    @route("/n/:i") class Many {
      @get page() { return <p />; }
      @sitemap *entries() { for (let i = 1; i <= 5; i++) yield { params: { i: String(i) } }; }
    }

    it("serves an index at the path and the parts beside it", async () => {
      SITEMAP_LIMITS.urls = 2;
      const site = app([Many], { origin: ORIGIN, path: "/maps/site.xml" });
      const index = await (await site.request("/maps/site.xml")).text();
      expect(index).toBe(
        `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
          [1, 2, 3].map((n) => `  <sitemap><loc>${ORIGIN}/maps/site-${n}.xml</loc></sitemap>\n`).join("") +
          `</sitemapindex>\n`,
      );
      const part3 = await site.request("/maps/site-3.xml");
      expect(part3.headers.get("content-type")).toBe("application/xml; charset=utf-8");
      expect(await part3.text()).toContain(`<loc>${ORIGIN}/n/5</loc>`);
      expect(await (await site.request("/maps/site-1.xml")).text()).toMatch(/\/n\/1<\/loc>.*\n.*\/n\/2<\/loc>/);
      expect((await site.request("/maps/site-4.xml")).status).toBe(404);
    });

    it("splits by size too", async () => {
      SITEMAP_LIMITS.bytes = 256 + 2 * Buffer.byteLength(`  <url><loc>${ORIGIN}/n/1</loc></url>\n`);
      const index = await (await app([Many]).request("/sitemap.xml")).text();
      expect(index).toContain(`<loc>${ORIGIN}/sitemap-3.xml</loc>`);
      expect(index).not.toContain("sitemap-4.xml");
    });
  });
});

describe("serving", () => {
  @route("/") class Home { @get page() { return <p />; } }

  it("compresses by Accept-Encoding, with an ETag, 304 and HEAD", async () => {
    const site = app([Home]);
    const plain = await site.request("/sitemap.xml", { headers: { "accept-encoding": "identity" } });
    const text = await plain.text();
    expect(plain.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(plain.headers.get("vary")).toBe("accept-encoding");
    expect(plain.headers.get("cache-control")).toBe("public, max-age=600");
    const etag = plain.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"[\w-]{16}"$/);

    const br = await site.request("/sitemap.xml", { headers: { "accept-encoding": "br, gzip" } });
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString()).toBe(text);
    const gz = await site.request("/sitemap.xml", { headers: { "accept-encoding": "gzip" } });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString()).toBe(text);

    const again = await site.request("/sitemap.xml", { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");

    const head = await site.request("/sitemap.xml", { method: "HEAD", headers: { "accept-encoding": "identity" } });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(text)));
    expect(await head.text()).toBe("");
  });

  it("caches for maxAge, and doesn't cache a failure", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let calls = 0;
      @route("/c/:id") class Counted {
        @get page() { return <p />; }
        @sitemap entries() {
          calls++;
          if (calls === 1) throw new Error("db down");
          return [{ params: { id: String(calls) } }];
        }
      }
      const records: LogRecord[] = [];
      const site = app([Counted], { origin: ORIGIN, maxAge: "1m" }).services((s) => s.value(ILogger, { write: (r) => records.push(r) }));
      expect((await site.request("/sitemap.xml")).status).toBe(500);
      expect(records.map((r) => r.message)).toEqual(["generating the sitemap failed"]);
      expect(await (await site.request("/sitemap.xml")).text()).toContain("/c/2<");
      vi.advanceTimersByTime(59_000);
      expect(await (await site.request("/sitemap.xml")).text()).toContain("/c/2<");
      vi.advanceTimersByTime(2_000);
      expect(await (await site.request("/sitemap.xml")).text()).toContain("/c/3<");
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maxAge 0 builds it per request", async () => {
    let calls = 0;
    @route("/d/:id") class Counted { @get page() { return <p />; } @sitemap entries() { return [{ params: { id: String(++calls) } }]; } }
    const site = app([Counted], { origin: ORIGIN, maxAge: 0 });
    await site.request("/sitemap.xml");
    const res = await site.request("/sitemap.xml");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain("/d/2<");
  });

  it("takes the origin from the option, else from the request (forwarded headers only under trustProxy)", async () => {
    expect(await (await app([Home]).request("http://other.example/sitemap.xml")).text()).toContain(`<loc>${ORIGIN}/</loc>`);
    const headers = { "x-forwarded-host": "proxied.example", "x-forwarded-proto": "https" };
    const direct = yerd({ routes: [Home], services: [], handleSignals: false }).sitemap();
    expect(await (await direct.request("http://local.example:8080/sitemap.xml", { headers })).text()).toContain("<loc>http://local.example:8080/</loc>");
    const proxied = yerd({ routes: [Home], services: [], handleSignals: false, trustProxy: true }).sitemap();
    expect(await (await proxied.request("http://local.example:8080/sitemap.xml", { headers })).text()).toContain("<loc>https://proxied.example/</loc>");
  });

  it("warns once in production when there's no origin", async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const records: LogRecord[] = [];
      const site = yerd({ routes: [Home], services: [], handleSignals: false })
        .sitemap()
        .services((s) => s.value(ILogger, { write: (r) => records.push(r) }));
      await site.request("/sitemap.xml");
      await site.request("/sitemap.xml");
      const warnings = records.filter((r) => r.target === "yerd::sitemap" && r.level === "warn");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.message).toContain("set app.sitemap({ origin })");
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  it("serves robots.txt only when asked", async () => {
    expect(await (await app([Home], { origin: ORIGIN, robots: true }).request("/robots.txt")).text()).toBe(
      `User-agent: *\nDisallow:\n\nSitemap: ${ORIGIN}/sitemap.xml\n`,
    );
    const custom = app([Home], { origin: ORIGIN, path: "/map.xml", robots: { userAgent: "Googlebot", allow: ["/admin/help"], disallow: ["/admin"] } });
    const res = await custom.request("/robots.txt");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe(`User-agent: Googlebot\nAllow: /admin/help\nDisallow: /admin\n\nSitemap: ${ORIGIN}/map.xml\n`);
    expect((await app([Home]).request("/robots.txt")).status).toBe(404);
  });

  it("sitemapEntries() needs app.sitemap() and an origin", async () => {
    await expect(yerd({ routes: [Home], services: [] }).sitemapEntries()).rejects.toThrow("sitemapEntries() needs app.sitemap() first");
    const site = yerd({ routes: [Home], services: [] }).sitemap();
    await expect(site.sitemapEntries()).rejects.toThrow(/needs an origin/);
    expect(await site.sitemapEntries("http://localhost:3000/ignored")).toEqual([{ loc: "http://localhost:3000/" }]);
  });
});

describe("the build", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  function outDir() {
    const dir = mkdtempSync(join(tmpdir(), "yerd-sitemap-"));
    dirs.push(dir);
    return dir;
  }
  @route("/") class Home { @get page() { return <p />; } }

  it("writes sitemap.xml and robots.txt when there's an origin", async () => {
    @prerender @route("/about") class About { @get page() { return <p>about</p>; } }
    const dir = outDir();
    const written = await app([Home, About], { origin: ORIGIN, robots: true }).prerender(dir);
    expect(written).toEqual(["/about", "/sitemap.xml", "/robots.txt"]);
    expect(readFileSync(join(dir, "sitemap.xml"), "utf8")).toContain(`<loc>${ORIGIN}/about</loc>`);
    expect(readFileSync(join(dir, "robots.txt"), "utf8")).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });

  it("generates with the app started, so @onBoot data is there, even with nothing to prerender", async () => {
    @service({ lifetime: "singleton" }) class Stock {
      slugs: string[] = [];
      @onBoot fill() { this.slugs = ["gnome"]; }
    }
    @route("/s/:slug") class Item {
      @inject(Stock) accessor stock!: Stock;
      @get page() { return <p />; }
      @sitemap entries() { return this.stock.slugs.map((slug) => ({ params: { slug } })); }
    }
    const dir = outDir();
    expect(await app([Item], { origin: ORIGIN }, [Stock]).prerender(dir)).toEqual(["/sitemap.xml"]);
    expect(readFileSync(join(dir, "sitemap.xml"), "utf8")).toContain(`<loc>${ORIGIN}/s/gnome</loc>`);
    expect(existsSync(join(dir, ".yerd", "prerendered.json"))).toBe(false);
  });

  it("writes nothing without an origin, and says so", async () => {
    const records: LogRecord[] = [];
    const dir = outDir();
    const site = yerd({ routes: [Home], services: [], handleSignals: false })
      .sitemap({ robots: true })
      .logging({ filter: "info" })
      .services((s) => s.value(ILogger, { write: (r) => records.push(r) }));
    expect(await site.prerender(dir)).toEqual([]);
    expect(existsSync(join(dir, "sitemap.xml"))).toBe(false);
    expect(records.some((r) => r.target === "yerd::sitemap" && r.message.includes("has no origin"))).toBe(true);
  });
});
