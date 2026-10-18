import { ActionForm, HttpError, action, get, group, inject, query, redirect, route, session, type Session } from "@toyz/yerd";
import { safeNext, verifyPassword } from "@toyz/yerd/auth";
import { AuthLayout } from "../layouts.js";
import { LoginForm, SignupForm, UserRepo, auth, type User } from "../users.js";

declare module "@toyz/yerd" {
  interface SessionData {
    /** Last submitted name, so a failed form keeps it. */
    lastName?: string;
  }
}

/** Login and signup: their own layout, no app chrome, no login required. */
@group("/", { layout: AuthLayout })
export class AuthPages {}

/** The first message of a validation failure, or the error's own message. */
function messageOf(error: unknown): string {
  if (error instanceof HttpError) {
    const issues = (error.details as { issues?: Array<{ message: string }> } | undefined)?.issues;
    return issues?.[0]?.message ?? error.message;
  }
  throw error;
}

function Field({ name, label, type = "text", value, autocomplete }: { name: string; label: string; type?: string; value?: string; autocomplete: string }) {
  return (
    <div class="field">
      <label for={name}>{label}</label>
      <input class="input" id={name} name={name} type={type} value={value} autocomplete={autocomplete} required />
    </div>
  );
}

@route("/login", { group: AuthPages, meta: { title: "Log in" } })
export class LoginPage {
  @inject(UserRepo) accessor users!: UserRepo;
  @auth.maybeUser accessor me: User | undefined;
  @session accessor session!: Session;
  @query("next") accessor next: string | undefined;

  @get page() {
    if (this.me) return redirect(safeNext(this.next, "/todos"));
    const error = this.session.flash("error") as string | undefined;
    return (
      <>
        <h1>Welcome back</h1>
        <p class="meta-line">Log in to see your todos.</p>
        <form action={this.submit}>
          <Field name="name" label="Username" value={this.session.get("lastName")} autocomplete="username" />
          <Field name="password" label="Password" type="password" autocomplete="current-password" />
          <p class="form-error" data-yx-error role="alert">{error}</p>
          <button class="btn btn-block">Log in</button>
        </form>
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
      this.session.set("lastName", input.name);
      return this.#fail("Wrong username or password.");
    }
    auth.login(user);
    return redirect(safeNext(this.next, "/todos"));
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
  @session accessor session!: Session;
  @query("next") accessor next: string | undefined;

  @get page() {
    const error = this.session.flash("error") as string | undefined;
    return (
      <>
        <h1>Create an account</h1>
        <p class="meta-line">Your todos are yours: nobody else sees them.</p>
        <form action={this.submit}>
          <Field name="name" label="Username" value={this.session.get("lastName")} autocomplete="username" />
          <Field name="password" label="Password (8+ characters)" type="password" autocomplete="new-password" />
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
      return this.#fail(messageOf(error), form.get("name"));
    }
    if (this.users.byName(input.name)) return this.#fail("That username is taken.", input.name);
    auth.login(await this.users.create(input.name, input.password));
    return redirect(safeNext(this.next, "/todos"));
  }

  #fail(message: string, name: string | undefined) {
    this.session.flash("error", message);
    if (name !== undefined) this.session.set("lastName", name.trim().toLowerCase());
    return redirect("/signup");
  }
}

@route("/logout")
export class LogoutRoute {
  @get page() {
    return redirect("/login");
  }

  @action out() {
    auth.logout();
    return redirect("/login");
  }
}
