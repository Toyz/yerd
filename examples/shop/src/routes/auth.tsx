import { ActionForm, ValidationFailed, action, get, inject, layout, post, query, redirect, route, session, type Session } from "@toyz/yerd";
import { safeNext, verifyPassword } from "@toyz/yerd/auth";
import { Field } from "../components.js";
import { Narrow } from "../layouts.js";
import { DEMO_ACCOUNT, LoginForm, Users, auth, type User } from "../users.js";

interface LoginState {
  error?: string;
  name?: string;
}

@route("/login", { meta: { title: "Sign in" } })
@layout(Narrow)
export class LoginPage {
  @inject(Users) accessor users!: Users;
  @auth.maybeUser accessor me: User | undefined;
  @session accessor session!: Session;
  @query("next") accessor next: string | undefined;

  @get page() {
    // safeNext: same-site paths only, so ?next=https://evil.example can't bounce anyone off-site.
    if (this.me) return redirect(safeNext(this.next));
    const state = (this.session.flash("login") ?? {}) as LoginState;
    return (
      <>
        <h1>Sign in</h1>
        <form action={this.submit}>
          <Field name="name" label="Username" value={state.name} autocomplete="username" />
          <Field name="password" label="Password" type="password" autocomplete="current-password" />
          <p class="form-error" data-yx-error role="alert">{state.error}</p>
          <button>Sign in</button>
        </form>
        <p class="hint">
          Demo account: <code>{DEMO_ACCOUNT.name}</code> / <code>{DEMO_ACCOUNT.password}</code>
        </p>
      </>
    );
  }

  @action async submit(_: {}, form: ActionForm) {
    let input: LoginForm;
    try {
      input = form.parse(LoginForm);
    } catch (error) {
      if (!(error instanceof ValidationFailed)) throw error;
      return this.#fail("Enter your username and password.", form.get("name"));
    }
    const user = this.users.byName(input.name);
    // Spends a full hash even for unknown names, so timing doesn't reveal who has an account.
    if (!(await verifyPassword(input.password, user?.passwordHash)) || !user) {
      return this.#fail("Wrong username or password.", input.name);
    }
    // Rotates the session id and keeps a guest's data: the cart comes along.
    await auth.login(user);
    return redirect(safeNext(this.next));
  }

  /** Back to the form with a message, with or without JavaScript. */
  #fail(error: string, name: string | undefined) {
    this.session.flash("login", { error, name } satisfies LoginState);
    return redirect(`/login${this.next ? `?next=${encodeURIComponent(this.next)}` : ""}`);
  }
}

@route("/logout")
export class Logout {
  @post async leave() {
    await auth.logout();
    return redirect("/");
  }
}
