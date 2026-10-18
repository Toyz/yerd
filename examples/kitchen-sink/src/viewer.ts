import { currentContext, inject, scoped, service, session, type Session } from "@toyz/yerd";
import { Cart } from "./cart.js";
import { Carts } from "./carts.js";
import { auth, type User } from "./users.js";

/** The visitor's preferences, kept in their session. */
export interface Prefs {
  theme?: "light" | "dark";
}

/**
 * Who's looking, for this request: the user, their cart and their theme. A
 * scoped service (one per request), so layouts can `resolve(Viewer)` without
 * each reading the session their own way. Request accessors work on services
 * too: they read the current request, whatever the lifetime.
 */
@scoped
@service
export class Viewer {
  @auth.maybeUser accessor me: User | undefined;
  @session(Cart) accessor cart!: Session<Cart>;
  @session accessor prefs!: Session<Prefs>;
  @inject(Carts) accessor carts!: Carts;

  /** Call after changing the cart: a signed-in user's cart is saved too, so it survives never signing out. */
  cartChanged(): void {
    if (this.me) this.carts.save(this.me.id, this.cart.lines);
  }

  get staff(): boolean {
    return this.me?.roles.includes("staff") ?? false;
  }

  /** A prerendered page has no visitor (and reading the session would fail the build): it gets the default. */
  get theme(): "light" | "dark" {
    return currentContext().prerendering ? "light" : (this.prefs.theme ?? "light");
  }

  /** Items in the cart; 0 while prerendering. */
  get cartCount(): number {
    return currentContext().prerendering ? 0 : this.cart.count;
  }
}
