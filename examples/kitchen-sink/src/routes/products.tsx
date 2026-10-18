import {
  NotFound, Unauthorized, YerdError, accepts, action, currentContext, field, file, get, inject, isBot, json, negotiate, param, post, redirect, route, session, setMeta, toInt, between, trim, length, type Session,
} from "@toyz/yerd";
import { Ago, Price, formatMoney } from "../attributes.js";
import { CATEGORIES, Catalog, imageUrl, type Product } from "../catalog.js";
import { ProductImage, ProductSlider, Stock, Toast } from "../components.js";
import { CartBadge } from "../layouts.js";
import { auth, type User } from "../users.js";
import { Viewer } from "../viewer.js";
import { Shop } from "./shop.js";

/** A product's absolute URL (for canonical links and JSON-LD). Set PUBLIC_URL behind a TLS proxy. */
function absolute(path: string): string {
  return new URL(path, process.env.PUBLIC_URL ?? currentContext().url.origin).href;
}

/** schema.org data for search engines, embedded with json() so a "</script>" in a name can't break out. */
function ProductJsonLd({ product }: { product: Product }) {
  const data = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: product.description,
    image: absolute(imageUrl(product, 640)),
    category: CATEGORIES[product.category].name,
    offers: {
      "@type": "Offer",
      price: (product.priceCents / 100).toFixed(2),
      priceCurrency: "USD",
      availability: product.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
    },
  };
  return <script type="application/ld+json">{json(data)}</script>;
}

/**
 * The whole catalog as a table, in three representations from one URL:
 * HTML for browsers, CSV for spreadsheets (`negotiate()` in the default
 * handler) and JSON for scripts (a second handler with `@accepts`).
 *
 * ```sh
 * curl -H 'accept: text/csv' localhost:3300/products
 * curl -H 'accept: application/json' localhost:3300/products
 * ```
 */
@route("/products", { group: Shop, meta: { title: "Catalog", area: "catalog" } })
export class ProductList {
  @inject(Catalog) accessor catalog!: Catalog;

  @get page() {
    const products = this.catalog.all();
    return negotiate({
      html: () => (
        <>
          <h1 class="page-title">The full catalog</h1>
          <p class="meta-line">
            Also as <code>text/csv</code> and <code>application/json</code> (send an Accept header), or{" "}
            <a href="/api/products.ndjson" download>download it as NDJSON</a>.
          </p>
          <table class="table">
            <thead>
              <tr><th>Item</th><th>Aisle</th><th>Price</th><th>Stock</th></tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr>
                  <td><a href={`/products/${p.slug}`} prefetch="visible">{p.name}</a></td>
                  <td>{CATEGORIES[p.category].name}</td>
                  <td><Price cents={p.priceCents} /></td>
                  <td><Stock stock={p.stock} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ),
      csv: () => {
        const cell = (value: string | number) => (typeof value === "number" ? String(value) : `"${value.replace(/"/g, '""')}"`);
        const rows = products.map((p) => [p.id, p.name, p.category, (p.priceCents / 100).toFixed(2), p.stock].map(cell).join(","));
        return ["id,name,category,price,stock", ...rows].join("\n") + "\n";
      },
    });
  }

  @get @accepts("json") data() {
    return { products: this.catalog.all().map(({ id, slug, name, category, priceCents, stock }) => ({ id, slug, name, category, priceCents, stock })) };
  }
}

/**
 * One product. People get the interactive page; crawlers and link unfurlers
 * (`@get(isBot)`) get a complete, script-free document. isBot reads the
 * User-Agent, so both answers carry `Vary: User-Agent`.
 *
 * Reviews are a plain multipart POST (`@post` with `@field` / `@file`
 * accessors), not an action: the page posts to itself and redirects back.
 */
@route("/products/:slug", { group: Shop, meta: { area: "shop" } })
export class ProductPage {
  @inject(Catalog) accessor catalog!: Catalog;
  @inject(Viewer) accessor viewer!: Viewer;
  @auth.maybeUser accessor me: User | undefined;
  @param("slug") accessor slug!: string;
  @session accessor session!: Session<{ reviewError?: string }>;

  @field("rating", { transform: toInt, validate: between(1, 5), required: true }) accessor rating!: Promise<number>;
  @field("text", { transform: trim, validate: length(3, 500), required: true }) accessor text!: Promise<string>;
  @file("photo", { types: ["image/*"], maxSize: 1_000_000 }) accessor photo!: Promise<File | undefined>;

