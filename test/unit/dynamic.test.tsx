import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dynamic, currentContext, get, prerender, renderToString, resetManifest, route, yerd, type LayoutProps } from "@toyz/yerd";

const page = (
  <main>
    <h1>static</h1>
    <Dynamic id="who" as="span" class="who" fallback={<i>loading</i>}>
      {async () => <b>ada</b>}
    </Dynamic>
    <p>also static</p>
  </main>
);

describe("<Dynamic> rendering", () => {
  it("renders its children normally", async () => {
    expect(await renderToString(page)).toBe(
      '<main><h1>static</h1><span class="who" id="who" data-yx-region><b>ada</b></span><p>also static</p></main>',
    );
  });

  it("renders the fallback, marked for the runtime, when prerendering", async () => {
    expect(await renderToString(page, { dynamic: "fallback" })).toBe(
      '<main><h1>static</h1><span class="who" id="who" data-yx-region data-yx-defer><i>loading</i></span><p>also static</p></main>',
    );
  });

  it("adds a <noscript> alternative that hides the fallback when JavaScript is off", async () => {
    const html = await renderToString(
      <Dynamic id="cta" fallback={<i>loading</i>} noscript={<a href="/login">Log in</a>}>
        {() => "live"}
      </Dynamic>,
      { dynamic: "fallback" },
    );
    expect(html).toBe(
      '<div id="cta" data-yx-region data-yx-defer><i>loading</i><noscript><style>#cta>:not(noscript){display:none!important}</style><a href="/login">Log in</a></noscript></div>',
    );
    expect(await renderToString(<Dynamic id="cta" noscript={<b>x</b>}>{() => "live"}</Dynamic>)).toBe('<div id="cta" data-yx-region>live</div>');
  });

  it("refuses ids that aren't simple names", async () => {
    await expect(renderToString(<Dynamic id="a}b">{() => 1}</Dynamic>)).rejects.toThrow(/ids must be/);
  });

  it("renders nothing but the Dynamic parts for the runtime's fill-in request", async () => {
    expect(await renderToString(page, { dynamic: "only" })).toBe('<span class="who" id="who" data-yx-region><b>ada</b></span>');
  });
});

let counter = 0;

const Shell = ({ children }: LayoutProps) => (
  <html>
    <body>
      <header>
        <Dynamic id="account" fallback={<span class="skeleton" />}>
          {() => <span>visit {++counter} for {currentContext().session.get("name" as never) ?? "guest"}</span>}
        </Dynamic>
      </header>
      {children}
    </body>
  </html>
);

@prerender
@route("/landing")
class Landing {
  @get page() {
    return <h1>Welcome</h1>;
  }
}

const dir = mkdtempSync(join(tmpdir(), "yerd-dynamic-"));
mkdirSync(join(dir, ".vite"));
writeFileSync(join(dir, ".vite", "manifest.json"), "{}");
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  resetManifest();
});

describe("prerendered pages with <Dynamic> parts", () => {
  it("writes skeletons at build time and fills them per request", async () => {
    counter = 0;
    const build = yerd({ routes: [Landing], services: [], handleSignals: false, secret: "d".repeat(32) }).sessions().layout(Shell);
    await build.prerender(dir);
    // The children (which read the session) never ran at build time.
    expect(counter).toBe(0);
    expect(readFileSync(join(dir, "landing/index.html"), "utf8")).toBe(
      '<!doctype html><html><body><header><div id="account" data-yx-region data-yx-defer><span class="skeleton"></span></div></header><h1>Welcome</h1></body></html>',
    );

    const server = await yerd({ routes: [Landing], services: [], handleSignals: false, secret: "d".repeat(32) })
      .sessions()
      .layout(Shell)
      .clientBuild(dir, join(dir, ".vite", "manifest.json"))
      .listen(0, "127.0.0.1");
    try {
      // The page itself: the static file with skeletons.
      expect(await (await fetch(server.url + "/landing")).text()).toContain("data-yx-defer");
      // The runtime's fill-in request: only the Dynamic part, rendered live, not cached.
      const first = await fetch(server.url + "/landing", { headers: { "yx-dynamic": "1" } });
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(await first.text()).toBe('<div id="account" data-yx-region><span>visit 1 for guest</span></div>');
      expect(await (await fetch(server.url + "/landing", { headers: { "yx-dynamic": "1" } })).text()).toContain("visit 2");
    } finally {
      await server.close();
    }
  });
});
