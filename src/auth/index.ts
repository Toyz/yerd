/**
 * @toyz/yerd/auth: session-based authentication, built only on the public
 * kit (sessions, createAccessor, createGuard, middleware). yerd doesn't know
 * what a user is; you tell it how to load one by id.
 *
 * ```tsx
 * export const auth = createAuth<User>({
 *   load: (id) => resolve(Users).find(id),
 *   loginPath: "/login",
 * });
 * export const app = yerd().sessions().use(auth);
 *
 * @route("/account", { guards: [auth.required] })
 * export class Account {
 *   @auth.user accessor me!: User;
 *
 *   @get show() {
 *     return <h1>Hello, {this.me.name}</h1>;
 *   }
 * }
 * ```
 *
 * Each auth keeps its user id under its own session key. One app with two
 * kinds of sign-in (users and admins) must give each a distinct `sessionKey`,
 * or signing in as one would count as the other; creating a second auth
 * without one throws.
 */

import { createAccessor, type AccessorDecorator } from "../decorators/kit.js";
import { createGuard, onGuardRegistryReset, type GuardRef } from "../decorators/guards.js";
import { safeBack } from "../actions/action.js";
import { HttpError } from "../respond/response.js";
import { currentContext, maybeContext, type YerdContext } from "../server/context.js";
import type { Middleware } from "../server/app.js";
import type { Session } from "../session/session.js";

export { hashPassword, verifyPassword } from "./password.js";

const DEFAULT_KEY = "__yerd_uid";

// Session keys claimed by auths in this process. Cleared with the guard
// registry, so a dev reload that re-creates the same auth isn't a clash.
const claimedKeys = new Set<string>();
onGuardRegistryReset(() => claimedKeys.clear());

/** Options for createAuth(). Only `load` is required. */
export interface AuthOptions<User> {
  /**
   * Load a user by the id stored in the session; undefined (or null) if
   * they're gone, which also drops the id from the session. Sync or async;
   * runs once per request with someone signed in.
   *
   * ```ts
   * load: (id) => resolve(Users).find(id),
   * ```
   */
  load: (id: string) => User | undefined | Promise<User | undefined>;
  /**
   * The id to store in the session. Default: `String(user.id)`. Keep it
   * small and stable: it sits in the session for as long as they're signed in.
   *
   * ```ts
   * idOf: (user) => user.email,
   * ```
   */
  idOf?: (user: User) => string;
  /**
   * The user's role names, for auth.role(...). Without it nobody has a role,
   * so every auth.role() guard refuses.
   *
   * ```ts
   * roles: (user) => (user.admin ? ["admin", "staff"] : []),
   * ```
   */
  roles?: (user: User) => readonly string[];
  /**
   * Where browsers are sent when a page needs login, with `?next=` the page
   * they asked for. Default "/login".
   *
   * ```ts
   * loginPath: "/account/sign-in",
   * ```
   */
  loginPath?: string;
  /**
   * The session key the user id is kept under. Default "__yerd_uid". Every
   * auth in a process needs its own: a second createAuth() without one throws.
   *
   * ```ts
   * export const auth = createAuth<User>({ load: (id) => resolve(Users).find(id) });
   * export const adminAuth = createAuth<Admin>({
   *   load: (id) => resolve(Admins).find(id),
   *   sessionKey: "admin_uid",
   * });
   * ```
   */
  sessionKey?: string;
  /**
   * Runs in login(), after the session id is rotated and the user is stored:
   * merge what a guest collected into the user's own data (a cart, recently
   * viewed), or load their saved state into the session. May be async; then
   * `await auth.login(user)`. `session` is the plain Session: `session.as(Cart)`
   * gives the same typed view `@session(Cart)` does.
   *
   * ```ts
   * onLogin: async (user, session) => {
   *   const cart = session.as(Cart);
   *   cart.items = mergeCarts(await carts.load(user.id), cart.items); // guest items join the saved cart
   * },
   * ```
   */
  onLogin?: (user: User, session: Session) => void | Promise<void>;
  /**
   * Runs in logout(), before the session is destroyed: save what should
   * outlive it (the cart, for next time). `user` is undefined when nobody was
   * signed in. May be async; then `await auth.logout()`.
   *
   * ```ts
   * onLogout: async (user, session) => {
   *   if (user) await carts.save(user.id, session.as(Cart).items);
   * },
   * ```
   */
  onLogout?: (user: User | undefined, session: Session) => void | Promise<void>;
}

/**
 * What createAuth() returns: middleware, accessors and guards for one kind of
 * sign-in. Pass it to app.use(), which installs its middleware.
 *
 * ```tsx
 * export const app = yerd().sessions().use(auth);
 *
 * @route("/account", { guards: [auth.required] })
 * export class Account {
 *   @auth.user accessor me!: User;
 *
 *   @get show() {
 *     return <h1>Hello, {this.me.name}</h1>;
 *   }
 * }
 * ```
 */