  #product(): Product {
    const product = this.catalog.bySlug(this.slug);
    if (!product) throw new NotFound("We looked under every rock. It isn't here.");
    return product;
  }

  #describe(product: Product) {
    setMeta({
      title: product.name,
      description: `${formatMoney(product.priceCents)}. ${product.description}`,
      url: absolute(`/products/${product.slug}`),
      image: absolute(imageUrl(product, 640)),
    });
  }

  @get page() {
    const product = this.#product();
    this.#describe(product);
    // Remember it for "Recently viewed" on the shop page (read there with @cookie).
    const ctx = currentContext();
    const recent = [product.slug, ...(ctx.cookies.recent ?? "").split(",").filter((s) => s && s !== product.slug)].slice(0, 4);
    ctx.setCookie("recent", recent.join(","), { maxAge: 60 * 60 * 24 * 30 });
    const reviews = this.catalog.reviews(product.id);
    const error = this.session.flash("reviewError") as string | undefined;
    return (
      <>
        <ProductJsonLd product={product} />
        <a class="back" href="/">Back to the shop</a>
        <article class="product-page">
          <ProductSlider product={product} />
          <div class="product-info">
            <p class="category">{CATEGORIES[product.category].name}</p>
            <h1>{product.name}</h1>
            <Price cents={product.priceCents} class="price-big" />
            <p>{product.description}</p>
            <Stock stock={product.stock} />
            <form action={() => this.addToCart({ id: product.id })}>
              <button class="btn" disabled={product.stock === 0} confetti>Add to cart</button>
            </form>
            <Toast />
            {/* Keyed and kept: a morph leaves the upgraded element alone, and another product gets a fresh one. */}
            <share-link key={product.slug} data-yx-keep url={absolute(`/products/${product.slug}`)} name={product.name}>
              <a href={absolute(`/products/${product.slug}`)}>Link to this gnome</a>
            </share-link>
            <p class="muted small">
              Embed it on your own site: <a href={`/products/${product.slug}/embed`}>/products/{product.slug}/embed</a>
            </p>
          </div>
        </article>

        <section class="reviews">
          <h2>Reviews ({reviews.length})</h2>
          {reviews.length === 0 ? <p class="muted">No reviews yet. Be the first to have opinions.</p> : null}
          <ul>
            {reviews.map((r) => (
              <li class="review">
                <strong>@{r.author}</strong> <span class="stars" aria-label={`${r.rating} out of 5`}>{"*".repeat(r.rating)}</span> <Ago iso={r.createdAt} />
                <p>{r.text}</p>
                {r.hasPhoto ? <img src={`/img/reviews/${r.id}`} alt={`Photo from @${r.author}`} width={160} height={120} loading="lazy" decoding="async" class="review-photo" /> : null}
              </li>
            ))}
          </ul>
          {this.me ? (
            <form class="review-form" method="post" enctype="multipart/form-data">
              <h3>Write a review</h3>
              <div class="row">
                <label for="rating">Rating</label>
                <select class="input" id="rating" name="rating">
                  {[5, 4, 3, 2, 1].map((n) => <option value={String(n)}>{n} stars</option>)}
                </select>
              </div>
              <label class="visually-hidden" for="review-text">Your review</label>
              <textarea class="input" id="review-text" name="text" rows={3} required minlength={3} maxlength={500} placeholder="How did it change your yard?"></textarea>
              <label for="review-photo">Photo (optional)</label>
              <input class="input" id="review-photo" type="file" name="photo" accept="image/*" />
              <p class="form-error" role="alert">{error}</p>
              <button class="btn">Post review</button>
            </form>
          ) : (
            <p><a href={`/login?next=/products/${product.slug}`}>Log in</a> to leave a review.</p>
          )}
        </section>
      </>
    );
  }

  /** Crawlers: everything in the HTML, no client runtime, no forms. */
  @get(isBot) crawlable() {
    const product = this.#product();
    this.#describe(product);
    setMeta({ scripts: false });
    return (
      <>
        <ProductJsonLd product={product} />
        <article class="product-page">
          <ProductImage product={product} width={480} eager />
          <div class="product-info">
            <h1>{product.name}</h1>
            <p class="price-big">{formatMoney(product.priceCents)}</p>
            <p>{product.description}</p>
            <p>{product.stock > 0 ? `${product.stock} in stock` : "Sold out"}</p>
            <h2>Reviews</h2>
            {this.catalog.reviews(product.id).map((r) => (
              <blockquote>
                {r.text} (@{r.author}, {r.rating}/5)
              </blockquote>
            ))}
          </div>
        </article>
      </>
    );
  }

  /** The review form: a plain POST, auth checked here because the page itself is public. */
  @post async review() {
    const product = this.#product();
    if (!this.me) throw new Unauthorized("Log in to review");
    try {
      await this.catalog.addReview(product.id, { author: this.me.name, rating: await this.rating, text: await this.text }, await this.photo);
    } catch (error) {
      if (!(error instanceof YerdError) || error.status >= 500) throw error;
      this.session.flash("reviewError", error.message);
    }
    return redirect(`/products/${product.slug}`);
  }

  @action addToCart({ id }: { id: string }) {
    const product = this.catalog.find(id);
    this.viewer.cart.add(product);
    this.viewer.cartChanged();
    return (
      <>
        <CartBadge count={this.viewer.cart.count} />
        <Toast message="Added. It's yours now (pending checkout)." />
      </>
    );
  }
}
