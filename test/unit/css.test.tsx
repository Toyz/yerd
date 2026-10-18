import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Local, Region, Styles, action, css, get, keyframes, not, prerender, renderToString, route, yerd } from "@toyz/yerd";
import { cssBundleText, resetCssBundle, useCssBundle } from "../../src/render/css.js";

afterEach(() => resetCssBundle());

const card = css`
  padding: 16px;
  &:hover { color: red; }
`;
const active = css`outline: 2px solid;`;
const pop = keyframes`from { opacity: 0; } to { opacity: 1; }`;
const badge = css`animation: ${pop} 0.2s;`;

/** The <style> tags in some HTML, by class. */
function styles(html: string): string[] {
  return [...html.matchAll(/<style data-yx-css="([^"]+)">/g)].map((m) => m[1]!);
}

describe("css``", () => {
  it("returns a stable, scoped class name for the rules", () => {
    expect(card).toMatch(/^yx-[a-z0-9]{6,10}$/);
    expect(css`
  padding: 16px;
  &:hover { color: red; }
`).toBe(card);
    expect(css`padding: 17px;`).not.toBe(css`padding: 16px;`);
  });

  it("is the same class in every process: a hash of the text, nothing else", () => {
    // Pinned: if this changes, classes rendered by an old server stop matching a new one's stylesheet.
    expect(css`color: rebeccapurple;`).toBe("yx-sdn89mvfyn");
  });

  it("ignores surrounding whitespace, not inner differences", () => {
    expect(css`  color: blue;  `).toBe(css`color: blue;`);
    expect(css`color:blue;`).not.toBe(css`color: blue;`);
  });

  it.each([
    [42, "width: 42px;"],
    ["1.5", "width: 1.5px;"],
    [null, "width: px;"],
    [undefined, "width: px;"],
    [false, "width: px;"],
  ])("writes interpolated %j as text (nothing for null/undefined/false)", async (value, expected) => {
    const name = css`width: ${value}px;`;
    expect(await renderStyleText(name)).toBe(`.${name}{${expected}}`);
  });

  it("interpolates another class as its selector, a keyframes name as itself", async () => {
    const parent = css`color: green; ${card}:hover & { color: blue; }`;
    expect(await renderStyleText(parent)).toContain(`.${card}:hover & { color: blue; }`);
    expect(await renderStyleText(badge)).toContain(`animation: ${pop} 0.2s;`);
    expect(pop).toMatch(/^yx-k-/);
  });

  it("refuses rules that would close their <style>", () => {
    expect(() => css`content: "</style><script>x</script>";`).toThrow(/<\/style/);
    expect(() => css`content: "</STYLE>";`).toThrow(/<\/style/);
    expect(() => keyframes`to { --x: "</style>"; }`).toThrow(/<\/style/);
    expect(() => css.global`body { --x: "</style"; }`).toThrow(/<\/style/);
  });
});

/** Render one element with the class (through the real renderer) and return its rule's text. */
async function renderStyleText(name: string): Promise<string> {
  const html = await renderToString(<div class={name} />);
  const all = [...html.matchAll(/<style data-yx-css="([^"]+)">([^<]*)<\/style>/g)];
  return all.find((m) => m[1] === name)?.[2] ?? "";
}

