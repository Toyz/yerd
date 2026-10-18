import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Region, Styles, action, css, get, keyframes, prerender, renderToString, resetManifest, route, yerd } from "@toyz/yerd";
import { cssBundleClasses, cssBundleHash, cssBundleText, resetCssBundle, useCssBundle } from "../../src/render/css.js";

afterEach(() => {
  resetCssBundle();
  resetManifest();
});

css.global`:root { --edge-bundle: 1; }`;
const fade = keyframes`from { opacity: 0; } /* edge-bundle */`;
const panel = css`border: 1px solid; --edge-bundle: panel;`;
const row = css`display: flex; --edge-bundle: row;`;
const appear = css`animation: ${fade} 0.3s; --edge-bundle: appear;`;

/** The class names, in order, of every <style data-yx-css> in some HTML. */
function sent(html: string): string[] {
  return [...html.matchAll(/<style data-yx-css="([^"]+)">/g)].map((m) => m[1]!);
}

function links(html: string): string[] {
  return [...html.matchAll(/<link rel="stylesheet" href="([^"]*)">/g)].map((m) => m[1]!);
}

const tmp = (label: string) => mkdtempSync(join(tmpdir(), `yerd-edge-css-${label}-`));

describe("useCssBundle: a partial set", () => {
  it("inlines only what the bundle doesn't have", async () => {
    useCssBundle("/b.css", [panel]);
    const html = await renderToString(<div class={[panel, row]} />);
    expect(sent(html)).toEqual([row]);
  });

  it("inlines classes registered after the build", async () => {
    useCssBundle("/b.css", cssBundleClasses());
    const late = css`--registered-late: 1;`;
    const html = await renderToString(<div class={[panel, late]} />);
    expect(sent(html)).toEqual([late]);
  });

  it("inlines a class's keyframes when the bundle lacks them, even if it has the class", async () => {
    useCssBundle("/b.css", [appear]);
    expect(sent(await renderToString(<div class={appear} />))).toEqual([fade]);
  });

  it("doesn't inline keyframes the bundle has, for a class it lacks", async () => {
    useCssBundle("/b.css", [fade]);
    expect(sent(await renderToString(<div class={appear} />))).toEqual([appear]);
  });

  it("inlines everything with an empty class list (but still links the file)", async () => {
    useCssBundle("/b.css", []);
    const html = await renderToString(
      <html>
        <head>
          <Styles />
        </head>
        <body class={row} />
      </html>,
    );
    expect(links(html)).toEqual(["/b.css"]);
    expect(sent(html)).toEqual([row]);
  });

  it("ignores names in the list that were never registered", async () => {
    useCssBundle("/b.css", ["yx-nothing", "not-a-class"]);
    expect(sent(await renderToString(<div class={panel} />))).toEqual([panel]);
  });

  it("goes back to inlining after resetCssBundle", async () => {
    useCssBundle("/b.css", cssBundleClasses());
    expect(sent(await renderToString(<div class={panel} />))).toEqual([]);
    resetCssBundle();
    expect(sent(await renderToString(<div class={panel} />))).toEqual([panel]);
  });

  it("uses the latest bundle when called twice", async () => {
    useCssBundle("/one.css", [panel]);
    useCssBundle("/two.css", [row]);
    const html = await renderToString(<head><Styles /><b class={[panel, row]} /></head>);
    expect(links(html)).toEqual(["/two.css"]);
    expect(sent(html)).toEqual([panel]);
  });
});

describe("<Styles />", () => {
  it("writes the globals in development", async () => {
    const html = await renderToString(<head><Styles /></head>);
    expect(html).toContain('<style data-yx-css="global">');
    expect(html).toContain(":root { --edge-bundle: 1; }");
    expect(links(html)).toEqual([]);
  });

  it("links the bundle instead once there is one, with no globals inline", async () => {
    useCssBundle("/assets/yerd-x.css", cssBundleClasses());
    const html = await renderToString(<head><Styles /></head>);
    expect(html).toBe('<head><link rel="stylesheet" href="/assets/yerd-x.css"></head>');
  });

  it("is the same output when rendered twice in one page (it doesn't track the page)", async () => {
    const html = await renderToString(<head><Styles /><Styles /></head>);
    expect(html.split('data-yx-css="global"')).toHaveLength(3);
  });

  it.each([
    ['/a.css?v="1"', "/a.css?v=&quot;1&quot;"],
    ["/a.css?x=1&copy=2", "/a.css?x=1&amp;copy=2"],
    ['/a"><script>alert(1)</script>.css', "/a&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;.css"],
    ["/a'b.css", "/a&#39;b.css"],
  ])("escapes the href %j", async (href, escaped) => {
    useCssBundle(href, []);
    const html = await renderToString(<Styles />);
    expect(html).toBe(`<link rel="stylesheet" href="${escaped}">`);
    expect(html).not.toContain("<script");
  });
});

