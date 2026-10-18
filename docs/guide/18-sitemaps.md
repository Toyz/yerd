# Sitemaps and robots.txt

Search engines should find every product in the shop. [app.sitemap()](api:yerd.YerdApp.sitemap) serves `/sitemap.xml` built from your routes, and optionally a `/robots.txt` that points at it.

## The shop's sitemap

Paperyard has none yet. It takes two additions: the sitemap, and the products for the route with an `:id`.

```ts
// src/app.ts
export function createApp(options?: YerdOptions) {
  return yerd(options)
    // ...layout, errorPage, sessions, auth
    .sitemap({
      origin: "https://paperyard.example",
      exclude: ["/api/**", "/cart", "/login"],
      robots: { disallow: ["/cart", "/checkout", "/orders"] },
    });
}
```

```tsx
// src/routes/products.tsx
import { sitemap /* , ... */ } from "@toyz/yerd";

@route("/products/:id")
export class ProductPage {
  // ...

  /** Every product, for /sitemap.xml. */
  @sitemap *entries() {
    for (const product of this.catalog.search()) {
      yield { params: { id: String(product.id) }, priority: product.stock > 0 ? 0.8 : 0.3 };
    }
  }
}
```

```answer
GET /sitemap.xml
200 OK
content-type: application/xml; charset=utf-8
cache-control: public, max-age=600
etag: "xjkHjJK5_IcSvBB5"

<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://paperyard.example/</loc></url>
  <url><loc>https://paperyard.example/products/1</loc><priority>0.8</priority></url>
  <url><loc>https://paperyard.example/products/2</loc><priority>0.8</priority></url>
  <!-- ... -->
  <url><loc>https://paperyard.example/products/8</loc><priority>0.3</priority></url>
</urlset>
---
GET /robots.txt
200 OK
content-type: text/plain; charset=utf-8

User-agent: *
Disallow: /cart
Disallow: /checkout
Disallow: /orders

Sitemap: https://paperyard.example/sitemap.xml
```

- The front page is found on its own; `/checkout` (guarded) and the stock feed (a stream) stay out by themselves.
- `/api/products`, `/cart` and `/login` answer a plain GET, so they'd be listed: hence the `exclude`.
- Services resolve in `@sitemap` as in a request, but there is no request: `@param` and friends throw.

| Option | Default | Meaning |
| --- | --- | --- |
| `origin` | each request's origin (`X-Forwarded-*` under `trustProxy`), with a warning in production | what every URL starts with |
| `path` | `/sitemap.xml` | where the sitemap lives |
| `exclude` | `[]` | path globs to leave out: `*` is one segment, `**` any depth; `/api/**` covers `/api` too |
| `maxAge` | `"10m"` | how long a built sitemap is kept (the `max-age=600` above); `0` builds it per request |
| `robots` | off | `true`, or `{ allow, disallow, userAgent }` |
| `defaults` | none | `changefreq` and `priority` for entries that don't set their own |

## What gets listed

A route without params is listed when it has a public GET page.

- It needs a `@get` handler that can answer HTML: not `@sse` or `@ndjson`, not `@accepts("json")` alone.
- Guarded pages stay out: group, class or method guards. Guards from `app.guard()` don't count.
- `/_yerd/*`, the sitemap and robots.txt are never listed.
- URLs come sorted by path, then the entries of routes with params.

A route with params is listed only through `@sitemap` or `@prerender({ paths })`.

### @sitemap entries

- Return an array, a promise of one, or use a generator (async ones too).
- `params` fill the pattern, URL-encoded; a missing one is an error naming the route. `path` gives the whole path instead.
- `lastmod` takes a Date or a string. `"2026-05-01"` stays date-only.
- `alternates: [{ hreflang: "fr", href: "/fr/products/7" }]` adds `xhtml:link` entries.

## Per route

The `sitemap` option of [@route](api:yerd.route) and [@group](api:yerd.group) sets a route's fields or leaves it out, the other way to drop the cart:

```ts
@route("/cart", { sitemap: false, meta: { title: "Your cart" } })
export class CartPage {}

@route("/", { sitemap: { changefreq: "daily", priority: 1 }, meta: { title: "Shop" } })
export class ProductList {}
```

- `false` leaves the route out; on a group, every member route.
- A route's own object lists it even behind guards, or inside a `false` group.
- Settings inherit through groups like `session`: the deepest wins.
- A `priority` outside 0 to 1, or an unknown `changefreq`, throws at decoration.

## Serving

The XML follows sitemaps.org 0.9.

- `application/xml`, compressed with br or gzip, with an ETag and 304s.
- Built once per `maxAge`. A failure is logged, answered with a 500 and not cached.
- Past 50,000 URLs or 50 MB, `path` serves an index and the parts sit beside it: `/sitemap-1.xml`, `/sitemap-2.xml`.
- robots.txt with no rules allows everything (`Disallow:` with no path). It takes over a `/robots.txt` route or static file.

## In a build

`vite build` writes `sitemap.xml` (and `robots.txt`) into `dist/client` for static hosts and CDNs.

- Only with `origin` set (a build has no request to take one from); without it the build log says so.
- The running server still answers these paths itself.

## Testing

[app.sitemapEntries()](api:yerd.YerdApp.sitemapEntries) returns the entries with absolute URLs.

```ts
const entries = await app.sitemapEntries();
expect(entries.map((e) => e.loc)).toContain("https://paperyard.example/products/7");
```

- Pass an origin when `app.sitemap()` has none: `app.sitemapEntries("http://localhost:3000")`.
- Use it to write the file yourself, too.