describe("rendering", () => {
  it("sends a class's rules once, just before the first element using it", async () => {
    const html = await renderToString(
      <main>
        <div class={card}>a</div>
        <div class={card}>b</div>
        <p class={[card, active]}>c</p>
      </main>,
    );
    expect(styles(html)).toEqual([card, active]);
    expect(html.indexOf(`data-yx-css="${card}"`)).toBeLessThan(html.indexOf(`class="${card}"`));
    expect(html.indexOf(`data-yx-css="${active}"`)).toBeLessThan(html.indexOf(`class="${card} ${active}"`));
  });

  it("finds classes in className, arrays, strings with other classes and nested arrays", async () => {
    const html = await renderToString(
      <>
        <b className={`big ${card}`}>x</b>
        <i class={["plain", [[active]]]}>y</i>
      </>,
    );
    expect(styles(html)).toEqual([card, active]);
  });

  it("sends a flag object's classes even when they're off (they may switch on later)", async () => {
    const html = await renderToString(<button class={{ [active]: false, other: true }}>x</button>);
    expect(styles(html)).toEqual([active]);
    expect(html).toContain('class="other"');
  });

  it("covers <Local> class flags bound to state", async () => {
    const html = await renderToString(<Local state={{ on: false }}>{(s) => <button class={{ [active]: s.on, [card]: not(s.on) }}>x</button>}</Local>);
    expect(styles(html)).toEqual([active, card]);
  });

  it("sends keyframes along with the rule that animates with them, before it", async () => {
    const html = await renderToString(<span class={badge}>new</span>);
    expect(styles(html)).toEqual([pop, badge]);
  });

  it("holds rules for classes inside a <select> until it closes (the parser drops <style> there)", async () => {
    const html = await renderToString(
      <select class={card}>
        <option class={active}>a</option>
        <optgroup label="g">
          <option class={badge}>b</option>
        </optgroup>
      </select>,
    );
    const close = html.indexOf("</select>");
    expect(html.indexOf(`data-yx-css="${card}"`)).toBeLessThan(html.indexOf("<select"));
    for (const name of [active, pop, badge]) expect(html.indexOf(`data-yx-css="${name}"`)).toBeGreaterThan(close);
  });

  it("starts over on every render: each page or response carries what it uses", async () => {
    const one = await renderToString(<div class={card} />);
    const two = await renderToString(<div class={card} />);
    expect(styles(one)).toEqual([card]);
    expect(styles(two)).toEqual([card]);
  });

  it("leaves unknown and plain class names alone", async () => {
    const html = await renderToString(<div class="yx-notregistered plain" />);
    expect(styles(html)).toEqual([]);
  });

  it("works inside streams and async components", async () => {
    async function Slow() {
      await new Promise((r) => setTimeout(r, 1));
      return <em class={card}>late</em>;
    }
    const html = await renderToString(
      <div>
        <Slow />
        <span class={card} />
      </div>,
    );
    expect(styles(html)).toEqual([card]);
  });
});

describe("css.global and <Styles />", () => {
  it("writes global rules once, in <Styles />", async () => {
    css.global`body { margin: 0; }`;
    css.global`body { margin: 0; }`;
    const html = await renderToString(
      <head>
        <Styles />
      </head>,
    );
    expect(html.match(/body \{ margin: 0; \}/g)).toHaveLength(1);
    expect(html).toContain('<style data-yx-css="global">');
  });
});

describe("after vite build: one stylesheet", () => {
  it("links the bundle and stops inlining what it holds, but inlines rules it doesn't have", async () => {
    useCssBundle("/assets/yerd-abc.css", [card, active]);
    const late = css`color: orange;`;
    const html = await renderToString(
      <html>
        <head>
          <Styles />
        </head>
        <body>
          <div class={[card, active, late]} />
        </body>
      </html>,
    );
    expect(html).toContain('<link rel="stylesheet" href="/assets/yerd-abc.css">');
    expect(styles(html)).toEqual([late]);
  });

  it("has every rule, globals first", () => {
    const text = cssBundleText();
    expect(text.indexOf("body { margin: 0; }")).toBeLessThan(text.indexOf(`.${card}{`));
    for (const name of [card, active, pop, badge]) expect(text).toContain(name);
  });
});

