import { Dynamic, Region, Scripts, Styles, Stylesheet, assetUrl, css, currentContext, raw, resolve, type ErrorPageProps, type LayoutProps } from "@toyz/yerd";

// App-wide rules (not scoped): <Styles /> writes them, or links the build's stylesheet.
css.global`:root { --bazaar-glow: rgba(214, 69, 43, 0.5); }`;
import { Presence } from "./shop.js";
import { Viewer } from "./viewer.js";
import { LogoutRoute } from "./routes/auth.js";

declare module "@toyz/yerd" {
  interface PageMeta {
    /** Which nav item is active. */
    area?: "shop" | "catalog" | "lookbook" | "chat" | "cart" | "orders" | "about" | "features" | "dashboard" | "products" | "admin-orders" | "board" | "event-log";
    /** The page's absolute URL, for <link rel="canonical"> and og:url. */
    url?: string;
    /** Set on the image of a product page, for og:image. */
    image?: string;
    /** false leaves the client runtime out (the crawler pages have nothing to enhance). */
    scripts?: boolean;
  }
}

/**
 * Development: not NODE_ENV=production (the built server.js defaults to
 * production), and, belt and braces, not a `vite build` either (which sets
 * import.meta.env.DEV to false at build time, whatever NODE_ENV says).
 */
const DEVELOPMENT = process.env.NODE_ENV !== "production" && import.meta.env?.DEV !== false;

/** The logo: trusted, hand-written SVG, so raw() writes it as is. */
const LOGO = raw(
  `<svg class="logo" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><path d="M16 1 27 22H5Z" fill="#d6452b"/><circle cx="16" cy="25" r="6" fill="#f2c9a5"/><path d="M9 25q7 10 14 0q-2 6-7 6t-7-6Z" fill="#fff"/></svg>`,
);

/**
 * Root layout: the document. Every HTML response goes through it (error
 * pages too). The theme lives in the session, so it's on <body>: a boosted
 * page swap morphs the body, attributes included.
 */
export function RootLayout({ children, meta }: LayoutProps) {
  const title = meta.title ? `${meta.title} · Yerd Bazaar` : "Yerd Bazaar";
  const description = meta.description ?? "Absurd yard goods, sold live. A kitchen-sink example app for the yerd web framework.";
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="description" content={description} />
        <meta name="theme-color" content="#d6452b" />
        <title>{title}</title>
        <meta property="og:site_name" content="Yerd Bazaar" />
        <meta property="og:title" content={meta.title ?? "Yerd Bazaar"} />
        <meta property="og:description" content={description} />
        {meta.image ? <meta property="og:image" content={meta.image} /> : null}
        {meta.url ? (
          <>
            <meta property="og:url" content={meta.url} />
            <link rel="canonical" href={meta.url} />
          </>
        ) : null}
        <link rel="icon" href={assetUrl("src/hero.svg")} type="image/svg+xml" />
        <Stylesheet href="src/styles.css" />
        <Styles />
        {/* Auto mode: every same-origin link and form goes through the runtime, no data-yx-* needed. */}
        {meta.scripts === false ? null : <Scripts auto />}
      </head>
      <body data-theme={resolve(Viewer).theme}>{children}</body>
    </html>
  );
}

/** The cart link in the top bar. A Region, so add-to-cart and quantity changes update it in place. */
export function CartBadge({ count }: { count: number }) {
  return (
    <Region id="cart-badge" as="a" href="/cart" class="cart-badge" prefetch aria-label={`Cart, ${count} item${count === 1 ? "" : "s"}`}>
      Cart <span class={["badge", { zero: count === 0 }]}>{count}</span>
    </Region>
  );
}

/** Light or dark, kept in the session. A plain POST form: it works without JavaScript too. */
export function ThemeToggle() {
  const theme = resolve(Viewer).theme;
  return (
    <form class="theme-toggle" method="post" action="/theme">
      <button class="btn btn-ghost" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>{theme === "dark" ? "Light" : "Dark"}</button>
    </form>
  );
}

function Account() {
  const { me } = resolve(Viewer);
  if (!me) {
    const ctx = currentContext();
    return <a class="btn btn-ghost" href={`/login?next=${encodeURIComponent(ctx.path + ctx.url.search)}`}>Log in</a>;
  }
  return (
    <form class="account" action={LogoutRoute.prototype.out}>
      <span class="who">@{me.name}</span>
      <button class="btn btn-ghost">Log out</button>
    </form>
  );
}

/**
 * Shop shell (layout of the `Shop` group): top bar, live sales ticker, nav.
 * Layouts are components, so they resolve services: the cart count comes
 * from the scoped Viewer.
 */