describe("the bundle's text", () => {
  it("holds globals first, then every class and keyframes", () => {
    const text = cssBundleText();
    expect(text.startsWith(":root { --edge-bundle: 1; }")).toBe(true);
    for (const name of [panel, row, appear]) expect(text).toContain(`.${name}{`);
    expect(text).toContain(`@keyframes ${fade}{`);
  });

  it("lists keyframes among the bundle's names, so they aren't inlined either", () => {
    expect(cssBundleClasses()).toEqual(expect.arrayContaining([panel, row, appear, fade]));
  });

  it("hashes the same text to the same file name", () => {
    expect(cssBundleHash(cssBundleText())).toBe(cssBundleHash(cssBundleText()));
  });
});

@route("/bundle-static")
@prerender()
class StaticPage {
  @get page() {
    return (
      <html>
        <head>
          <Styles />
        </head>
        <body class={panel}>
          <p class={appear}>hi</p>
        </body>
      </html>
    );
  }
}

@route("/bundle-live")
class LivePage {
  @get page() {
    return (
      <html>
        <head>
          <Styles />
        </head>
        <body class={row}>
          <Region id="list" as="ul" class={panel}>
            <li class={appear}>one</li>
          </Region>
          <form action={this.more}>
            <button>more</button>
          </form>
        </body>
      </html>
    );
  }

  @action more() {
    return (
      <Region id="list" as="ul" class={panel}>
        <li class={appear}>one</li>
        <li class={[appear, row]}>two</li>
      </Region>
    );
  }
}

interface CssRecord {
  file: string;
  classes: string[];
  /** Where it's served with the default base: "/" + file. */
  href: string;
}

function record(out: string): CssRecord {
  const raw = JSON.parse(readFileSync(join(out, ".yerd", "css.json"), "utf8")) as Omit<CssRecord, "href">;
  return { ...raw, href: `/${raw.file}` };
}

async function build(routes: Function[] = [StaticPage]): Promise<string> {
  const out = tmp("build");
  const app = yerd({ routes, services: [], handleSignals: false });
  await app.prerender(out);
  await app.stop();
  return out;
}

