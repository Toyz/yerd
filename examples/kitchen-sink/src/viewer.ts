import { currentContext, inject, scoped, service, session, type Session } from "@toyz/yerd";
import { Cart, type CartLine } from "./cart.js";
import { Carts } from "./carts.js";
import { auth, type User } from "./users.js";

declare module "@toyz/yerd" {
  /** App-wide session keys: plain `Session` (and `ctx.session`) are typed by these. */
  interface SessionData {
    theme?: "light" | "dark";
    /** The Cart shape's data, read by the sign-in hooks (users.ts). */
    lines?: CartLine[];
    /** How many saved items a sign-in brought back; the cart page says so once. */
    cartWelcome?: number;
  }
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
  @session accessor session!: Session;
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
    return currentContext().prerendering ? "light" : (this.session.theme ?? "light");
  }

  /** Items in the cart; 0 while prerendering. */
  get cartCount(): number {
    return currentContext().prerendering ? 0 : this.cart.count;
  }
}
