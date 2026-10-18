import { Region, Scripts, Stylesheet, currentContext, type ErrorPageProps, type LayoutProps } from "@toyz/yerd";
import { Cart } from "./cart.js";
import { auth } from "./users.js";

/** The cart link in the header. A Region, so cart actions can send a new count. */
export function CartBadge({ count }: { count: number }) {
  return (
    <Region id="cart-badge" as="a" href="/cart" class="cart-badge">
      Cart <span class="badge">{count}</span>
    </Region>
  );
}

/** Items in the visitor's cart; 0 on routes without a session (the API, the stock feed). */
function cartCount(): number {
  const ctx = currentContext();
  return ctx.route.session === false ? 0 : ctx.session.as(Cart).count;
}

/** The document. Every HTML response goes through it, error pages included. */
export function RootLayout({ children, meta }: LayoutProps) {
  const me = auth.current();
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{meta.title ? `${meta.title} · Paperyard` : "Paperyard"}</title>
        <Stylesheet href="src/styles.css" />
        <Scripts />
      </head>
      <body>
        <header class="top">
          <a class="brand" href="/">Paperyard</a>
          <CartBadge count={cartCount()} />
          {me ? (
            // A POST, not a link: a prefetch or a crawler must not sign anyone out.
            <form class="account" method="post" action="/logout">
              {me.name} <button class="link">Sign out</button>
            </form>
          ) : (
            <a class="account" href="/login">Sign in</a>
          )}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}

/** A narrow column for forms: sign-in, checkout, the order receipt. */
export function Narrow({ children }: LayoutProps) {
  return <div class="narrow">{children}</div>;
}

/** app.errorPage(): 404s and crashes render here, inside RootLayout. */
export function ErrorPage({ status, message }: ErrorPageProps) {
  return (
    <section class="error-page">
      <p class="status">{status}</p>
      <h1>{status === 404 ? "Not on the shelves" : "Something went wrong"}</h1>
      <p>{message}</p>
      <a href="/">Back to the shop</a>
    </section>
  );
}
