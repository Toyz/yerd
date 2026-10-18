import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Styles, Stylesheet, assetUrl, css, get, prerender, resetManifest, route, yerd } from "@toyz/yerd";
import { resetCssBundle } from "../../src/render/css.js";

afterEach(() => {
  resetManifest();
  resetCssBundle();
});

const box = css`margin: 4px; --base-test: 1;`;

@route("/")
@prerender()
class Home {
  @get page() {
    return (
      <html>
        <head>
          <Stylesheet href="src/app.css" />
          <Styles />
        </head>
        <body class={box}>
          <img src={assetUrl("src/logo.svg")} alt="" />
        </body>
      </html>
    );
  }
}

/** A client build: manifest, two hashed files, and the css record a build leaves. */
function clientDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yerd-base-"));
  mkdirSync(join(dir, ".vite"));
  mkdirSync(join(dir, "assets"));
  mkdirSync(join(dir, ".yerd"));
  writeFileSync(join(dir, ".vite", "manifest.json"), JSON.stringify({
    "src/app.css": { file: "assets/app-AbC12345.css" },
    "src/logo.svg": { file: "assets/logo-XyZ98765.svg" },
  }));
  writeFileSync(join(dir, "assets", "app-AbC12345.css"), "body{}");
  writeFileSync(join(dir, "assets", "logo-XyZ98765.svg"), "<svg/>");
  writeFileSync(join(dir, "assets", "yerd-test0001.css"), `.${box}{margin:4px}`);
  writeFileSync(join(dir, ".yerd", "css.json"), JSON.stringify({ file: "assets/yerd-test0001.css", classes: [box] }));
  return dir;
}

describe("Vite's base", () => {
  it("prefixes assets, the css bundle and the static mount with a path base", async () => {
    const dir = clientDir();
    const app = yerd({ routes: [Home], services: [], handleSignals: false }).clientBuild(dir, join(dir, ".vite", "manifest.json"), { base: "/app/" });
    const html = await (await app.request("/")).text();
    expect(html).toContain('<link rel="stylesheet" href="/app/assets/app-AbC12345.css">');
    expect(html).toContain('<link rel="stylesheet" href="/app/assets/yerd-test0001.css">');
    expect(html).toContain('src="/app/assets/logo-XyZ98765.svg"');
    expect(html).not.toContain("data-yx-css=");
    expect((await app.request("/app/assets/yerd-test0001.css")).status).toBe(200);
    expect((await app.request("/app/assets/logo-XyZ98765.svg")).status).toBe(200);
    expect((await app.request("/assets/logo-XyZ98765.svg")).status).toBe(404);
    await app.stop();
  });

  it("links a CDN base and serves the files from / for it to pull", async () => {
    const dir = clientDir();
    const app = yerd({ routes: [Home], services: [], handleSignals: false }).clientBuild(dir, join(dir, ".vite", "manifest.json"), { base: "https://cdn.example.com/shop" });
    const html = await (await app.request("/")).text();
    expect(html).toContain('href="https://cdn.example.com/shop/assets/yerd-test0001.css"');
    expect(html).toContain('src="https://cdn.example.com/shop/assets/logo-XyZ98765.svg"');
    expect((await app.request("/assets/yerd-test0001.css")).status).toBe(200);
    await app.stop();
  });

  it("treats a relative base as /", async () => {
    const dir = clientDir();
    const app = yerd({ routes: [Home], services: [], handleSignals: false }).clientBuild(dir, join(dir, ".vite", "manifest.json"), { base: "./" });
    expect(await (await app.request("/")).text()).toContain('href="/assets/yerd-test0001.css"');
    await app.stop();
  });

  it("reads an older css.json that stored an href", async () => {
    const dir = clientDir();
    writeFileSync(join(dir, ".yerd", "css.json"), JSON.stringify({ href: "/assets/yerd-test0001.css", classes: [box] }));
    const app = yerd({ routes: [Home], services: [], handleSignals: false }).clientBuild(dir, join(dir, ".vite", "manifest.json"));
    expect(await (await app.request("/")).text()).toContain('href="/assets/yerd-test0001.css"');
    await app.stop();
  });

  it("prerenders with the base: the written page links under it", async () => {
    const out = clientDir();
    const app = yerd({ routes: [Home], services: [], handleSignals: false });
    await app.prerender(out, { base: "/app/" });
    await app.stop();
    const { readFileSync } = await import("node:fs");
    const page = readFileSync(join(out, "index.html"), "utf8");
    expect(page).toMatch(/<link rel="stylesheet" href="\/app\/assets\/yerd-[a-z0-9]+\.css">/);
    expect(page).toContain('href="/app/assets/app-AbC12345.css"');
  });
});
