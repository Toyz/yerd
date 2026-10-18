/**
 * @toyz/yerd/auth: session-based authentication, built only on the public
 * kit (sessions, createAccessor, createGuard, middleware). yerd doesn't know
 * what a user is; you tell it how to load one by id.
 *
 * ```ts
 * export const auth = createAuth<User>({
 *   load: (id) => resolve(Users).find(id),
 *   loginPath: "/login",
 * });
 * app.sessions().use(auth);
 *
 * @route("/account", { guards: [auth.required] })
 * class Account { @auth.user accessor me!: User; ... }
 * ```
 *
 * Each auth keeps its user id under its own session key. One app with two
 * kinds of sign-in (users and admins) must give each a distinct `sessionKey`,
 * or signing in as one would count as the other; creating a second auth
 * without one throws.
 */

import { createAccessor, type AccessorDecorator } from "../decorators/kit.js";
import { createGuard, onGuardRegistryReset, type GuardRef } from "../decorators/guards.js";
import { localKey } from "../decorators/keys.js";
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
  /** Load a user by the id stored in the session; undefined if they're gone. */
  load: (id: string) => User | undefined | Promise<User | undefined>;
  /** The id to store in the session. Default: `user.id`. */
  idOf?: (user: User) => string;
  /** Roles, for auth.role(...). */
  roles?: (user: User) => readonly string[];
  /** Where browsers are sent when a page needs login. Default "/login". */
  loginPath?: string;
  /**
   * The session key the user id is kept under. Default "__yerd_uid". Every
   * auth in a process needs its own: a second createAuth() without one throws.
   */
  sessionKey?: string;
}

/**
 * What createAuth() returns: middleware, accessors and guards for one kind of
 * sign-in. Pass it to app.use(), which installs its middleware.
 */
export interface Auth<User> {
  /** Loads the signed-in user once per request. `app.use(auth)`. */
  readonly middleware: Middleware;
  /** The signed-in user. Use on routes behind `auth.required`; reading it with nobody signed in is a 401. */
  readonly user: AccessorDecorator<User>;
  /** The signed-in user, or undefined. */
  readonly maybeUser: AccessorDecorator<User | undefined>;
  /** Guard: someone must be signed in. Browsers go to loginPath?next=... (scripted requests via yx-location), APIs get 401. */
  readonly required: GuardRef;
  /** Guard: the signed-in user has one of these roles (403 otherwise). */
  role(...names: string[]): GuardRef;
  /** Sign a user in: new session id (fixation), user id stored. */
  login(user: User): void;
  /** Sign out: the session is destroyed. */
  logout(): void;
  /** The signed-in user, for components and plain functions. */
  current(): User | undefined;
}

/** Only same-site paths: "/x", not "//evil.com", "/\\evil.com", "/\t/evil.com" or absolute URLs. */
export function safeNext(value: string | null | undefined, fallback = "/"): string {
  return safeBack(value, fallback);
}

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
 * ```ts
 * const auth = createAuth<User>({ load: (id) => users.get(id), roles: (u) => u.roles });
 *
 * @route("/login") class Login {
 *   @action async signIn(_: {}, form: ActionForm) {
 *     const user = users.byEmail(form.string("email"));
 *     if (!(await verifyPassword(form.string("password"), user?.passwordHash))) throw new HttpError(401, "Wrong email or password");
 *     auth.login(user!);
 *     return redirect("/account");
 *   }
 * }
 * ```
 */
export function createAuth<User>(options: AuthOptions<User>): Auth<User> {
  const loaded = localKey<{ user: User | undefined }>("auth:user");
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

  const stateOf = (ctx: YerdContext) => ctx.memo.get(loaded.key) as { user: User | undefined } | undefined;
  const setUser = (ctx: YerdContext, user: User | undefined) => ctx.memo.set(loaded.key, { user });

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
    if (wantsPage(ctx)) return `${loginPath}?next=${encodeURIComponent(ctx.path + ctx.url.search)}`;
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
      session.regenerate();
      session.set(userKey as never, idOf(user) as never);
      setUser(ctx, user);
    },
    logout() {
      const ctx = currentContext();
      sessionOf(ctx).destroy();
      setUser(ctx, undefined);
    },
    current() {
      const ctx = maybeContext();
      return ctx ? current(ctx) : undefined;
    },
  };
}
