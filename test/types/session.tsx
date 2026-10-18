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

  // Values as properties: optional like get(), typed like set().
  @get props() {
    const owner: string | undefined = this.session.owner;
    this.session.items ??= [];
    this.session.items.push("socks");
    this.session.coupon = undefined;
    // @ts-expect-error "itmes": Cart has no such field
    this.session.itmes;
    // @ts-expect-error items is string[]
    this.session.items = "one";
    // Members still win: get is the method, not a field.
    const read: string | undefined = this.session.get("owner");
    return [owner, read];
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

class Basket {
  items: string[] = [];
  coupon?: string;
  get count() {
    return this.items.length;
  }
  add(item: string) {
    this.items.push(item);
  }
}

@route("/basket")
export class BasketRoute {
  // A class shape: methods, getters and defaults, typed.
  @session(Basket) accessor basket!: Session<Basket>;

  @post add() {
    this.basket.add("socks");
    const n: number = this.basket.count;
    const items: string[] = this.basket.items; // has a default: not optional
    const coupon: string | undefined = this.basket.coupon;
    // @ts-expect-error add takes a string
    this.basket.add(1);
    this.basket.flash("notice", "added");
    return [n, items, coupon];
  }

  @post @args(session(Basket)) again(basket: Session<Basket>) {
    basket.add("hat");
    return 204;
  }
}

export class WrongShape {
  // @ts-expect-error the accessor's shape must match the class
  @session(Basket) accessor basket!: Session<Cart>;
}
