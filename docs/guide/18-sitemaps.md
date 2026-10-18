# Sitemaps and robots.txt

[app.sitemap()](api:yerd.YerdApp.sitemap) serves `/sitemap.xml` built from your routes, and optionally a `/robots.txt` that points at it.

```ts
yerd().sitemap({
  origin: "https://shop.example",
  exclude: ["/api/**"],
  robots: { disallow: ["/admin"] },
});
```

- `origin`: what every URL starts with. Without it, each request's own origin is used (`X-Forwarded-*` under `trustProxy`), and production logs a warning.
- `path`: where the sitemap lives. Default `/sitemap.xml`.
- `exclude`: path globs to leave out. `*` is one segment, `**` any depth; `/api/**` covers `/api` too.
- `maxAge`: how long a generated sitemap is kept in memory, e.g. `"1h"`. Default `"10m"`; `0` builds it per request.
- `robots`: `true`, or `{ allow, disallow, userAgent }`. Off by default.
- `defaults`: `changefreq` and `priority` for entries that don't set their own.

## What gets listed

A route without params is listed when it has a public GET page.

- It needs a `@get` handler that can answer HTML: not `@sse` or `@ndjson`, not `@accepts("json")` alone.
- Guarded pages stay out: group, class or method guards. Guards from `app.guard()` don't count.
- `/_yerd/*`, the sitemap and robots.txt are never listed.
- URLs come out sorted by path, then the entries of routes with params.

A route with params is listed only through `@sitemap` or `@prerender({ paths })`. Otherwise it's skipped.

## Per route

The `sitemap` option of [@route](api:yerd.route) and [@group](api:yerd.group) sets a route's fields, or leaves it out.

```ts
@route("/pricing", { sitemap: { changefreq: "monthly", priority: 0.9 } })
class Pricing {
  @get page() { return <PricingTable />; }
}

@group("/account", { sitemap: false })
class Account {}
```

- `false` leaves the route out; on a group, every member route.
- A route's own object lists it even behind guards, or inside a `false` group.
- Settings inherit through groups like `session`: the deepest wins.
- A `priority` outside 0 to 1, or an unknown `changefreq`, throws at decoration.

## Routes with params

Put [@sitemap](api:yerd.sitemap) on a method of the route class that returns its entries.

```tsx
@route("/products/:slug")
class ProductPage {
  @inject(Catalog) accessor catalog!: Catalog;
  @param("slug") accessor slug!: string;

  @get page() { return <Product slug={this.slug} />; }

  @sitemap *entries() {
    for (const p of this.catalog.all()) {
      yield { params: { slug: p.slug }, lastmod: p.updatedAt, priority: 0.8 };
    }
  }
}
```

- Return an array, a promise of one, or use a generator (async ones too).
- Services resolve as in a request, scoped ones included. There is no request, so `@param` and friends throw.
- `params` fill the pattern, URL-encoded; a missing one is an error naming the route. `path` gives the whole path instead.
- `lastmod` takes a Date or a string. `"2026-05-01"` stays date-only.
- `alternates: [{ hreflang: "fr", href: "/fr/products/gnome" }]` adds `xhtml:link` entries.

## Serving

The XML follows sitemaps.org 0.9.

- `application/xml`, compressed with br or gzip, with an ETag and 304s.
- Generated once per `maxAge`. A failure is logged, answered with a 500 and not cached.
- Past 50,000 URLs or 50 MB, `path` serves an index and the parts sit beside it: `/sitemap-1.xml`, `/sitemap-2.xml`.

## robots.txt

With `robots`, `/robots.txt` lists your rules and the sitemap.

```ts
yerd().sitemap({ origin: "https://shop.example", robots: { disallow: ["/admin", "/cart"] } });
```

```
User-agent: *
Disallow: /admin
Disallow: /cart

Sitemap: https://shop.example/sitemap.xml
```

- With no rules, it allows everything (`Disallow:` with no path).
- It takes over a `/robots.txt` route or static file.

## In a build

`vite build` writes `sitemap.xml` (and `robots.txt`) into `dist/client` for static hosts and CDNs.

- Only with `origin` set: a build has no request to take one from. Without it the build log says so.
- The running server still answers these paths itself.

## Testing

[app.sitemapEntries()](api:yerd.YerdApp.sitemapEntries) returns the entries with absolute URLs.

```ts
const entries = await app.sitemapEntries();
expect(entries.map((e) => e.loc)).toContain("https://shop.example/products/disco-gnome");
```

- Pass an origin when `app.sitemap()` has none: `app.sitemapEntries("http://localhost:3000")`.
- Use it to write the file yourself, too.
