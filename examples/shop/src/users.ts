import { is, lower, onBoot, resolve, service, trim } from "@toyz/yerd";
import { createAuth, hashPassword } from "@toyz/yerd/auth";

export interface User {
  id: string;
  name: string;
  passwordHash: string;
}

/** Listed on the sign-in page. */
export const DEMO_ACCOUNT = { name: "ada", password: "analytical-engine" };

export class LoginForm {
  @is.string({ transform: [trim, lower] }) name!: string;
  @is.string() password!: string;
}

/** Accounts, in memory. */
@service
export class Users {
  #users: User[] = [];

  /** Hashing is async, so the demo account is made at boot, before the first request. */
  @onBoot async seed() {
    this.#users.push({ id: "u1", name: DEMO_ACCOUNT.name, passwordHash: await hashPassword(DEMO_ACCOUNT.password) });
  }

  get(id: string): User | undefined {
    return this.#users.find((u) => u.id === id);
  }

  byName(name: string): User | undefined {
    return this.#users.find((u) => u.name === name);
  }
}

/** Session sign-in: `app.use(auth)`, `guards: [auth.required]`, `@auth.user`. */
export const auth = createAuth<User>({
  load: (id) => resolve(Users).get(id),
  loginPath: "/login",
});
