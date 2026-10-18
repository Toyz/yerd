import { Dynamic, Region, Scripts, Stylesheet, resolve, type ErrorPageProps, type LayoutProps } from "@toyz/yerd";
import { TodoRepo } from "./todos.js";
import { auth } from "./users.js";
import { LogoutRoute } from "./routes/auth.js";

declare module "@toyz/yerd" {
  interface PageMeta {
    /** Which top-nav item is active. */
    nav?: "todos" | "about";
  }
}

/**
 * Root layout: the document. Every HTML response goes through it, error pages
 * included. Group and route layouts render inside `children`.
 */
export function RootLayout({ children, meta }: LayoutProps) {
  const title = meta.title ? `${meta.title} · yerd todos` : "yerd todos";
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="description" content={meta.description ?? "A todo app written in yerd: decorated routes, TSX, actions and live updates."} />
        <meta name="theme-color" content="#e2552d" />
        <title>{title}</title>
        <Stylesheet href="src/styles.css" />
        <Scripts auto />
      </head>
      <body>{children}</body>
    </html>
  );
}

/** The count in the top bar. A Region, so actions and live refreshes update it. */
export function TodoCount({ left }: { left: number }) {
  return (
    <Region id="todo-count" as="span" class="pill" aria-live="polite">
      {left} left
    </Region>
  );
}

/**
 * App shell (layout of the `App` group): top bar, nav, live-update hook.
 * Layouts are components, so they can use services: this one reads the count
 * straight from the repo the routes inject.
 */
export function AppShell({ children, meta }: LayoutProps) {
  const me = auth.current();
  const left = me ? resolve(TodoRepo).for(me.id).counts().left : 0;
  return (
    <div class="shell">
      <header class="topbar" data-yx-boost>
        <a class="brand" href="/todos">
          <span class="brand-mark" aria-hidden="true">✓</span> yerd todos
        </a>
        <TodoCount left={left} />
        <nav class="nav" aria-label="Main">
          <a href="/todos" prefetch aria-current={meta.nav === "todos" ? "page" : undefined}>Todos</a>
          <a href="/about" prefetch aria-current={meta.nav === "about" ? "page" : undefined}>About</a>
        </nav>
        {me ? (
          <form class="account" action={LogoutRoute.prototype.out}>
            <span class="who">@{me.name}</span>
            <button class="btn btn-ghost">Log out</button>
          </form>
        ) : null}
      </header>
      <main>{children}</main>
      <p class="footer-note">
        Server-rendered TSX, progressively enhanced. Works with JavaScript off; with it on, changes sync live across tabs.
      </p>
      <div data-yx-live="/todos/events" hidden></div>
    </div>
  );
}

/** Card layout (the per-todo group, nested inside the app shell): a back link and a card. */
export function CardLayout({ children }: LayoutProps) {
  return (
    <div class="card-wrap" data-yx-boost>
      <a class="back" href="/todos">← All todos</a>
      <article class="panel card">{children}</article>
    </div>
  );
}

/** Auth layout for /login and /signup: just the brand and a centered card. */
export function AuthLayout({ children }: LayoutProps) {
  return (
    <main class="auth">
      <a class="brand" href="/about">
        <span class="brand-mark" aria-hidden="true">✓</span> yerd todos
      </a>
      <section class="panel card auth-card">{children}</section>
    </main>
  );
}

/** Who's here: rendered per request, so it can read the session even on a prerendered page. */
function AccountCta() {
  const me = auth.current();
  if (!me) {
    return (
      <>
        <a class="btn btn-ghost" href="/login">Log in</a>
        <a class="btn" href="/signup">Sign up</a>
      </>
    );
  }
  const { left } = resolve(TodoRepo).for(me.id).counts();
  return (
    <>
      <span class="who">@{me.name}</span>
      <a class="btn" href="/todos">Your todos · {left} left</a>
    </>
  );
}

/**
 * Marketing layout for /about: no app chrome, a big hero. /about is
 * prerendered at build time, so the account area is a <Dynamic>: the static
 * file ships a skeleton, and the runtime fills in who's signed in.
 */
export function MarketingLayout({ children }: LayoutProps) {
  return (
    <div class="marketing">
      <header data-yx-boost>
        <a class="brand" href="/todos">
          <span class="brand-mark" aria-hidden="true">✓</span> yerd todos
        </a>
        <Dynamic
          id="account-cta"
          class="cta"
          fallback={<span class="skeleton skeleton-btn" aria-label="Loading" />}
          noscript={<a class="btn" href="/todos">Open the app</a>}
        >
          {() => <AccountCta />}
        </Dynamic>
      </header>
      <main class="hero">{children}</main>
      <footer>
        <span class="pill">0 runtime dependencies</span>
        <a class="back" href="https://github.com/Toyz/yerd">github.com/Toyz/yerd</a>
      </footer>
    </div>
  );
}

/** app.errorPage(): 404s and errors render here, inside the root layout. */
export function ErrorPage({ status, message }: ErrorPageProps) {
  return (
    <main class="error-page">
      <div>
        <p class="error-code">{status}</p>
        <h1>{status === 404 ? "Nothing here" : "Something went wrong"}</h1>
        <p>{message}</p>
        <a class="btn" href="/todos">Back to your todos</a>
      </div>
    </main>
  );
}
