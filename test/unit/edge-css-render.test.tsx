import { describe, expect, it } from "vitest";
import { Dynamic, Local, css, eq, keyframes, not, raw, renderToStream, renderToString, type Child, type RenderOptions } from "@toyz/yerd";
import { jsx } from "@toyz/yerd/jsx-runtime";

const card = css`padding: 16px; --edge-render: card;`;
const active = css`outline: 2px solid; --edge-render: active;`;
const muted = css`opacity: 0.5; --edge-render: muted;`;
const spin = keyframes`to { rotate: 1turn; } /* edge-render */`;
const spinner = css`animation: ${spin} 1s linear infinite;`;

const later = <T,>(value: T, ms = 1) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

/** The class names, in order, of every <style data-yx-css> in some HTML. */
function sent(html: string): string[] {
  return [...html.matchAll(/<style data-yx-css="([^"]+)">/g)].map((m) => m[1]!);
}

/** How many times a class's rules were sent. */
function times(html: string, name: string): number {
  return html.split(`<style data-yx-css="${name}">`).length - 1;
}

/** Where a class's <style> starts, and where the first element using it does. */
function where(html: string, name: string): { style: number; use: number } {
  const use = [...html.matchAll(/<[a-zA-Z][^>]*\sclass="([^"]*)"/g)].find((m) => m[1]!.split(/\s+/).includes(name));
  return { style: html.indexOf(`<style data-yx-css="${name}">`), use: use?.index ?? -1 };
}

/** The rules come before the first element that uses the class. */
function expectBefore(html: string, name: string): void {
  const { style, use } = where(html, name);
  expect(style, `rules for ${name}`).toBeGreaterThanOrEqual(0);
  expect(use, `an element using ${name}`).toBeGreaterThanOrEqual(0);
  expect(style).toBeLessThan(use);
}

async function chunks(node: Child, options?: RenderOptions): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of renderToStream(node, options)) out.push(chunk);
  return out;
}

describe("class shapes", () => {
  it.each<[string, () => Child, string[]]>([
    ["a plain string", () => <div class={card} />, [card]],
    ["extra whitespace around", () => <div class={`   ${card}   `} />, [card]],
    ["tabs and newlines between", () => <div class={`\t${card}\n\n${active}\r\n`} />, [card, active]],
    ["among plain classes", () => <div class={`btn ${card} big`} />, [card]],
    ["the same name twice in one string", () => <div class={`${card} ${card}`} />, [card]],
    ["an array", () => <div class={[card, active]} />, [card, active]],
    ["a nested array", () => <div class={[[card], [[active, [muted]]]]} />, [card, active, muted]],
    ["an array with holes", () => <div class={[null, false, undefined, "", card]} />, [card]],
    ["a flag that's on", () => <div class={{ [card]: true }} />, [card]],
    ["a flag that's off", () => <div class={{ [card]: false }} />, [card]],
    ["a flag that's 0", () => <div class={{ [card]: 0 }} />, [card]],
    ["a flag holding two classes", () => <div class={{ [`${card} ${active}`]: true }} />, [card, active]],
    ["flags inside an array", () => <div class={["x", { [active]: false }, [{ [muted]: true }]]} />, [active, muted]],
    ["className", () => <div className={card} />, [card]],
    ["class and className", () => <div class={card} className={active} />, [card, active]],
    ["className given first", () => <div className={active} class={card} />, [card, active]],
    ["the same class in both", () => <div class={card} className={card} />, [card]],
    ["raw()", () => jsx("div", { class: raw(`x ${card}`) }), [card]],
    ["raw() inside an array", () => jsx("div", { class: ["y", raw(active)] }), [active]],
    ["a class with keyframes", () => <div class={spinner} />, [spin, spinner]],
    ["a keyframes name used as a class (it's registered, so it's sent)", () => <div class={spin} />, [spin]],
  ])("finds classes in %s", async (_label, make, expected) => {
    expect(sent(await renderToString(make()))).toEqual(expected);
  });

  it.each<[string, () => Child]>([
    ["an empty string", () => <div class="" />],
    ["whitespace only", () => <div class={"  \t "} />],
    ["null", () => <div class={null} />],
    ["undefined", () => <div class={undefined} />],
    ["false", () => <div class={false} />],
    ["an empty array", () => <div class={[]} />],
    ["an empty object", () => <div class={{}} />],
    ["unregistered yx- names", () => <div class="yx-0000 yx-k-0000" />],
    ["the name in uppercase", () => <div class={card.toUpperCase()} />],
    ["the name with a suffix", () => <div class={`${card}-x`} />],
    ["the name as a selector", () => <div class={`.${card}`} />],
    ["no class at all", () => <div id={card} title={card} data-x={card} />],
    ["the name as text content", () => <div>{card}</div>],
  ])("sends nothing for %s", async (_label, make) => {
    expect(sent(await renderToString(make()))).toEqual([]);
  });

  it("still escapes the class attribute next to a scoped class", async () => {
    const html = await renderToString(<div class={`${card} "><script>x</script>`} />);
    expect(html).toContain(`class="${card} &quot;&gt;&lt;script&gt;x&lt;/script&gt;"`);
    expect(sent(html)).toEqual([card]);
    expect(html).not.toContain("<script");
  });

  it("only looks at class and className, not other attributes that hold a name", async () => {
    const html = await renderToString(<div data-class={card} aria-describedby={active} style={`animation: ${spin} 1s`} />);
    expect(sent(html)).toEqual([]);
  });

  // Keyframes used from a style attribute (style={{ animation: `${spin} 1s` }})
  // are never sent: only class/className are scanned. Sending them would mean
  // scanning style values for registered names.
  it.todo("sends keyframes referenced from an inline style attribute");

  it("writes the class attribute itself unchanged", async () => {
    const html = await renderToString(<div class={["btn", card, { [active]: false, on: true }]} />);
    expect(html).toContain(`class="btn ${card} on"`);
  });
});

