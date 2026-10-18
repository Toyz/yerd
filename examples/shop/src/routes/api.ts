import { get, inject, oneOf, param, query, route, toInt, trim } from "@toyz/yerd";
import { CATEGORIES, Catalog, ProductNotFound, type Category } from "../catalog.js";

// The JSON API. `session: false`: API clients get no cookie, and no session is read.

@route("/api/products", { session: false })
export class ProductsApi {
  @inject(Catalog) accessor catalog!: Catalog;
  @query("q", { transform: trim }) accessor q = "";
  @query("category", { transform: oneOf(...CATEGORIES) }) accessor category: Category | undefined;

  @get list() {
    // An array becomes JSON.
    return this.catalog.search({ q: this.q, category: this.category });
  }
}

@route("/api/products/:id", { session: false })
export class ProductApi {
  @inject(Catalog) accessor catalog!: Catalog;
  @param("id", { transform: toInt }) accessor id!: number;

  @get show() {
    // An object becomes JSON. A returned error counts as thrown: a JSON 404 with the id.
    return this.catalog.get(this.id) ?? new ProductNotFound(this.id);
  }
}
