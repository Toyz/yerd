import { randomUUID } from "node:crypto";
import { instrument, is, length, logger, lower, matches, onBoot, resolve, service, trim, type Logger } from "@toyz/yerd";
import { createAuth, hashPassword } from "@toyz/yerd/auth";
import { Cart } from "./cart.js";
import { Carts } from "./carts.js";

export type Role = "admin" | "staff" | "customer";

export interface User {
  id: string;
  name: string;
  roles: Role[];
  passwordHash: string;
  createdAt: string;
}

export class SignupForm {
  @is.string({ transform: [trim, lower], validate: [length(2, 24), matches(/^[a-z0-9_-]+$/, "Use letters, numbers, - and _ only")] })
  name!: string;
  @is.string({ validate: length(8, 200) }) password!: string;
}

export class LoginForm {
  @is.string({ transform: [trim, lower] }) name!: string;
  @is.string() password!: string;
}

/** The demo accounts, listed on the login page. */
export const DEMO_ACCOUNTS: Array<{ name: string; password: string; roles: Role[] }> = [
  { name: "ada", password: "gnome-overlord", roles: ["admin", "staff"] },
  { name: "bo", password: "flamingo-wrangler", roles: ["staff"] },
  { name: "cy", password: "rock-collector", roles: ["customer"] },
  { name: "di", password: "saved-my-cart", roles: ["customer"] },
];

/** Accounts, in memory. Seeded with the demo accounts at boot (hashing is async, so it can't be a field initializer). */
@service
export class UserRepo {
  #users: User[] = [];
  @logger accessor log!: Logger;

  @onBoot async seed() {
    for (const account of DEMO_ACCOUNTS) await this.create(account.name, account.password, account.roles);
  }

  get(id: string): User | undefined {
    return this.#users.find((u) => u.id === id);
  }

  byName(name: string): User | undefined {
    return this.#users.find((u) => u.name === name);
  }

  /**
   * A span per signup with the name and roles, never the password: `skip`
   * names the parameter (checked when the class loads), and the return value
   * (which carries the hash) is left out too.
   */
  @instrument({ level: "info", skip: ["password"], ret: false })
  async create(name: string, password: string, roles: Role[] = ["customer"]): Promise<User> {
    const user: User = { id: randomUUID(), name, roles, passwordHash: await hashPassword(password), createdAt: new Date().toISOString() };
    this.#users.push(user);
    return user;
  }
}

/**
 * Session auth: `app.use(auth)`, `guards: [auth.required]`, `auth.role("staff")`, `@auth.user`.
 *
 * The hooks carry the cart across sign-in: onLogin runs after login() has
 * rotated the session and merges the guest's cart into the user's saved one;
 * onLogout runs before logout() destroys the session and saves it. The hooks
 * get the plain session; `session.as(Cart)` is the same typed view routes get
 * from `@session(Cart)`.
 */
export const auth = createAuth<User>({
  load: (id) => resolve(UserRepo).get(id),
  roles: (user) => user.roles,
  loginPath: "/login",
  onLogin(user, session) {
    const carts = resolve(Carts);
    const cart = session.as(Cart);
    const saved = carts.load(user);
    cart.lines = carts.merge(saved, cart.lines);
    carts.save(user.id, cart.lines);
    const kept = saved.reduce((sum, line) => sum + line.qty, 0);
    // Not a flash (that's gone after the next request, wherever it lands): kept until the cart page shows it.
    if (kept > 0) cart.welcomeBack = kept;
  },
  onLogout(user, session) {
    if (user) resolve(Carts).save(user.id, session.as(Cart).lines);
  },
});