describe("<Local> bindings", () => {
  it("covers flags bound to state, with not() and eq()", async () => {
    const html = await renderToString(
      <Local state={{ on: false, tab: "a" }}>
        {(s) => (
          <div>
            <button class={{ [card]: s.on }}>a</button>
            <button class={{ [active]: not(s.on) }}>b</button>
            <button class={{ [muted]: eq(s.tab, "b") }}>c</button>
          </div>
        )}
      </Local>,
    );
    expect(sent(html)).toEqual([card, active, muted]);
    expectBefore(html, active);
  });

  it("sends the class a bound class value starts with", async () => {
    const html = await renderToString(<Local state={{ theme: card }}>{(s) => <div class={s.theme}>x</div>}</Local>);
    expect(sent(html)).toEqual([card]);
    expect(html).toContain(`class="${card}"`);
  });

  it("sends a bound class value inside a list", async () => {
    const html = await renderToString(<Local state={{ theme: active }}>{(s) => <div class={["base", s.theme]}>x</div>}</Local>);
    expect(sent(html)).toEqual([active]);
  });

  it("sends a bound className value", async () => {
    const html = await renderToString(<Local state={{ theme: muted }}>{(s) => <div className={s.theme}>x</div>}</Local>);
    expect(sent(html)).toEqual([muted]);
  });

  it("ignores a binding that isn't a class name", async () => {
    const html = await renderToString(<Local state={{ theme: "plain", n: 3 }}>{(s) => <div class={[s.theme, { [card]: s.n }]}>x</div>}</Local>);
    expect(sent(html)).toEqual([card]);
  });

  it("puts the rules inside the <yerd-local> wrapper, before the element", async () => {
    const html = await renderToString(<Local state={{ on: true }}>{(s) => <p class={{ [card]: s.on }}>x</p>}</Local>);
    expect(html.indexOf("<yerd-local")).toBeLessThan(html.indexOf(`data-yx-css="${card}"`));
    expectBefore(html, card);
  });
});

describe("once per render", () => {
  it("sends a class once however many elements use it", async () => {
    const html = await renderToString(<ul>{Array.from({ length: 200 }, (_, i) => <li class={i % 2 ? card : [card, active]}>{i}</li>)}</ul>);
    expect(times(html, card)).toBe(1);
    expect(times(html, active)).toBe(1);
  });

  it("sends keyframes once when several rules need them", async () => {
    const other = css`animation: ${spin} 2s; --edge-render: other;`;
    const html = await renderToString(
      <div>
        <i class={spinner} />
        <i class={other} />
        <i class={spin} />
      </div>,
    );
    expect(times(html, spin)).toBe(1);
    expect(sent(html)).toEqual([spin, spinner, other]);
  });

  it("starts each render fresh", async () => {
    for (let i = 0; i < 5; i++) expect(sent(await renderToString(<div class={card} />))).toEqual([card]);
  });

  it("dedupes across components, fragments, arrays and iterables", async () => {
    function Card() {
      return <div class={card} />;
    }
    function* items() {
      yield <span class={card} />;
      yield <span class={active} />;
    }
    const html = await renderToString(
      <>
        <Card />
        {[<Card />, [<Card />]]}
        {items()}
        <>
          <Card />
        </>
      </>,
    );
    expect(sent(html)).toEqual([card, active]);
  });
});

