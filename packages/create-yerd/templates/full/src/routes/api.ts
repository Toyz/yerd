import { HttpStatus, get, inject, param, query, route, toInt, trim } from "@toyz/yerd";
import { Catalog, ProductNotFound } from "../catalog.js";

// The JSON API. `session: false`: API clients get no cookie, and no session is read.

@route("/api/products", { session: false })
export class ProductsApi {
  @inject(Catalog) accessor catalog!: Catalog;
  @query("q", { transform: trim }) accessor q = "";

  @get list() {
    // An array becomes JSON.
    return this.catalog.search(this.q);
  }
}

@route("/api/products/:id", { session: false })
export class ProductApi {
  @inject(Catalog) accessor catalog!: Catalog;
  @param("id", { transform: toInt }) accessor id!: number;

  @get show() {
    // A returned error counts as thrown: a JSON 404 with the id.
    return this.catalog.get(this.id) ?? new ProductNotFound(this.id);
  }
}

/** For load balancers and uptime checks: 204, no body. */
@route("/api/health", { session: false })
export class Health {
  @get check() {
    return HttpStatus.NoContent;
  }
}
