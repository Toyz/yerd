// Compile-only: Session<T> types get/set/delete by T; plain Session uses SessionData.
import { args, get, post, route, session, type Session } from "@toyz/yerd";

interface Cart {
  items?: string[];
  coupon?: string;
  owner: string;
}

@route("/cart")
export class CartRoute {
  @session accessor session!: Session<Cart>;

  @get show() {
    const items: string[] | undefined = this.session.get("items");
    this.session.set("owner", "me");
    this.session.delete("coupon");
    // @ts-expect-error "itmes": Cart has no such field
    this.session.get("itmes");
    // @ts-expect-error owner is a string
    this.session.set("owner", 1);
    // @ts-expect-error items is string[], not string
    this.session.set("items", "one");
    return items ?? [];
  }

  // Through @args too: the parameter's type picks the shape.
  @post @args(session) add(cart: Session<Cart>) {
    cart.set("items", [...(cart.get("items") ?? []), "x"]);
    return 204;
  }
}

export class NotASession {
  // @ts-expect-error the accessor must be a Session
  @session accessor session!: string;
}
