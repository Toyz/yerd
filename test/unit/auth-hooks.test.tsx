import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { get, post, route, session, yerd, type RunningServer, type Session } from "@toyz/yerd";
import { createAuth } from "@toyz/yerd/auth";

interface User {
  id: string;
}

type Cart = Record<string, number>;
declare module "@toyz/yerd" {
  interface SessionData {
    cart?: Cart;
  }
}

/** Carts kept for signed-in users between sessions (a database, really). */
const saved = new Map<string, Cart>([["ada", { gnome: 1 }]]);
const events: string[] = [];

const auth = createAuth<User>({
  load: (id) => ({ id }),
  sessionKey: "hooks_uid",
  async onLogin(user, s) {
    await Promise.resolve();
    const merged = { ...saved.get(user.id) };
    for (const [item, qty] of Object.entries(s.get("cart") ?? {})) merged[item] = (merged[item] ?? 0) + qty;
    s.set("cart", merged);
    events.push(`login ${user.id}`);
  },
  async onLogout(user, s) {
    await Promise.resolve();
    if (user) saved.set(user.id, s.get("cart") ?? {});
    events.push(`logout ${user?.id}`);
  },
});

@route("/cart")
class CartPage {
  @session accessor session!: Session;
  @get show() {
    return this.session.cart ?? {};
  }
  @post add() {
    const cart = (this.session.cart ??= {});
    cart.flamingo = (cart.flamingo ?? 0) + 1;
    return 204;
  }
}

@route("/login")
class Login {
  @post go() {
    return auth.login({ id: "ada" })?.then(() => 204) ?? 204;
  }
}

@route("/logout")
class Logout {
  @post go() {
    return auth.logout()?.then(() => 204) ?? 204;
  }
}

let server: RunningServer;
beforeAll(async () => {
  server = await yerd({ routes: [CartPage, Login, Logout], services: [], handleSignals: false, secret: "h".repeat(32) })
    .sessions()
    .use(auth)
    .listen(0, "127.0.0.1");
});
afterAll(() => server.close());

function client() {
  let jar = "";
  return async (path: string, method = "GET") => {
    const r = await fetch(server.url + path, { method, headers: { cookie: jar, origin: server.url } });
    for (const c of r.headers.getSetCookie()) jar = /Max-Age=0/.test(c) ? "" : c.split(";")[0]!;
    return r;
  };
}

describe("createAuth onLogin / onLogout", () => {
  it("merge a guest's cart into the user's saved one, and save it again on logout", async () => {
    const send = client();
    await send("/cart", "POST");
    await send("/cart", "POST");
    expect(await (await send("/cart")).json()).toEqual({ flamingo: 2 });
    await send("/login", "POST");
    expect(await (await send("/cart")).json()).toEqual({ gnome: 1, flamingo: 2 });
    await send("/cart", "POST");
    await send("/logout", "POST");
    expect(await (await send("/cart")).json()).toEqual({});
    expect(saved.get("ada")).toEqual({ gnome: 1, flamingo: 3 });
    expect(events).toEqual(["login ada", "logout ada"]);
    // Next time, on another device: the cart is there.
    const other = client();
    await other("/login", "POST");
    expect(await (await other("/cart")).json()).toEqual({ gnome: 1, flamingo: 3 });
  });
});
