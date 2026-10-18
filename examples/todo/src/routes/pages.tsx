import { get, layout, prerender, redirect, route } from "@toyz/yerd";
import { MarketingLayout } from "../layouts.js";
import { auth, type User } from "../users.js";

/** Signed in: your todos. Not signed in: the about page. */
@route("/")
export class Home {
  @auth.maybeUser accessor me: User | undefined;
  @get index() {
    return redirect(this.me ? "/todos" : "/about", 302);
  }
}

/**
 * Not in the App group: root layout + marketing layout, no app chrome. Same
 * for everyone, so it's rendered once at build time (`vite build`) and served
 * as a static file.
 */
@prerender
@route("/about", { meta: { title: "About", nav: "about" } })
@layout(MarketingLayout)
export class About {
  @get page() {
    return (
      <>
        <h1>
          Todos, <em>yerd</em> style.
        </h1>
        <p class="lead">
          Every page here is a decorated class returning TSX, rendered on the server and streamed. Forms post to actions, so
          the app works with JavaScript off; with it on, a 4KB runtime morphs just the parts that changed and keeps every
          open tab in sync.
        </p>
        <div class="features">
          <div class="panel feature">
            <h3>Layouts all the way down</h3>
            <p>
              A root layout for the document, <code>@group</code> layouts for the app shell and todo cards, and this page on its
              own <code>@layout</code>.
            </p>
          </div>
          <div class="panel feature">
            <h3>Actions, not APIs</h3>
            <p>
              <code>{"<form action={this.add}>"}</code> calls a method. Arguments are signed, inputs are validated by DTO
              classes.
            </p>
          </div>
          <div class="panel feature">
            <h3>Live</h3>
            <p>
              Changes go out over Server-Sent Events. Open two tabs and watch them agree.
            </p>
          </div>
          <div class="panel feature">
            <h3>Zero runtime deps</h3>
            <p>
              Router, renderer, DI, validation, morphing: all hand-written on <code>node:*</code>.
            </p>
          </div>
        </div>
      </>
    );
  }
}

/**
 * Build-time JSON: written to dist/client/config.json by `vite build` and
 * served as a file. Reading request data here (query, headers, session...)
 * would fail the build instead of freezing one request's data.
 */
@prerender
@route("/config.json")
export class PublicConfig {
  @get config() {
    return {
      name: "yerd todos",
      builtAt: new Date().toISOString(),
      features: ["accounts", "actions", "live-sync", "ndjson", "prerender"],
    };
  }
}