describe("in an app", () => {
  const list = css`display: grid; gap: 8px;`;
  const item = css`padding: 4px;`;

  @route("/css-page")
  class Page {
    @get page() {
      return (
        <html>
          <head>
            <Styles />
          </head>
          <body>
            <Region id="items" as="ul" class={list}>
              <li class={item}>one</li>
            </Region>
            <form action={this.add}>
              <button>add</button>
            </form>
          </body>
        </html>
      );
    }
    @action add() {
      return (
        <Region id="items" as="ul" class={list}>
          <li class={item}>one</li>
          <li class={item}>two</li>
        </Region>
      );
    }
  }

  @route("/css-static")
  @prerender()
  class Static {
    @get page() {
      return (
        <html>
          <head>
            <Styles />
          </head>
          <body class={card}>hi</body>
        </html>
      );
    }
  }

  it("sends rules with the page, and again with an action's fragment", async () => {
    const app = yerd({ routes: [Page], services: [], handleSignals: false, secret: "c".repeat(32) });
    const client = app.client();
    const page = await client.page("/css-page");
    expect(styles(page).filter((name) => name !== "global")).toEqual([list, item]);
    const fragment = await (await client.action("/css-page")).text();
    expect(styles(fragment)).toEqual([list, item]);
    await app.stop();
  });

  it("writes the bundle at build (prerender) and serves it after", async () => {
    const out = mkdtempSync(join(tmpdir(), "yerd-css-build-"));
    const build = yerd({ routes: [Static], services: [], handleSignals: false });
    await build.prerender(out);
    await build.stop();
    const stored = JSON.parse(readFileSync(join(out, ".yerd", "css.json"), "utf8")) as { file: string; classes: string[] };
    const record = { ...stored, href: `/${stored.file}` };
    expect(record.href).toMatch(/^\/assets\/yerd-[a-z0-9]+\.css$/);
    expect(existsSync(join(out, record.href))).toBe(true);
    expect(readFileSync(join(out, record.href), "utf8")).toContain(`.${card}{`);
    expect(record.classes).toContain(card);
    // The prerendered page links it and inlines nothing.
    const html = readFileSync(join(out, "css-static", "index.html"), "utf8");
    expect(html).toContain(`<link rel="stylesheet" href="${record.href}">`);
    expect(styles(html)).toEqual([]);
  });
});

describe("rules in <head> with <Styles />", () => {
  const item = css`color: navy; --head-test: 1;`;
  const late = css`color: maroon; --head-test: 2;`;

  function Page({ children }: { children: unknown }) {
    return (
      <html>
        <head>
          <title>t</title>
          <Styles />
        </head>
        <body>{children as never}</body>
      </html>
    );
  }

  it("go into <head> at <Styles />, so the body has no <style> siblings", async () => {
    const html = await renderToString(
      <Page>
        <ul>
          <li class={item}>first</li>
          <li class={item}>second</li>
        </ul>
      </Page>,
      { document: true },
    );
    const head = html.slice(0, html.indexOf("</head>"));
    const body = html.slice(html.indexOf("<body>"));
    expect(styles(head)).toContain(item);
    expect(body).not.toContain("<style");
    // li:first-child is the first li: nothing comes before it.
    expect(body).toContain(`<ul><li class="${item}">first</li>`);
  });

  it("put <select> contents straight into <head> too: nothing to hold for", async () => {
    const html = await renderToString(
      <Page>
        <select>
          <option class={late}>a</option>
        </select>
      </Page>,
    );
    expect(styles(html.slice(0, html.indexOf("</head>"))).filter((n) => n !== "global")).toEqual([late]);
  });

  it("fall back to inline once the head has been sent (an async component flushed it)", async () => {
    const other = css`color: olive; --head-test: 3;`;
    async function Slow() {
      await new Promise((r) => setTimeout(r, 1));
      return <p class={other}>slow</p>;
    }
    const html = await renderToString(
      <Page>
        <h1 class={item}>before</h1>
        <Slow />
      </Page>,
    );
    const head = html.slice(0, html.indexOf("</head>"));
    expect(styles(head)).toContain(item);
    // Rendered after the flush: next to its element, where the runtime picks it up.
    expect(html.indexOf(`data-yx-css="${other}"`)).toBeGreaterThan(html.indexOf("</head>"));
  });
});
