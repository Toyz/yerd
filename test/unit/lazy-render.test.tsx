import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  Island, RUNTIME_PATH, Scripts, attribute, island, lazyElement, renderToString, resetAttributeRegistry, resetLazyElements,
  resetManifest, useManifest, type RunningServer,
} from "@toyz/yerd";
import { attributesSource } from "../../src/attributes/attribute.js";
import { chunkVersion } from "../../src/client/runtime.js";
import { serve } from "./edge-routing-helpers.js";

declare module "@toyz/yerd" {
  interface CustomAttributes {
    confetti?: boolean;
    "sort-me"?: string;
  }
}

const lazyHint = `<link rel="modulepreload" href="/_yerd/runtime-lazy.js?v=${chunkVersion("lazy")}">`;
const preload = (url: string) => `<link rel="modulepreload" href="${url}">`;

function Page({ children }: { children?: unknown }) {
  return (
    <html>
      <head>
        <Scripts />
      </head>
      <body>{children as never}</body>
    </html>
  );
}

afterEach(() => {
  resetAttributeRegistry();
  resetLazyElements();
  resetManifest();
});

describe("<Island>", () => {
  it("renders a <yerd-island> with the module, trigger, JSON props and the server's children", async () => {
    const html = await renderToString(
      <Island src="src/widgets/chart.client.ts" when="visible" props={{ points: [1, 2, 3], label: "Sales" }} class="chart">
        <p>1, 2, 3</p>
      </Island>,
    );
    expect(html).toMatch(/^<yerd-island class="chart" data-yx-island="\/src\/widgets\/chart.client.ts" data-yx-when="visible" data-yx-props="\{&quot;points&quot;:\[1,2,3\],&quot;label&quot;:&quot;Sales&quot;\}" data-yx-keep data-key="yx-island-[0-9a-z]{7}"><p>1, 2, 3<\/p><\/yerd-island>$/);
  });

  it("leaves out the default trigger and missing props", async () => {
    const html = await renderToString(<Island src="./src/a.client.ts" />);
    expect(html).toMatch(/^<yerd-island data-yx-island="\/src\/a.client.ts" data-yx-keep data-key="yx-island-\w+"><\/yerd-island>$/);
  });

  it("escapes props so they can't leave the attribute", async () => {
    const nasty = `"></yerd-island><script>alert('x')</script>&amp;`;
    const html = await renderToString(<Island src="src/a.client.ts" props={{ nasty }} />);
    expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/"><\/yerd-island><script/);
    const attr = /data-yx-props="([^"]*)"/.exec(html)![1]!;
    const decoded = attr.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    expect(JSON.parse(decoded)).toEqual({ nasty });
  });

  it("keys itself by module and props, so a morph keeps it while they're the same and remounts it when they change", async () => {
    const key = async (props: unknown, src = "src/a.client.ts") => /data-key="([^"]+)"/.exec(await renderToString(<Island src={src} props={props} />))![1];
    expect(await key({ n: 1 })).toBe(await key({ n: 1 }));
    expect(await key({ n: 1 })).not.toBe(await key({ n: 2 }));
    expect(await key({ n: 1 })).not.toBe(await key({ n: 1 }, "src/b.client.ts"));
    // An explicit key wins.
    expect(await renderToString(<Island key="mine" src="src/a.client.ts" />)).toContain('data-key="mine"');
  });

  it.each([
    [{ when: () => 1 }, "props.when is a function"],
    [{ at: new Date(0) }, "props.at is a Date"],
    [{ tags: new Set(["a"]) }, "props.tags is a Set"],
    [{ n: Number.NaN }, "props.n is NaN"],
    [{ n: Infinity }, "props.n is Infinity"],
    [{ big: 1n }, "props.big is a bigint"],
    [{ list: [1, undefined] }, "props.list[1] is undefined"],
    [{ "odd key": { deep: Symbol("s") } }, 'props["odd key"].deep is a symbol'],
  ])("refuses props that aren't JSON: %o", async (props, message) => {
    await expect(renderToString(<Island src="src/a.client.ts" props={props} />)).rejects.toThrow(message);
    await expect(renderToString(<Island src="src/a.client.ts" props={props} />)).rejects.toThrow(/<Island src="src\/a.client.ts">: .* island props are sent to the browser as JSON/);
  });

  it("refuses a circular props object, but allows the same object twice and undefined properties", async () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    await expect(renderToString(<Island src="src/a.client.ts" props={loop} />)).rejects.toThrow("props.self is a circular reference");
    const shared = { x: 1 };
    const html = await renderToString(<Island src="src/a.client.ts" props={{ a: shared, b: shared, gone: undefined, n: null }} />);
    expect(html).toContain("{&quot;a&quot;:{&quot;x&quot;:1},&quot;b&quot;:{&quot;x&quot;:1},&quot;n&quot;:null}");
  });

  it("checks its trigger and src", async () => {
    await expect(renderToString(<Island src="src/a.client.ts" when={"soon" as never} />)).rejects.toThrow(/when="soon" isn't a trigger/);
    await expect(renderToString(<Island src="src/a.client.ts" when={"media:" as never} />)).rejects.toThrow(/isn't a trigger/);
    await expect(renderToString(<Island src="" />)).rejects.toThrow(/needs src/);
    expect(await renderToString(<Island src="src/a.client.ts" when="media:(min-width: 40em)" />)).toContain('data-yx-when="media:(min-width: 40em)"');
  });

  it("island() makes a typed component with a default trigger", async () => {
    const Chart = island<{ points: number[] }>("src/chart.client.ts", { when: "idle" });
    const html = await renderToString(<Chart props={{ points: [4] }} id="c">fallback</Chart>);
    expect(html).toMatch(/^<yerd-island id="c" data-yx-island="\/src\/chart.client.ts" data-yx-when="idle" data-yx-props="\{&quot;points&quot;:\[4\]\}" data-yx-keep data-key="[^"]+">fallback<\/yerd-island>$/);
    expect(await renderToString(<Chart props={{ points: [] }} when="visible" />)).toContain('data-yx-when="visible"');
    // @ts-expect-error: props are required and checked
    void (<Chart />);
    // @ts-expect-error: wrong props
    void (<Chart props={{ points: "no" }} />);
    const Plain = island("src/plain.client.ts");
    expect(await renderToString(<Plain />)).not.toContain("data-yx-props");
    expect(() => island("src/x.client.ts", { when: "never" as never })).toThrow(/isn't a trigger/);
  });
});

describe("modulepreload hints", () => {
  it("preload the lazy chunk for any island, and the module only for a load-trigger one", async () => {
    const now = await renderToString(<Page><Island src="src/now.client.ts" /></Page>);
    expect(now).toContain(`src="${RUNTIME_PATH}"></script>${lazyHint}${preload("/src/now.client.ts")}</head>`);
    const later = await renderToString(<Page><Island src="src/later.client.ts" when="visible" /></Page>);
    expect(later).toContain(`></script>${lazyHint}</head>`);
    expect(later).not.toContain(preload("/src/later.client.ts"));
  });

  it("name each module once, for lazy elements and module-backed attributes too", async () => {
    lazyElement("gnome-clock", "src/clock.client.ts");
    lazyElement("share-menu", "src/share.client.ts", { when: "interaction" });
    attribute("confetti", { client: "src/confetti.client.ts" });
    attribute("sort-me", { client: "src/sort.client.ts", when: "visible" });
    const html = await renderToString(
      <Page>
        <gnome-clock>12:00</gnome-clock>
        <gnome-clock>12:00</gnome-clock>
        <share-menu />
        <button confetti>Yay</button>
        <ul sort-me="x" />
        <Island src="src/clock.client.ts" />
      </Page>,
    );
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain(`${lazyHint}${preload("/src/clock.client.ts")}${preload("/src/confetti.client.ts")}</head>`.replace("</head>", ""));
    expect(head.split(preload("/src/clock.client.ts")).length).toBe(2);
    expect(head).not.toContain("share.client");
    expect(head).not.toContain("sort.client");
    expect(html).toContain('<button confetti>Yay</button>');
  });

  it("are left out for pages without lazy code, and unknown custom elements cost nothing", async () => {
    lazyElement("gnome-clock", "src/clock.client.ts", { when: "idle" });
    const html = await renderToString(<Page><other-thing>hi</other-thing></Page>);
    expect(html).not.toContain("modulepreload");
    const idle = await renderToString(<Page><gnome-clock /></Page>);
    expect(idle).toContain(`></script>${lazyHint}</head>`);
  });
});

describe("lazyElement() and module-backed attribute()", () => {
  it("validate names, triggers and duplicates", () => {
    expect(() => lazyElement("nodash", "src/a.client.ts")).toThrow(/isn't a custom element name/);
    expect(() => lazyElement("Big-Tag", "src/a.client.ts")).toThrow(/isn't a custom element name/);
    expect(() => lazyElement("my-el", "")).toThrow(/needs the client module/);
    expect(() => lazyElement("my-el", "src/a.client.ts", { when: "later" as never })).toThrow(/lazyElement\("my-el"\): when="later" isn't a trigger/);
    const def = lazyElement("my-el", "src/a.client.ts", { when: "media:(hover: hover)" });
    expect(def).toEqual({ tag: "my-el", src: "src/a.client.ts", when: "media:(hover: hover)" });
    expect(() => lazyElement("my-el", "src/b.client.ts")).toThrow(/defined twice/);
    expect(() => attribute("confetti", { client: "src/c.client.ts", when: "soon" as never })).toThrow(/isn't a trigger/);
    expect(() => attribute("confetti", { client() {}, when: "idle" })).toThrow(/`when` is for a client half that's a module/);
    expect(attribute("confetti", { client: "src/c.client.ts" })).toMatchObject({ client: "src/c.client.ts", when: "load" });
  });

  it("module client halves stay out of the inline attribute source", () => {
    attribute("confetti", { client: "src/c.client.ts" });
    attribute("sort-me", { client: (el) => void el.remove() });
    const source = attributesSource();
    expect(source).toContain('yerd.attribute("sort-me"');
    expect(source).not.toContain("confetti");
  });
});

describe("in production", () => {
  const dir = mkdtempSync(join(tmpdir(), "yerd-lazy-"));
  beforeAll(() => {
    mkdirSync(join(dir, ".vite"), { recursive: true });
    writeFileSync(
      join(dir, ".vite", "manifest.json"),
      JSON.stringify({
        "src/chart.client.ts": { file: "assets/chart.client-AAA.js", isEntry: true, imports: ["_shared-BBB.js"], css: ["assets/chart-CCC.css"] },
        "_shared-BBB.js": { file: "assets/shared-BBB.js", imports: ["_deep-DDD.js"], css: ["assets/shared-EEE.css"] },
        "_deep-DDD.js": { file: "assets/deep-DDD.js" },
        "src/clock.client.ts": { file: "assets/clock.client-FFF.js", isEntry: true, imports: ["_shared-BBB.js"] },
      }),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("islands point at the built file, carry its and its imports' CSS, and preload its imports", async () => {
    useManifest(join(dir, ".vite", "manifest.json"), "/static/");
    const html = await renderToString(<Page><Island src="src/chart.client.ts" /></Page>);
    expect(html).toContain('data-yx-island="/static/assets/chart.client-AAA.js"');
    expect(html).toContain('data-yx-styles="/static/assets/chart-CCC.css /static/assets/shared-EEE.css"');
    expect(html).toContain(`${lazyHint}${preload("/static/assets/chart.client-AAA.js")}${preload("/static/assets/shared-BBB.js")}${preload("/static/assets/deep-DDD.js")}</head>`);
  });

  it("a module the build doesn't have is a clear error", async () => {
    useManifest(join(dir, ".vite", "manifest.json"));
    await expect(renderToString(<Island src="src/missing.client.ts" />)).rejects.toThrow(/src\/missing.client.ts isn't in the Vite manifest: name it \*.client.ts/);
  });

  describe("the runtime script", () => {
    let server: RunningServer;
    beforeAll(async () => {
      server = await serve([]);
    });
    afterAll(() => server.close());

    const core = async () => (await fetch(server.url + RUNTIME_PATH, { headers: { "accept-encoding": "identity" } })).text();

    it("carries the lazy registry, resolved for this server: source paths in dev, built files in production", async () => {
      expect(await core()).not.toContain('"elements"');
      lazyElement("gnome-clock", "src/clock.client.ts", { when: "idle" });
      attribute("confetti", { client: "src/chart.client.ts", when: "interaction" });
      expect(await core()).toContain(
        ', {"elements":{"gnome-clock":{"url":"/src/clock.client.ts","when":"idle"}},"attributes":{"confetti":{"url":"/src/chart.client.ts","when":"interaction"}}});',
      );
      useManifest(join(dir, ".vite", "manifest.json"));
      expect(await core()).toContain(
        ', {"elements":{"gnome-clock":{"url":"/assets/clock.client-FFF.js","when":"idle","css":["/assets/shared-EEE.css"]}},"attributes":{"confetti":{"url":"/assets/chart.client-AAA.js","when":"interaction","css":["/assets/chart-CCC.css","/assets/shared-EEE.css"]}}});',
      );
    });

    it("leaves out (and logs) a module the build doesn't have, instead of breaking every page", async () => {
      useManifest(join(dir, ".vite", "manifest.json"));
      lazyElement("gnome-clock", "src/clock.client.ts");
      lazyElement("lost-thing", "src/lost.client.ts");
      const res = await fetch(server.url + RUNTIME_PATH, { headers: { "accept-encoding": "identity" } });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('"gnome-clock"');
      expect(text).not.toContain("lost-thing");
    });
  });
});