export interface Auth<User> {
  /**
   * Loads the signed-in user once per request. `app.use(auth)` installs it
   * (passing the auth itself is the same as passing this). Needs sessions.
   *
   * ```ts
   * yerd().sessions().use(auth.middleware);
   * ```
   */
  readonly middleware: Middleware;
  /**
   * The signed-in user. Use on routes behind `auth.required`; reading it with
   * nobody signed in is a 401.
   *
   * ```ts
   * @auth.user accessor me!: User;
   * ```
   */
  readonly user: AccessorDecorator<User>;
  /**
   * The signed-in user, or undefined: for pages that work signed in or out.
   *
   * ```tsx
   * @auth.maybeUser accessor me: User | undefined;
   *
   * @get page() {
   *   return this.me ? redirect("/account") : <LoginForm />;
   * }
   * ```
   */
  readonly maybeUser: AccessorDecorator<User | undefined>;
  /**
   * Guard: someone must be signed in. Browsers go to loginPath?next=...
   * (scripted requests via yx-location), APIs get 401. Works anywhere a
   * guard does: a route or group's `guards`, a decorator, `@guards(...)`.
   *
   * ```ts
   * @route("/account", { guards: [auth.required] })
   * export class Account {}
   * ```
   */
  readonly required: GuardRef;
  /**
   * Guard: the signed-in user has one of these roles (403 otherwise; signed
   * out behaves like `required`). Roles come from the `roles` option.
   *
   * ```ts
   * @group("/admin", { guards: [auth.role("admin")] })
   * export class Admin {}
   * ```
   */
  role(...names: string[]): GuardRef;
  /**
   * Sign in: rotates the session id (a fresh session if someone else was
   * signed in on it), stores the user, then runs onLogin (await it when
   * that's async). Check the password first: login() trusts the user it's given.
   *
   * ```ts
   * @action async submit(_: {}, form: ActionForm) {
   *   const user = this.users.byName(form.string("name"));
   *   if (!(await verifyPassword(form.string("password"), user?.passwordHash)) || !user) {
   *     throw new HttpError(401, "Wrong name or password");
   *   }
   *   await auth.login(user);
   *   return redirect(safeNext(this.next));
   * }
   * ```
   */
  login(user: User): void | Promise<void>;
  /**
   * Sign out: runs onLogout, then destroys the session (await it when
   * onLogout is async).
   *
   * ```ts
   * @action async signOut() {
   *   await auth.logout();
   *   return redirect("/");
   * }
   * ```
   */
  logout(): void | Promise<void>;
  /**
   * The signed-in user, for components and plain functions. Undefined when
   * nobody is signed in, or outside a request.
   *
   * ```tsx
   * export function Greeting() {
   *   const user = auth.current();
   *   return user ? <span>Hi {user.name}</span> : <a href="/login">Log in</a>;
   * }
   * ```
   */
  current(): User | undefined;
}

/**
 * A `?next=` value made safe to redirect to: same-site paths ("/x") pass;
 * "//evil.com", "/\\evil.com", "/\t/evil.com", absolute URLs and anything
 * else become `fallback` (default "/"). Run every user-supplied return path
 * through it, or the login page is an open redirect.
 *
 * ```tsx
 * @query("next") accessor next: string | undefined;
 *
 * @get page() {
 *   if (this.me) return redirect(safeNext(this.next, "/account"));
 *   return <LoginForm />;
 * }
 * ```
 */
export const safeNext: (value: string | null | undefined, fallback?: string) => string = safeBack;

/** Browsers (and yerd's runtime, which asks for HTML) get the login redirect; APIs get a 401. */
function wantsPage(ctx: YerdContext): boolean {
  return (ctx.headers.accept ?? "").includes("text/html");
}

/**
 * Set up session-based sign-in for a user type. Needs app.sessions() and
 * app.use(auth). Each request loads the signed-in user once (an id whose
 * user is gone is dropped from the session). Throws if another auth in the
 * process already uses the same `sessionKey`.
 *
 * ```tsx
 * export const auth = createAuth<User>({
 *   load: (id) => resolve(Users).find(id),
 *   roles: (user) => user.roles,
 * });
 *
 * @route("/login")
 * export class Login {
 *   @inject(Users) accessor users!: Users;
 *
 *   @get page() {
 *     return (
 *       <form action={this.signIn}>
 *         <input name="email" type="email" />
 *         <input name="password" type="password" />
 *         <button>Sign in</button>
 *       </form>
 *     );
 *   }
 *
 *   @action async signIn(_: {}, form: ActionForm) {
 *     const user = this.users.byEmail(form.string("email"));
 *     // An unknown email still costs a full hash: timing doesn't tell.
 *     if (!(await verifyPassword(form.string("password"), user?.passwordHash)) || !user) {
 *       throw new HttpError(401, "Wrong email or password");
 *     }
 *     await auth.login(user);
 *     return redirect("/account");
 *   }
 * }
 * ```
 */
