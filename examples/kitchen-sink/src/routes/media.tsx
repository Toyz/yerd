import { HttpError, bare, between, get, inject, noLayout, param, query, res, route, setHeader, toInt } from "@toyz/yerd";
import { formatMoney } from "../attributes.js";
import { Catalog, imageUrl, type CategoryId, type Product } from "../catalog.js";

/** The drawing for each aisle, in a 320x240 box. */
function Art({ category, hue, detail }: { category: CategoryId; hue: number; detail: boolean }) {
  const main = `hsl(${hue} 70% 55%)`;
  const dark = `hsl(${hue} 60% 30%)`;
  switch (category) {
    case "gnomes":
      return (
        <g>
          <path d="M160 30 210 140H110Z" fill={main} />
          <circle cx="160" cy="150" r="30" fill="#f2c9a5" />
          <path d="M126 160q34 70 68 0q-6 40-34 40t-34-40Z" fill="#fff" />
          <circle cx="150" cy="146" r="4" fill="#222" />
          <circle cx="170" cy="146" r="4" fill="#222" />
          {detail ? <path d="M140 60l40 0" stroke={dark} stroke-width="6" stroke-linecap="round" /> : null}
        </g>
      );
    case "flamingos":
      return (
        <g fill="none" stroke-linecap="round">
          <ellipse cx="170" cy="130" rx="55" ry="32" fill={main} />
          <path d="M130 120q-30-40 0-70q20-20 10-40" stroke={main} stroke-width="12" />
          <path d="M160 160v60M180 160l-10 60" stroke={dark} stroke-width="5" />
          <circle cx="138" cy="12" r="10" fill={main} />
        </g>
      );
    case "fountains":
      return (
        <g>
          <ellipse cx="160" cy="170" rx="100" ry="24" fill={dark} />
          <rect x="150" y="90" width="20" height="80" fill={dark} />
          <ellipse cx="160" cy="90" rx="50" ry="12" fill={main} />
          <path d="M160 80q-30-50-60 10M160 80q30-50 60 10" stroke={`hsl(${hue} 80% 75%)`} stroke-width="5" fill="none" />
        </g>
      );
    case "rocks":
      return (
        <g>
          <path d="M70 190q-10-70 50-100q60-30 110 10q50 40 20 90Z" fill={main} />
          <circle cx="140" cy="130" r="16" fill="#fff" />
          <circle cx="190" cy="130" r="16" fill="#fff" />
          <circle cx="144" cy="134" r="7" fill="#222" />
          <circle cx="186" cy="126" r="7" fill="#222" />
        </g>
      );
    case "signs":
      return (
        <g>
          <rect x="152" y="120" width="16" height="100" fill={dark} />
          <rect x="60" y="40" width="200" height="100" rx="8" fill={main} />
          <path d="M90 75h140M90 105h100" stroke="#fff" stroke-width="10" stroke-linecap="round" />
        </g>
      );
  }
}

/**
 * Product images. Uploaded photos are served as they are; otherwise the art
 * is drawn here, as SVG written in TSX (so there are no binary assets in the
 * repo), in three views (`n`: front, side, at night) for the product page's slider. `@noLayout`: an image isn't a page. The `w` query picks the size
 * for srcset, and wider ones get a little more detail.
 */
@route("/img/products/:slug")
export class ProductImageRoute {
  @inject(Catalog) accessor catalog!: Catalog;
  @param("slug") accessor slug!: string;
  @query("w", { transform: toInt, validate: between(32, 2000) }) accessor width = 320;
  @query("n", { transform: toInt, validate: between(0, 9) }) accessor n = 0;

  @get @noLayout @setHeader("cache-control", "public, max-age=3600")
  image() {
    const product = this.catalog.bySlug(this.slug);
    if (!product) throw new HttpError(404, "No such product");
    const photo = this.catalog.photo(product.id, this.n);
    if (photo) return res(photo.bytes, { headers: { "content-type": photo.type } });
    if (product.photos > 0 || this.n > 2) throw new HttpError(404, "No such photo");
    const height = Math.round(this.width * 0.75);
    // Three views of the same drawing: front, side (mirrored), and at night.
    const night = this.n === 2;
    return res(
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240" width={this.width} height={height} role="img" aria-label={product.name}>
        <rect width="320" height="240" fill={night ? `hsl(${product.hue} 40% 16%)` : `hsl(${product.hue} 60% 92%)`} />
        {night ? <path d="M40 30h2v2h-2zM120 50h2v2h-2zM260 24h3v3h-3zM290 70h2v2h-2zM200 40h2v2h-2z" fill="#fff" /> : null}
        <g transform={this.n === 1 ? "translate(320 0) scale(-1 1)" : undefined} opacity={night ? 0.8 : undefined}>
          <Art category={product.category} hue={product.hue} detail={this.width >= 480} />
        </g>
      </svg>,
      { headers: { "content-type": "image/svg+xml; charset=utf-8" } },
    );
  }
}

/** Photos people attached to reviews. */
@route("/img/reviews/:id")
export class ReviewPhotoRoute {
  @inject(Catalog) accessor catalog!: Catalog;
  @param("id") accessor id!: string;

  @get @setHeader("cache-control", "public, max-age=86400") photo() {
    const photo = this.catalog.reviewPhoto(this.id);
    if (!photo) throw new HttpError(404, "No such photo");
    return res(photo.bytes, { headers: { "content-type": photo.type } });
  }
}

/**
 * A product card to paste into other sites in an iframe: `bare()` HTML, no
 * layouts (so no stylesheet link and no runtime), styled inline.
 */
@route("/products/:slug/embed")
export class ProductEmbed {
  @inject(Catalog) accessor catalog!: Catalog;
  @param("slug") accessor slug!: string;

  @get card() {
    const product: Product | undefined = this.catalog.bySlug(this.slug);
    if (!product) throw new HttpError(404, "No such product");
    return bare(
      <div class="yerd-bazaar-embed">
        <style>{".yerd-bazaar-embed{font:14px system-ui;display:flex;gap:12px;align-items:center;padding:12px;border:1px solid #ddd;border-radius:12px;max-width:360px} .yerd-bazaar-embed img{border-radius:8px}"}</style>
        <img src={imageUrl(product, 96)} alt="" width={96} height={72} />
        <div>
          <strong>{product.name}</strong>
          <div>{formatMoney(product.priceCents)}</div>
          <a href={`/products/${product.slug}`} target="_top">See it at Yerd Bazaar</a>
        </div>
      </div>,
    );
  }
}