describe("elements in every context", () => {
  it.each<[string, () => Child, string[]]>([
    ["a <table> row and cells", () => <table><tbody><tr class={card}><td class={active}>x</td></tr></tbody></table>, [card, active]],
    ["a <thead> cell", () => <table><thead><tr><th class={muted}>h</th></tr></thead></table>, [muted]],
    ["a <ul> item", () => <ul><li class={card}>x</li></ul>, [card]],
    ["a <dl>", () => <dl><dt class={card}>t</dt><dd class={active}>d</dd></dl>, [card, active]],
    ["a void <img>", () => <img class={card} src="/a.png" alt="" />, [card]],
    ["a void <input>", () => <input class={card} name="x" />, [card]],
    ["a void <br>", () => <br class={card} />, [card]],
    ["a void <hr>", () => <hr class={card} />, [card]],
    ["a custom element", () => jsx("my-widget", { class: card, children: "x" }), [card]],
    ["a <script>", () => <script class={card}>{"var a = 1;"}</script>, [card]],
    ["a <style>", () => <style class={card}>{"p { color: red; }"}</style>, [card]],
    ["a <textarea>", () => <textarea class={card}>text</textarea>, [card]],
    ["a <button>", () => <button class={card}>b</button>, [card]],
    ["a <details>/<summary>", () => <details class={card}><summary class={active}>s</summary></details>, [card, active]],
    ["a <picture>", () => <picture class={card}><img class={active} src="/a.png" alt="" /></picture>, [card, active]],
  ])("sends rules before %s", async (_label, make, names) => {
    const html = await renderToString(make());
    expect(sent(html)).toEqual(names);
    for (const name of names) expectBefore(html, name);
  });

  it("writes void elements without a closing tag after their rules", async () => {
    expect(await renderToString(<img class={card} src="/a.png" alt="" />)).toBe(
      `<style data-yx-css="${card}">.${card}{padding: 16px; --edge-render: card;}</style><img class="${card}" src="/a.png" alt="">`,
    );
  });

  it("works in <svg> (the element itself gets its rules in HTML, before <svg>)", async () => {
    const html = await renderToString(
      <svg class={card} viewBox="0 0 10 10">
        <circle cx="5" cy="5" r="4" />
      </svg>,
    );
    expectBefore(html, card);
    expect(html.indexOf(`data-yx-css="${card}"`)).toBeLessThan(html.indexOf("<svg"));
  });

  // Inside <svg>/<math> the parser makes <style> a foreign element: in SVG it
  // still applies (but its text is parsed as markup, so `<` or `&name;` in a
  // rule would change), in MathML it does nothing. Holding the rules until
  // </svg> (as for <select>) would fix both, at the cost of a late paint.
  it.todo("holds rules for classes used inside <svg>/<math> until the foreign element closes");

  it("writes rules for <head> elements inside <head>", async () => {
    const html = await renderToString(
      <html>
        <head>
          <title class={card}>t</title>
          <meta class={active} name="x" content="y" />
          <link class={muted} rel="icon" href="/i.svg" />
        </head>
        <body />
      </html>,
    );
    const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    expect(sent(head)).toEqual([card, active, muted]);
  });

  it("puts the doctype first when <html> itself has a class", async () => {
    const html = await renderToString(
      <html class={card}>
        <body class={active} />
      </html>,
      { document: true },
    );
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.indexOf(`data-yx-css="${card}"`)).toBeGreaterThan(0);
    expectBefore(html, card);
    expectBefore(html, active);
    expect(html.indexOf(`data-yx-css="${active}"`)).toBeGreaterThan(html.indexOf("<html"));
  });

  it("writes no doctype when the page doesn't start with <html>, rules or not", async () => {
    const html = await renderToString(<div class={card} />, { document: true });
    expect(html.startsWith(`<style data-yx-css="${card}">`)).toBe(true);
  });
});