export function createAuth<User>(options: AuthOptions<User>): Auth<User> {
  // This auth's slot in the per-request memo: the loaded user, once per request.
  const loaded = Symbol("auth:user");
  const idOf = options.idOf ?? ((user: User) => String((user as { id: unknown }).id));
  const loginPath = options.loginPath ?? "/login";
  const userKey = options.sessionKey ?? DEFAULT_KEY;
  if (claimedKeys.has(userKey)) {
    throw new Error(
      options.sessionKey === undefined
        ? `createAuth: another auth already uses the default session key; pass a distinct \`sessionKey\` to each (e.g. createAuth({ ..., sessionKey: "admin_uid" }))`
        : `createAuth: session key ${JSON.stringify(userKey)} is already used by another auth; give each a distinct \`sessionKey\``,
    );
  }
  claimedKeys.add(userKey);

  const sessionOf = (ctx: YerdContext): Session => {
    try {
      return ctx.session;
    } catch (error) {
      throw new Error(`createAuth needs sessions: call app.sessions() before app.use(auth) (${(error as Error).message})`, { cause: error });
    }
  };

  const stateOf = (ctx: YerdContext) => ctx.memo.get(loaded) as { user: User | undefined } | undefined;
  const setUser = (ctx: YerdContext, user: User | undefined) => ctx.memo.set(loaded, { user });

  const middleware: Middleware = async (ctx, next) => {
    // Build-time prerendering has no visitor: nobody is signed in.
    if (ctx.prerendering) {
      setUser(ctx, undefined);
      return next();
    }
    const session = sessionOf(ctx);
    const id = session.get(userKey as never) as string | undefined;
    let user: User | undefined;
    if (id !== undefined) {
      // null counts as "no such user" too: database clients tend to return it.
      user = (await options.load(id)) ?? undefined;
      // The account is gone: forget it, so we don't look it up on every request.
      if (user === undefined) session.delete(userKey as never);
    }
    setUser(ctx, user);
    return next();
  };

  const current = (ctx: YerdContext): User | undefined => {
    const state = stateOf(ctx);
    if (!state) throw new Error("auth.middleware isn't installed: add app.use(auth)");
    return state.user;
  };

  const required = createGuard("auth.required", (ctx) => {
    if (ctx.prerendering) throw new Error("auth.required: a route that needs a signed-in user can't be prerendered");
    if (current(ctx) !== undefined) return true;
    if (wantsPage(ctx)) return `${loginPath}${loginPath.includes("?") ? "&" : "?"}next=${encodeURIComponent(ctx.path + ctx.url.search)}`;
    throw new HttpError(401, "Sign in first");
  });

  return {
    middleware,
    user: createAccessor((ctx): User => {
      const user = current(ctx);
      if (user === undefined) throw new HttpError(401, "Sign in first");
      return user;
    }, { name: "auth.user" }),
    maybeUser: createAccessor((ctx): User | undefined => current(ctx), { name: "auth.maybeUser" }),
    required,
    role(...names: string[]) {
      return createGuard(`auth.role(${names.join(", ")})`, (ctx) => {
        const user = current(ctx);
        if (user === undefined) return required.run(ctx);
        const roles = options.roles?.(user) ?? [];
        return names.some((n) => roles.includes(n)) || new HttpError(403, "You don't have access to this");
      });
    },
    login(user: User) {
      const ctx = currentContext();
      const session = sessionOf(ctx);
      const id = idOf(user);
      // Someone else is signed in on this session (a shared computer, no
      // logout): start a fresh one, so nothing of theirs (a cart, a "passed
      // 2FA" flag) carries over to the new user. A guest's data does.
      const previous = session.get(userKey as never) as string | undefined;
      if (previous !== undefined && previous !== id) session.destroy();
      session.regenerate();
      session.set(userKey as never, id as never);
      setUser(ctx, user);
      return options.onLogin?.(user, session);
    },
    logout() {
      const ctx = currentContext();
      const session = sessionOf(ctx);
      const end = () => {
        session.destroy();
        setUser(ctx, undefined);
      };
      const saving = options.onLogout?.(current(ctx), session);
      if (saving instanceof Promise) return saving.then(end);
      end();
      return undefined;
    },
    current() {
      const ctx = maybeContext();
      return ctx ? current(ctx) : undefined;
    },
  };
}