describe("prerender writes the bundle", () => {
  it("writes the stylesheet with every rule, and css.json naming it", async () => {
    const out = await build();
    const rec = record(out);
    expect(rec.href).toMatch(/^\/assets\/yerd-[0-9a-z]{2,10}\.css$/);
    expect(readFileSync(join(out, rec.href), "utf8")).toBe(cssBundleText());
    expect(rec.classes).toEqual(cssBundleClasses());
    expect(rec.href).toBe(`/assets/yerd-${cssBundleHash(cssBundleText())}.css`);
  });

  it("makes the prerendered page link it and inline nothing", async () => {
    const out = await build();
    const html = readFileSync(join(out, "bundle-static", "index.html"), "utf8");
    expect(links(html)).toEqual([record(out).href]);
    expect(sent(html)).toEqual([]);
  });

  it("names the file by content: the same rules, the same name", async () => {
    const one = record(await build()).href;
    const two = record(await build()).href;
    expect(one).toBe(two);
  });

  it("changes the name when a rule is added", async () => {
    const before = record(await build()).href;
    css`--added-between-builds: 1;`;
    const after = await build();
    expect(record(after).href).not.toBe(before);
    expect(readFileSync(join(after, record(after).href), "utf8")).toContain("--added-between-builds: 1;");
    // Only the current file is written.
    expect(readdirSync(join(after, "assets")).filter((f) => f.endsWith(".css"))).toEqual([record(after).href.slice("/assets/".length)]);
  });

  it("changes the name when a global is added", async () => {
    const before = record(await build()).href;
    css.global`html { --added-global-between-builds: 1; }`;
    expect(record(await build()).href).not.toBe(before);
  });

  it("writes the bundle even with no @prerender routes (the vite plugin always calls prerender)", async () => {
    const out = await build([LivePage]);
    expect(existsSync(join(out, ".yerd", "css.json"))).toBe(true);
    expect(existsSync(join(out, record(out).href))).toBe(true);
  });

  it("writes css.json as plain JSON with only file and classes", async () => {
    const out = await build();
    const parsed = JSON.parse(readFileSync(join(out, ".yerd", "css.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["classes", "file"]);
  });

  it("leaves the build's bundle in use for pages rendered after it in the same process", async () => {
    const out = await build();
    const html = await renderToString(<head><Styles /><b class={panel} /></head>);
    expect(links(html)).toEqual([record(out).href]);
    expect(sent(html)).toEqual([]);
  });
});

/** A client build directory as `vite build` leaves it, plus what prerender adds. */
// An older-format record (an href): clientBuild still reads it.
function clientDir(rec?: { href: string; classes: string[] }, cssText = ".x{}"): { dir: string; manifest: string } {
  const dir = tmp("client");
  mkdirSync(join(dir, ".vite"), { recursive: true });
  writeFileSync(join(dir, ".vite", "manifest.json"), "{}");
  if (rec) {
    mkdirSync(join(dir, ".yerd"), { recursive: true });
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, ".yerd", "css.json"), JSON.stringify(rec));
    writeFileSync(join(dir, rec.href.replace(/^\//, "")), cssText);
  }
  return { dir, manifest: join(dir, ".vite", "manifest.json") };
}

describe("clientBuild reads the bundle", () => {
  it("links it, stops inlining its classes, and serves the file", async () => {
    const { dir, manifest } = clientDir({ href: "/assets/yerd-test1.css", classes: [panel, row, fade] }, "/* the bundle */");
    const app = yerd({ routes: [LivePage], services: [], handleSignals: false, secret: "s".repeat(32) }).clientBuild(dir, manifest);
    const client = app.client();
    const html = await client.page("/bundle-live");
    expect(links(html)).toEqual(["/assets/yerd-test1.css"]);
    expect(sent(html)).toEqual([appear]);
    const file = await client.request("/assets/yerd-test1.css");
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toMatch(/^text\/css/);
    expect(await file.text()).toBe("/* the bundle */");
    await app.stop();
  });

  it("leaves pages inlining when the build had no css (no css.json)", async () => {
    const { dir, manifest } = clientDir();
    const app = yerd({ routes: [LivePage], services: [], handleSignals: false, secret: "s".repeat(32) }).clientBuild(dir, manifest);
    const html = await app.client().page("/bundle-live");
    expect(links(html)).toEqual([]);
    expect(sent(html).filter((n) => n !== "global")).toEqual([row, panel, fade, appear]);
    await app.stop();
  });

  it("round-trips: prerender's output, served by clientBuild", async () => {
    const out = await build();
    resetCssBundle();
    mkdirSync(join(out, ".vite"), { recursive: true });
    writeFileSync(join(out, ".vite", "manifest.json"), "{}");
    const app = yerd({ routes: [LivePage], services: [], handleSignals: false, secret: "s".repeat(32) }).clientBuild(out, join(out, ".vite", "manifest.json"));
    const client = app.client();
    const html = await client.page("/bundle-live");
    const rec = record(out);
    expect(links(html)).toEqual([rec.href]);
    expect(sent(html)).toEqual([]);
    expect(await (await client.request(rec.href)).text()).toBe(cssBundleText());
    await app.stop();
  });
});

describe("actions repeat the rules they use", () => {
  it("sends the page's rules with the page and again with the fragment", async () => {
    const app = yerd({ routes: [LivePage], services: [], handleSignals: false, secret: "s".repeat(32) });
    const client = app.client();
    const page = await client.page("/bundle-live");
    expect(sent(page).filter((n) => n !== "global")).toEqual([row, panel, fade, appear]);
    const fragment = await (await client.action("/bundle-live")).text();
    expect(sent(fragment)).toEqual([panel, fade, appear, row]);
    // Each once per response.
    for (const name of [panel, fade, appear, row]) expect(fragment.split(`data-yx-css="${name}"`)).toHaveLength(2);
    await app.stop();
  });

  it("sends nothing inline with the bundle in use, except what it lacks", async () => {
    useCssBundle("/b.css", [panel, fade, appear]);
    const app = yerd({ routes: [LivePage], services: [], handleSignals: false, secret: "s".repeat(32) });
    const fragment = await (await app.client().action("/bundle-live")).text();
    expect(sent(fragment)).toEqual([row]);
    await app.stop();
  });

  it("keeps separate requests' rules apart under load", async () => {
    const app = yerd({ routes: [LivePage], services: [], handleSignals: false, secret: "s".repeat(32) });
    const client = app.client();
    const pages = await Promise.all(Array.from({ length: 30 }, () => client.page("/bundle-live")));
    for (const page of pages) expect(sent(page).filter((n) => n !== "global")).toEqual([row, panel, fade, appear]);
    await app.stop();
  });
});

describe("a real vite build", () => {
  it("serves a fixture app from `vite build`: bundle linked, nothing inline, the file served", { timeout: 120_000 }, async () => {
    const root = tmp("vite");
    try {
      const src = (path: string) => join(process.cwd(), "src", path);
      mkdirSync(join(root, "src"), { recursive: true });
      // An ESM package, as a yerd app is (the plugin loads dist/server/*.js).
      writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(join(root, "src", "site.css"), "body { margin: 0; }\n");
      writeFileSync(
        join(root, "src", "main.tsx"),
        [
          `import { Styles, Stylesheet, css, get, keyframes, route, yerd } from "@toyz/yerd";`,
          `css.global\`:root { --fixture: 1; }\`;`,
          `const pulse = keyframes\`50% { opacity: 0.5; }\`;`,
          `const box = css\`padding: 3px; animation: \${pulse} 1s;\`;`,
          `@route("/")`,
          `class Home {`,
          `  @get page() {`,
          `    return (`,
          `      <html><head><Stylesheet href="src/site.css" /><Styles /></head>`,
          `      <body><div class={box}>fixture</div></body></html>`,
          `    );`,
          `  }`,
          `}`,
          `export default yerd({ routes: [Home], services: [], handleSignals: false });`,
          ``,
        ].join("\n"),
      );
      const { createBuilder } = await import("vite");
      const { default: yerdPlugin } = await import("../../src/vite/index.js");
      const builder = await createBuilder({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [yerdPlugin({ entry: "/src/main.tsx", client: ["src/site.css"] })],
        resolve: {
          alias: [
            { find: "@toyz/yerd/jsx-runtime", replacement: src("jsx/jsx-runtime.ts") },
            { find: "@toyz/yerd/jsx-dev-runtime", replacement: src("jsx/jsx-dev-runtime.ts") },
            { find: /^@toyz\/yerd$/, replacement: src("index.ts") },
          ],
        },
      });
      await builder.buildApp();

      const client = join(root, "dist", "client");
      const rec = record(client);
      expect(rec.href).toMatch(/^\/assets\/yerd-[0-9a-z]+\.css$/);
      const bundle = readFileSync(join(client, rec.href), "utf8");
      expect(bundle).toContain(":root { --fixture: 1; }");
      expect(bundle).toMatch(/@keyframes yx-k-[0-9a-z]+\{50% \{ opacity: 0\.5; \}\}/);
      expect(bundle).toMatch(/\.yx-[0-9a-z]+\{padding: 3px; animation: yx-k-[0-9a-z]+ 1s;\}/);

      // The production server the build generated, in its own process.
      const { spawn } = await import("node:child_process");
      const server = spawn(process.execPath, [join(root, "dist", "server", "server.js")], {
        env: { ...process.env, PORT: "0", HOST: "127.0.0.1", NODE_ENV: "production" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        const url = await new Promise<string>((resolve, reject) => {
          let out = "";
          const timer = setTimeout(() => reject(new Error(`server didn't start: ${out}`)), 30_000);
          const onData = (data: Buffer) => {
            out += data.toString();
            const match = /listening on (\S+)/.exec(out);
            if (match) {
              clearTimeout(timer);
              resolve(match[1]!);
            }
          };
          server.stdout!.on("data", onData);
          server.stderr!.on("data", onData);
          server.once("exit", (code) => reject(new Error(`server exited (${code}): ${out}`)));
        });
        const html = await (await fetch(url.replace(/\/$/, "") + "/")).text();
        expect(html).toContain(`<link rel="stylesheet" href="${rec.href}">`);
        expect(html).not.toContain("data-yx-css");
        expect(html).toMatch(/class="yx-[0-9a-z]+"/);
        const css = await fetch(url.replace(/\/$/, "") + rec.href);
        expect(css.status).toBe(200);
        expect(css.headers.get("content-type")).toMatch(/^text\/css/);
        expect(await css.text()).toBe(bundle);
      } finally {
        server.kill();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