export function ShopShell({ children, meta }: LayoutProps) {
  const viewer = resolve(Viewer);
  const nav = (href: string, label: string, key: NonNullable<typeof meta.area>) => (
    <a href={href} prefetch aria-current={meta.area === key ? "page" : undefined}>{label}</a>
  );
  return (
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="/">{LOGO} Yerd Bazaar</a>
        <nav class="nav" aria-label="Main">
          {nav("/", "Shop", "shop")}
          {nav("/products", "Catalog", "catalog")}
          {nav("/lookbook", "Lookbook", "lookbook")}
          {nav("/chat", "Chat", "chat")}
          {viewer.me ? nav("/orders", "My orders", "orders") : null}
          {nav("/features", "Features", "features")}
          {nav("/about", "About", "about")}
          {viewer.staff ? <a href="/admin" prefetch>Back office</a> : null}
        </nav>
        <div class="topbar-end">
          <ThemeToggle />
          <CartBadge count={viewer.cartCount} />
          <Account />
        </div>
      </header>
      {/* A custom attribute's client half opens the EventSource; the server only writes the URL. */}
      <p class="ticker" ticker="/sales/ticker" aria-live="polite">The Bazaar is open. Sales show up here as they happen.</p>
      <main>{children}</main>
      <footer class="footer-note">
        <a href="/features">Tour every feature</a> · <a href="/returns">Guest returns</a> · <a href="/products/philosophical-gnome/embed">Embed a product</a> ·{" "}
        <a href="/api/products">REST API</a>
        <br />
        Yerd Bazaar is a <a href="https://github.com/Toyz/yerd">yerd</a> example. Nothing here is for sale, least of all the rocks.
      </footer>
    </div>
  );
}

/** "3 people browsing": per request, so on the prerendered /about it's filled in by the runtime. */
function OnlineNow() {
  const online = resolve(Presence).online;
  return <span class="pill">{online === 1 ? "1 shopper" : `${online} shoppers`} browsing right now</span>;
}

/**
 * Marketing layout for /about: no shop chrome. /about is prerendered, so the
 * per-visitor parts are <Dynamic>: the static file ships the fallback, and
 * the runtime fetches the real thing after the page loads (one request for both).
 */
export function MarketingLayout({ children }: LayoutProps) {
  return (
    <div class="marketing">
      <header>
        <a class="brand" href="/">{LOGO} Yerd Bazaar</a>
        <Dynamic id="online-now" as="span" fallback={<span class="skeleton skeleton-pill" aria-label="Loading" />} noscript={<span class="pill">Open daily</span>}>
          {() => <OnlineNow />}
        </Dynamic>
        <Dynamic id="about-account" class="cta" fallback={<span class="skeleton skeleton-btn" aria-label="Loading" />} noscript={<a class="btn" href="/">Visit the shop</a>}>
          {() => {
            const { me } = resolve(Viewer);
            return me ? <a class="btn" href="/">Back to shopping, @{me.name}</a> : <a class="btn" href="/login">Log in</a>;
          }}
        </Dynamic>
      </header>
      <main class="hero">{children}</main>
    </div>
  );
}

/** The back office (layout of the `Admin` group): a sidebar, and its own live hook per page. */
export function AdminLayout({ children, meta }: LayoutProps) {
  const { me } = resolve(Viewer);
  const nav = (href: string, label: string, key: NonNullable<typeof meta.area>) => (
    <a href={href} prefetch aria-current={meta.area === key ? "page" : undefined}>{label}</a>
  );
  return (
    <div class="admin">
      <aside class="sidebar">
        <a class="brand" href="/admin">{LOGO} Back office</a>
        <nav aria-label="Back office">
          {nav("/admin", "Dashboard", "dashboard")}
          {nav("/admin/products", "Products", "products")}
          {nav("/admin/orders", "Orders", "admin-orders")}
          {nav("/admin/board", "Staff board", "board")}
          {nav("/admin/event-log", "Event log", "event-log")}
          <a href="/">Back to the shop</a>
          <a href="/features">Feature tour</a>
        </nav>
        <div class="sidebar-end">
          <span class="who">@{me?.name}</span>
          <ThemeToggle />
        </div>
      </aside>
      <main class="admin-main">{children}</main>
    </div>
  );
}

/** /login and /signup: the brand and a centered card. */
export function AuthLayout({ children }: LayoutProps) {
  return (
    <main class="auth">
      <a class="brand" href="/">{LOGO} Yerd Bazaar</a>
      <section class="panel auth-card">{children}</section>
    </main>
  );
}

/** A receipt card, picked at return time with `res(<Receipt />, { layout: ReceiptCard })`. */
export function ReceiptCard({ children }: LayoutProps) {
  return <article class="panel receipt">{children}</article>;
}

/**
 * app.errorPage(): 404s, guards' 403s and crashes render here, inside the
 * root layout. `message` is always safe to show; `error` is what was thrown,
 * so in development a crash shows its stack (never in production, where it
 * could leak internals).
 */
export function ErrorPage({ status, message, error }: ErrorPageProps) {
  const stack = DEVELOPMENT && status >= 500 && error instanceof Error ? error.stack : undefined;
  const title = status === 404 ? "This aisle doesn't exist" : status === 403 ? "Staff only" : status === 503 ? "Back in a moment" : "Something fell off a shelf";
  return (
    <main class="error-page">
      <div>
        <p class="error-code">{status}</p>
        <h1>{title}</h1>
        <p>{message}</p>
        {stack ? (
          <details class="stack" open>
            <summary>Stack trace (development only)</summary>
            <pre>{stack}</pre>
          </details>
        ) : null}
        <a class="btn" href="/">Back to the shop</a>
      </div>
    </main>
  );
}
