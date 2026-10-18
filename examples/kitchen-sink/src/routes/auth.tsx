import { ActionForm, ValidationFailed, YerdError, action, get, group, inject, query, redirect, route, session, type Session } from "@toyz/yerd";
import { safeNext, verifyPassword } from "@toyz/yerd/auth";
import { AuthLayout } from "../layouts.js";
import { fromScript } from "../shop.js";
import { DEMO_ACCOUNTS, LoginForm, SignupForm, UserRepo, auth, type User } from "../users.js";

/** What the auth pages keep in the session: a typed view, separate from the cart's. */
interface AuthSession {
  /** Last submitted name, so a failed form keeps it. */
  lastName?: string;
}

/** Login and signup: their own layout, no shop chrome, and nothing for a search engine. */
@group("/", { layout: AuthLayout, sitemap: false })
export class AuthPages {}

/** The first message of a validation failure, or the error's own message. */
function messageOf(error: unknown): string {
  if (error instanceof YerdError) {
    return (error instanceof ValidationFailed ? error.issues[0]?.message : undefined) ?? error.message;
  }
  throw error;
}

/** A labelled input. `box` adds a [data-yx-error="<name>"] box: validation messages for this field land there. */
function Field({ name, label, type = "text", value, autocomplete, box = false }: { name: string; label: string; type?: string; value?: string; autocomplete: string; box?: boolean }) {
  return (
    <div class="field">
      <label for={name}>{label}</label>
      <input class="input" id={name} name={name} type={type} value={value} autocomplete={autocomplete} required />
      {box ? <span class="field-error" data-yx-error={name}></span> : null}
    </div>
  );
}

@route("/login", { group: AuthPages, meta: { title: "Log in" } })
export class LoginPage {
  @inject(UserRepo) accessor users!: UserRepo;
  @auth.maybeUser accessor me: User | undefined;
  @session accessor session!: Session<AuthSession>;
  @query("next") accessor next: string | undefined;

  @get page() {
    // safeNext: only same-site paths, so ?next=https://evil.example can't bounce people off-site.
    if (this.me) return redirect(safeNext(this.next, "/"));
    const error = this.session.flash("error") as string | undefined;
    return (
      <>
        <h1>Welcome back</h1>
        <form action={this.submit}>
          <Field name="name" label="Username" value={this.session.lastName} autocomplete="username" />
          <Field name="password" label="Password" type="password" autocomplete="current-password" />
          <p class="form-error" data-yx-error role="alert">{error}</p>
          <button class="btn btn-block">Log in</button>
        </form>
        <details class="demo-accounts">
          <summary>Demo accounts</summary>
          <ul>
            {DEMO_ACCOUNTS.map((a) => (
              <li>
                <code>{a.name}</code> / <code>{a.password}</code> <span class="muted">({a.roles.join(", ")})</span>
              </li>
            ))}
          </ul>
        </details>
        <p class="switch">
          New here? <a href={`/signup${this.next ? `?next=${encodeURIComponent(this.next)}` : ""}`}>Create an account</a>
        </p>
      </>
    );
  }

  @action async submit(_: {}, form: ActionForm) {
    let input: LoginForm;
    try {
      input = form.parse(LoginForm);
    } catch (error) {
      return this.#fail(messageOf(error));
    }
    const user = this.users.byName(input.name);
    // Always spends a password hash, so timing doesn't reveal which names exist.
    if (!(await verifyPassword(input.password, user?.passwordHash)) || !user) {
      this.session.lastName = input.name;
      return this.#fail("Wrong username or password.");
    }
    // Awaited: the onLogin hook (the cart merge) must finish before the response.
    await auth.login(user);
    return redirect(safeNext(this.next, user.roles.includes("staff") ? "/admin" : "/"));
  }

  /** Errors survive the post/redirect/get round trip as a flash message (with or without JavaScript). */
  #fail(message: string) {
    this.session.flash("error", message);
    return redirect(`/login${this.next ? `?next=${encodeURIComponent(this.next)}` : ""}`);
  }
}

@route("/signup", { group: AuthPages, meta: { title: "Sign up" } })
export class SignupPage {
  @inject(UserRepo) accessor users!: UserRepo;
  @session accessor session!: Session<AuthSession>;
  @query("next") accessor next: string | undefined;

  @get page() {
    const error = this.session.flash("error") as string | undefined;
    return (
      <>
        <h1>Open an account</h1>
        <p class="meta-line">For checking out and chatting. Browsing is free.</p>
        <form action={this.submit}>
          <Field name="name" label="Username" value={this.session.lastName} autocomplete="username" box />
          <Field name="password" label="Password (8+ characters)" type="password" autocomplete="new-password" box />
          <p class="form-error" data-yx-error role="alert">{error}</p>
          <button class="btn btn-block">Sign up</button>
        </form>
        <p class="switch">
          Have an account? <a href="/login">Log in</a>
        </p>
      </>
    );
  }

  @action async submit(_: {}, form: ActionForm) {
    let input: SignupForm;
    try {
      input = form.parse(SignupForm);
    } catch (error) {
      // With the runtime, let the validation error through: each message goes to its field's box.
      // A plain post would get the error page, so it gets the first message as a flash instead.
      if (fromScript()) throw error;
      return this.#fail(messageOf(error), form.get("name"));
    }
    if (this.users.byName(input.name)) return this.#fail("That username is taken.", input.name);
    await auth.login(await this.users.create(input.name, input.password));
    return redirect(safeNext(this.next, "/"));
  }

  #fail(message: string, name: string | undefined) {
    this.session.flash("error", message);
    if (name !== undefined) this.session.lastName = name.trim().toLowerCase();
    return redirect("/signup");
  }
}

@route("/logout", { sitemap: false })
export class LogoutRoute {
  @get page() {
    return redirect("/");
  }

  /** onLogout saves the cart before the session goes. */
  @action async out() {
    await auth.logout();
    return redirect("/");
  }
}