describe("<select>: held until it closes", () => {
  it("holds rules for options and optgroups until </select>", async () => {
    const html = await renderToString(
      <form>
        <select name="s">
          <optgroup class={card} label="g">
            <option class={active}>a</option>
          </optgroup>
        </select>
        <p class={muted}>after</p>
      </form>,
    );
    const close = html.indexOf("</select>");
    for (const name of [card, active]) expect(html.indexOf(`data-yx-css="${name}"`)).toBeGreaterThan(close);
    expect(html.slice(html.indexOf("<select"), close)).not.toContain("<style");
    expectBefore(html, muted);
  });

  it("sends the select's own class before it, and doesn't repeat it for an option", async () => {
    const html = await renderToString(
      <select class={card}>
        <option class={card}>a</option>
        <option class={[card, active]}>b</option>
      </select>,
    );
    expect(times(html, card)).toBe(1);
    expect(html.indexOf(`data-yx-css="${card}"`)).toBeLessThan(html.indexOf("<select"));
    expect(html.indexOf(`data-yx-css="${active}"`)).toBeGreaterThan(html.indexOf("</select>"));
  });

  it("holds keyframes with the rule that needs them, in order", async () => {
    const html = await renderToString(
      <select>
        <option class={spinner}>a</option>
      </select>,
    );
    expect(html.endsWith(`</select><style data-yx-css="${spin}">@keyframes ${spin}{to { rotate: 1turn; } /* edge-render */}</style><style data-yx-css="${spinner}">.${spinner}{animation: ${spin} 1s linear infinite;}</style>`)).toBe(true);
  });

  it("holds nested selects' rules until the outermost one closes", async () => {
    const html = await renderToString(
      <div>
        {jsx("select", {
          children: [<option class={card}>a</option>, jsx("select", { class: active, children: <option class={muted}>b</option> })],
        })}
      </div>,
    );
    const last = html.lastIndexOf("</select>");
    const first = html.indexOf("</select>");
    expect(first).toBeLessThan(last);
    for (const name of [card, active, muted]) expect(html.indexOf(`data-yx-css="${name}"`)).toBeGreaterThan(last);
    expect(sent(html)).toEqual([card, active, muted]);
  });

  it("holds across async options and streams the rules after </select>", async () => {
    async function Late() {
      return <option class={card}>{await later("late")}</option>;
    }
    const out = await chunks(
      <div>
        <select>
          <option class={active}>a</option>
          <Late />
        </select>
        <p class={card}>after</p>
      </div>,
    );
    const html = out.join("");
    expect(out.length).toBeGreaterThan(1);
    const close = html.indexOf("</select>");
    expect(html.slice(0, close)).not.toContain("<style");
    expect(sent(html.slice(close))).toEqual([active, card]);
    expect(times(html, card)).toBe(1);
  });

  it("sends nothing after an empty select", async () => {
    expect(await renderToString(<select name="x" />)).toBe('<select name="x"></select>');
  });

  it("sends rules already sent before the select once, not again after it", async () => {
    const html = await renderToString(
      <div>
        <p class={card} />
        <select>
          <option class={card}>a</option>
        </select>
      </div>,
    );
    expect(times(html, card)).toBe(1);
    expect(html.endsWith("</select></div>")).toBe(true);
  });

  it("treats options outside a select (a datalist) normally", async () => {
    const html = await renderToString(
      <datalist id="d">
        <option class={card} value="a" />
      </datalist>,
    );
    expectBefore(html, card);
  });

  it("starts the next render with nothing held, even after one that failed inside a select", async () => {
    function Boom(): Child {
      throw new Error("boom");
    }
    await expect(renderToString(
      <select>
        <option class={card}>a</option>
        <Boom />
      </select>,
    )).rejects.toThrow("boom");
    const html = await renderToString(<p class={card} />);
    expectBefore(html, card);
  });

  it("holds rules inside <colgroup> until it closes (the parser would close it early at a <style>)", async () => {
    const html = await renderToString(
      <table>
        <colgroup>
          <col class={card} />
          <col class={active} />
        </colgroup>
        <tbody>
          <tr>
            <td class={muted}>x</td>
          </tr>
        </tbody>
      </table>,
    );
    const group = html.slice(html.indexOf("<colgroup>"), html.indexOf("</colgroup>"));
    expect(group).not.toContain("<style");
    for (const name of [card, active]) expect(html.indexOf(`data-yx-css="${name}"`)).toBeGreaterThan(html.indexOf("</colgroup>"));
    expectBefore(html, muted);
  });
});

