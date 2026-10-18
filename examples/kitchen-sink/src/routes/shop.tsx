import { action, assetUrl, cookie, get, group, inject, oneOf, query, route, trim } from "@toyz/yerd";
import { Catalog, CATEGORIES, CATEGORY_IDS, type CategoryId } from "../catalog.js";
import { Collapsible, More, ProductGrid, ProductImage, ResultCount, Toast } from "../components.js";
import { CartBadge, ShopShell } from "../layouts.js";
import { Viewer } from "../viewer.js";

/** Every customer-facing page: the shop shell around it. Prefix "/" so member routes keep their own paths. */
@group("/", { layout: ShopShell })
export class Shop {}

const PAGE_SIZE = 12;

/** What the search box and category select narrow the shelf to. */
interface Filters {
  q: string;
  category: string;
}

@route("/", { group: Shop, meta: { title: "Shop", area: "shop" } })
export class ShopPage {
  @inject(Catalog) accessor catalog!: Catalog;
  @inject(Viewer) accessor viewer!: Viewer;
  /** The same filters as the typeahead, from the URL: the search form is a plain GET form without JavaScript. */
  @query("q", { transform: trim }) accessor q = "";
  @query("category", { transform: oneOf("", ...CATEGORY_IDS) }) accessor category: CategoryId | "" = "";
  /** Set by the product page: the last few slugs this visitor looked at. */
  @cookie("recent") accessor recent: string | undefined;

  @get page() {
    const results = this.catalog.search({ q: this.q, category: this.category }, 1, PAGE_SIZE);
    const recent = (this.recent ?? "").split(",").map((slug) => this.catalog.bySlug(slug)).filter((p) => p !== undefined);
    return (
      <>
        <section class="hero-banner">
          {/* The one image that matters for first paint: eager, high priority, fingerprinted by the build. */}
          <img src={assetUrl("src/hero.svg")} alt="" width={1200} height={360} fetchpriority="high" decoding="async" class="hero-img" />
          <div class="hero-copy">
            <h1>Absurd yard goods, sold live.</h1>
            <p>Sixty questionable items. Five aisles. One very judgmental gnome.</p>
          </div>
        </section>

        <form class="search" method="get" action="/" role="search">
          <label class="visually-hidden" for="q">Search the shelves</label>
          {/* Typeahead: the action fires 200ms after typing stops, with the box's value and the select's, read in the browser. */}
          <input
            class="input"
            id="q"
            name="q"
            type="search"
            value={this.q}
            placeholder="Search the shelves (try gnome, rock, pink)"
            autocomplete="off"
            action={({ el, ref }) => this.search({ q: el.value, category: ref("#category").value })}
            trigger="input 200ms"
          />
          <label class="visually-hidden" for="category">Aisle</label>
          <select
            class="input"
            id="category"
            name="category"
            action={({ el, ref }) => this.search({ q: ref("#q").value, category: el.value })}
            trigger="change"
          >
            <option value="">Every aisle</option>
            {CATEGORY_IDS.map((id) => (
              <option value={id} selected={this.category === id}>{CATEGORIES[id].name}</option>
            ))}
          </select>
          <button class="btn">Search</button>
        </form>

        <ResultCount total={results.total} q={this.q} />
        <Toast />
        <ProductGrid products={results.items} addToCart={this.addToCart} />
        {/* `ctx` in a lambda is the request rendering this page, read now (on the server): here, its query string. */}
        <More
          next={results.pages > 1 ? ({ ctx }) => this.more({ page: 2, q: ctx.query.get("q") ?? "", category: ctx.query.get("category") ?? "" }) : undefined}
          left={results.total - results.items.length}
        />

        {recent.length > 0 ? (
          <Collapsible id="recent" title="Recently viewed">
            <ul class="recent">
              {recent.map((p) => (
                <li>
                  <a href={`/products/${p.slug}`}>
                    <ProductImage product={p} width={96} />
                    {p.name}
                  </a>
                </li>
              ))}
            </ul>
          </Collapsible>
        ) : null}
      </>
    );
  }

  /** The grid, the count and a fresh sentinel for a new search: three Regions in one round trip. */
  @action search({ q, category }: Filters) {
    const results = this.catalog.search({ q, category }, 1, PAGE_SIZE);
    return (
      <>
        <ResultCount total={results.total} q={q.trim()} />
        <ProductGrid products={results.items} addToCart={this.addToCart} />
        <More next={results.pages > 1 ? () => this.more({ page: 2, q, category }) : undefined} left={results.total - results.items.length} />
      </>
    );
  }

  /** The next page, appended (`<Region append>`), plus a sentinel for the page after. */
  @action more({ page, q, category }: Filters & { page: number }) {
    const results = this.catalog.search({ q, category }, page, PAGE_SIZE);
    const shown = Math.min(results.total, page * PAGE_SIZE);
    return (
      <>
        <ProductGrid products={results.items} addToCart={this.addToCart} append />
        <More next={page < results.pages ? () => this.more({ page: page + 1, q, category }) : undefined} left={results.total - shown} />
      </>
    );
  }

  @action addToCart({ id }: { id: string }) {
    const product = this.catalog.find(id);
    this.viewer.cart.add(product);
    this.viewer.cartChanged();
    return (
      <>
        <CartBadge count={this.viewer.cart.count} />
        <Toast message={`${product.name} is in your cart.`} />
      </>
    );
  }
}
