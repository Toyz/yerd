import { Conflict, Region, action, get, inject, param, query, route, session, setMeta, toInt, trim, type Session } from "@toyz/yerd";
import { Cart } from "../cart.js";
import { Catalog } from "../catalog.js";
import { Price, ProductCard } from "../components.js";
import { CartBadge } from "../layouts.js";

/** The front page: every product, narrowed by ?q=. */
@route("/", { meta: { title: "Shop" } })
export class ProductList {
  @inject(Catalog) accessor catalog!: Catalog;
  @query("q", { transform: trim }) accessor q = "";

  @get page() {
    const products = this.catalog.search(this.q);
    return (
      <>
        {/* A GET form: the search is a URL you can share and reload. */}
        <form class="search" method="get" role="search">
          <input type="search" name="q" value={this.q} placeholder="Search" aria-label="Search" />
          <button>Search</button>
        </form>
        {products.length === 0 ? (
          <p class="empty">Nothing matches "{this.q}".</p>
        ) : (
          <ul class="products">{products.map((p) => <ProductCard product={p} />)}</ul>
        )}
      </>
    );
  }
}

/** Stock left, as a Region: the add action sends a fresh one. */
function Stock({ stock }: { stock: number }) {
  return (
    <Region id="stock" as="p" class="stock">
      {stock === 0 ? "Sold out" : `${stock} in stock`}
    </Region>
  );
}

/** One product. An unknown id is the catalog's ProductNotFound: a 404. */
@route("/products/:id")
export class ProductPage {
  @inject(Catalog) accessor catalog!: Catalog;
  @param("id", { transform: toInt }) accessor id!: number;
  @session(Cart) accessor cart!: Session<Cart>;

  @get page() {
    const product = this.catalog.find(this.id);
    setMeta({ title: product.name, description: product.description });
    return (
      <article class="product">
        <h1>{product.name}</h1>
        <p>{product.description}</p>
        <Price cents={product.price} />
        <Stock stock={product.stock} />
        <form action={this.add}>
          <button disabled={product.stock === 0}>Add to cart</button>
        </form>
      </article>
    );
  }

  /** @param works in actions too: this.id is the product on the page. */
  @action add() {
    const product = this.catalog.find(this.id);
    const inCart = this.cart.lines.find((line) => line.id === product.id)?.qty ?? 0;
    // A 409: the runtime shows its message. Checkout checks the stock again anyway.
    if (inCart >= product.stock) throw new Conflict(product.stock === 0 ? "Sold out." : `Only ${product.stock} in stock.`);
    this.cart.add(product.id);
    // With the runtime, these morph in; without it, the browser is sent back to the page.
    return (
      <>
        <CartBadge count={this.cart.count} />
        <Stock stock={product.stock} />
      </>
    );
  }
}
