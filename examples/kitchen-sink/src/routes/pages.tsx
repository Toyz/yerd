import { get, header, inject, layout, post, prerender, redirect, route, session, type Session } from "@toyz/yerd";
import { safeNext } from "@toyz/yerd/auth";
import { Catalog } from "../catalog.js";
import { MarketingLayout, RootLayout } from "../layouts.js";
import type { Prefs } from "../viewer.js";

/**
 * Not in the Shop group: root layout + marketing layout, named in one
 * decorator, outermost first (RootLayout is already the app's, and a layout
 * is never applied twice). Same for everyone, so `vite build` renders it once
 * to a static file; the per-visitor corners are <Dynamic> parts in the layout.
 */
@prerender
@route("/about", { meta: { title: "About the Bazaar", area: "about" } })
@layout(RootLayout, MarketingLayout)
export class About {
  @get page() {
    return (
      <>
        <h1>
          A shop, a chat room and a back office, <em>one framework</em>.
        </h1>
        <p class="lead">
          Yerd Bazaar is the kitchen-sink example for yerd: every page is a decorated class returning TSX, rendered on the
          server and progressively enhanced by an 8 KB runtime. It sells nothing, extremely well.
        </p>
        <div class="features">
          <div class="panel feature">
            <h3>Live</h3>
            <p>A made-up crowd buys something every few seconds (<code>@every</code>); the ticker and the dashboard hear about it over SSE.</p>
          </div>
          <div class="panel feature">
            <h3>Actions everywhere</h3>
            <p>Typeahead, infinite scroll, drag and drop, file drops and polling, all as <code>action=</code> lambdas. No client code.</p>
          </div>
          <div class="panel feature">
            <h3>Prerendered</h3>
            <p>This page is a static file in production. The shopper count above is a <code>&lt;Dynamic&gt;</code> part, filled in after load.</p>
          </div>
          <div class="panel feature">
            <h3>Zero runtime deps</h3>
            <p>Router, renderer, DI, validation, sessions, auth and morphing: all written on <code>node:*</code>.</p>
          </div>
        </div>
        <p>
          <a class="btn" href="/">Go shopping</a>
        </p>
      </>
    );
  }
}

/** Light or dark: a session value, flipped by a plain POST, then back to the page it came from. */
@route("/theme")
export class Theme {
  @session accessor prefs!: Session<Prefs>;
  @header("referer") accessor referer: string | undefined;

  @post toggle() {
    this.prefs.theme = this.prefs.theme === "dark" ? "light" : "dark";
    return redirect(this.#back());
  }

  /** The referring page's path; safeNext turns "//evil.example" and friends into the shop. */
  #back(): string {
    if (!this.referer || !URL.canParse(this.referer)) return "/";
    const url = new URL(this.referer);
    return safeNext(url.pathname + url.search, "/");
  }
}

/**
 * Plain text, from a string: the shelf as it stood when `vite build` ran (a
 * prerendered route uses services like any other). Not a page, so it stays
 * out of the sitemap.
 */
@prerender
@route("/shelf.txt", { sitemap: false })
export class Shelf {
  @inject(Catalog) accessor catalog!: Catalog;

  @get txt() {
    return this.catalog.all().map((product) => `${product.name}\n`).join("");
  }
}