describe("<template> and <noscript>: their rules don't count for the page", () => {
  it("sends rules again outside a <template> that used the class first", async () => {
    const html = await renderToString(
      <div>
        <template>
          <p class={card}>in template</p>
        </template>
        <p class={card}>outside</p>
      </div>,
    );
    expect(times(html, card)).toBe(2);
    const inside = html.slice(html.indexOf("<template>"), html.indexOf("</template>"));
    expect(sent(inside)).toEqual([card]);
    const after = html.slice(html.indexOf("</template>"));
    expect(sent(after)).toEqual([card]);
  });

  it("doesn't resend inside a <template> what the page already has (a clone lands where it's styled)", async () => {
    const html = await renderToString(
      <div>
        <p class={active}>first</p>
        <template>
          <p class={active}>clone me</p>
        </template>
      </div>,
    );
    expect(times(html, active)).toBe(1);
  });

  it("restores the page's own record after an async <template>", async () => {
    const html = await renderToString(
      <div>
        <template>{later(<p class={spinner}>late</p>)}</template>
        <p class={spinner}>outside</p>
      </div>,
    );
    expect(times(html, spinner)).toBe(2);
    expect(times(html, spin)).toBe(2);
  });

  it("dedupes within one <template>", async () => {
    const html = await renderToString(
      <template>
        <p class={card} />
        <p class={card} />
      </template>,
    );
    expect(times(html, card)).toBe(1);
  });

  it("sends rules again outside a <noscript> that used the class first", async () => {
    const html = await renderToString(
      <div>
        <noscript>
          <p class={muted}>no js</p>
        </noscript>
        <p class={muted}>js</p>
      </div>,
    );
    expect(times(html, muted)).toBe(2);
    expect(sent(html.slice(html.indexOf("</noscript>")))).toEqual([muted]);
  });

  it("does the same for a <Dynamic> noscript when prerendering", async () => {
    const html = await renderToString(
      <main>
        <Dynamic id="cart" fallback={<span class={active}>...</span>} noscript={<a class={card} href="/cart">cart</a>}>
          {() => <b>never</b>}
        </Dynamic>
        <p class={card}>after</p>
      </main>,
      { dynamic: "fallback" },
    );
    expect(times(html, card)).toBe(2);
    expect(sent(html.slice(html.indexOf("</noscript>")))).toEqual([card]);
    expect(times(html, active)).toBe(1);
  });
});

describe("<Dynamic>", () => {
  function page(): Child {
    return (
      <main class={muted}>
        <p class={card}>static</p>
        <Dynamic id="part" fallback={<span class={active}>loading</span>}>
          {() => <p class={[card, spinner]}>live</p>}
        </Dynamic>
      </main>
    );
  }

  it("normally renders the children with their rules", async () => {
    const html = await renderToString(page());
    expect(sent(html)).toEqual([muted, card, spin, spinner]);
  });

  it("prerendering (fallback): the fallback's rules, not the children's", async () => {
    const html = await renderToString(page(), { dynamic: "fallback" });
    expect(sent(html)).toEqual([muted, card, active]);
  });

  it("filling in (only): the parts' rules, including ones used outside them", async () => {
    const html = await renderToString(page(), { dynamic: "only" });
    expect(html.startsWith('<div id="part"')).toBe(true);
    expect(sent(html)).toEqual([card, spin, spinner]);
    // Everything is inside the region the runtime fills.
    expect(html.indexOf("<style")).toBeGreaterThan(html.indexOf('<div id="part"'));
  });

  it("sends the rules for a class on the <Dynamic> wrapper itself", async () => {
    const node = (
      <Dynamic id="wrapped" as="section" class={card} fallback="...">
        {() => "x"}
      </Dynamic>
    );
    for (const dynamic of [undefined, "fallback", "only"] as const) {
      const html = await renderToString(node, { dynamic });
      expect(sent(html), String(dynamic)).toEqual([card]);
      expectBefore(html, card);
    }
  });

  it("doesn't count the wrapper class twice when the children use it too", async () => {
    const html = await renderToString(
      <Dynamic id="w2" class={active}>
        {() => <p class={active}>x</p>}
      </Dynamic>,
    );
    expect(times(html, active)).toBe(1);
  });

  it("async children: rules arrive with them", async () => {
    const html = await renderToString(
      <Dynamic id="slow">
        {async () => <p class={muted}>{await later("x")}</p>}
      </Dynamic>,
      { dynamic: "only" },
    );
    expect(sent(html)).toEqual([muted]);
  });
});

describe("async components and streaming", () => {
  it("keeps a class's rules in the same chunk as the first element using it", async () => {
    async function Part({ name, delay }: { name: string; delay: number }) {
      await later(null, delay);
      return <section class={name}>part</section>;
    }
    const out = await chunks(
      <div>
        <Part name={card} delay={2} />
        <Part name={active} delay={1} />
        <Part name={card} delay={1} />
        <Part name={muted} delay={3} />
      </div>,
    );
    expect(out.length).toBeGreaterThan(2);
    for (const name of [card, active, muted]) {
      const chunk = out.find((c) => c.includes(`class="${name}"`))!;
      expect(chunk, name).toContain(`data-yx-css="${name}"`);
      expect(chunk.indexOf(`data-yx-css="${name}"`)).toBeLessThan(chunk.indexOf(`class="${name}"`));
    }
    expect(times(out.join(""), card)).toBe(1);
  });

  it("sends the rules for a promise child when it resolves, not before", async () => {
    const out = await chunks(<div>{later(<p class={card}>x</p>, 2)}</div>);
    expect(out[0]).toBe("<div>");
    expect(out.join("")).toBe(`<div><style data-yx-css="${card}">.${card}{padding: 16px; --edge-render: card;}</style><p class="${card}">x</p></div>`);
  });

  it("doesn't send rules for an async component that never got to render", async () => {
    async function Fails(): Promise<null> {
      await later(null);
      throw new Error("nope");
    }
    const out: string[] = [];
    await expect((async () => {
      for await (const chunk of renderToStream(<div><Fails /><p class={card} /></div>)) out.push(chunk);
    })()).rejects.toThrow("nope");
    expect(out.join("")).not.toContain("data-yx-css");
  });

  it("orders rules by first use, not by when components finish", async () => {
    async function Slow() {
      await later(null, 5);
      return <i class={active} />;
    }
    async function Fast() {
      await later(null, 1);
      return <i class={card} />;
    }
    const html = await renderToString(
      <div>
        <Slow />
        <Fast />
      </div>,
    );
    expect(sent(html)).toEqual([active, card]);
  });
});

describe("renders don't share state", () => {
  const many = Array.from({ length: 24 }, (_, i) => css`--concurrent: ${i};`);

  it("keeps 50 concurrent renders' rules apart", async () => {
    const plans = Array.from({ length: 50 }, (_, r) => many.filter((_, i) => (i * 7 + r) % 3 === 0));
    async function Item({ name, wait }: { name: string; wait: number }) {
      await later(null, wait);
      return <li class={name}>x</li>;
    }
    const results = await Promise.all(
      plans.map((names, r) =>
        renderToString(
          <ul>
            {names.map((name, i) => <Item name={name} wait={(r + i) % 4} />)}
            {names.map((name) => <li class={name}>again</li>)}
          </ul>,
        ),
      ),
    );
    results.forEach((html, r) => {
      expect(sent(html)).toEqual(plans[r]);
      for (const name of plans[r]!) expect(times(html, name)).toBe(1);
    });
  });

  it("keeps two interleaved streams apart", async () => {
    async function Tick({ name }: { name: string }) {
      await later(null);
      return <b class={name}>t</b>;
    }
    const one = renderToStream(<div><Tick name={card} /><Tick name={active} /><Tick name={card} /></div>);
    const two = renderToStream(<div><Tick name={card} /><Tick name={muted} /><Tick name={active} /></div>);
    let a = "";
    let b = "";
    let doneA = false;
    let doneB = false;
    while (!doneA || !doneB) {
      if (!doneA) {
        const step = await one.next();
        if (step.done) doneA = true;
        else a += step.value;
      }
      if (!doneB) {
        const step = await two.next();
        if (step.done) doneB = true;
        else b += step.value;
      }
    }
    expect(sent(a)).toEqual([card, active]);
    expect(sent(b)).toEqual([card, muted, active]);
  });

  it("keeps a held <select> in one render from holding another render's rules", async () => {
    async function Opt({ name }: { name: string }) {
      await later(null, 2);
      return <option class={name}>o</option>;
    }
    const [inSelect, plain] = await Promise.all([
      renderToString(<select><Opt name={card} /></select>),
      renderToString(<div>{later(<p class={card}>p</p>, 1)}</div>),
    ]);
    expect(inSelect.indexOf(`data-yx-css="${card}"`)).toBeGreaterThan(inSelect.indexOf("</select>"));
    expectBefore(plain, card);
  });
});
