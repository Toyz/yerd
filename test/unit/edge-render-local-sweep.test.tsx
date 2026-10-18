import { describe, expect, it } from "vitest";
import { Local, eq, not, renderToString, type Child } from "@toyz/yerd";

const scope = (state: string, as = "s") =>
  `<yerd-local data-yx-local="${state}" data-yx-as="${as}" style="display:contents">`;

/** What a scope rendered, without its <yerd-local> wrapper. */
const inner = (html: string) => html.replace(/^<yerd-local[^>]*>/, "").replace(/<\/yerd-local>$/, "");

describe("state serialization", () => {
  it.each<[string, object, string]>([
    ["empty", {}, "{}"],
    ["quotes and ampersands", { q: `"'&` }, "{&quot;q&quot;:&quot;\\&quot;&#39;&amp;&quot;}"],
    ["a closing tag", { t: "</yerd-local><script>" }, "{&quot;t&quot;:&quot;&lt;/yerd-local&gt;&lt;script&gt;&quot;}"],
    ["U+2028 and a null byte", { u: " \u0000" }, "{&quot;u&quot;:&quot; \\u0000&quot;}"],
    ["nested", { a: { b: { c: [1, { d: null }] } } }, "{&quot;a&quot;:{&quot;b&quot;:{&quot;c&quot;:[1,{&quot;d&quot;:null}]}}}"],
    ["dropped values", { u: undefined, f: () => 1, n: NaN, i: Infinity }, "{&quot;n&quot;:null,&quot;i&quot;:null}"],
    ["odd keys", { "a b": 1, "<k>": 2, "": 3 }, "{&quot;a b&quot;:1,&quot;&lt;k&gt;&quot;:2,&quot;&quot;:3}"],
    ["a Date field", { d: new Date(0) }, "{&quot;d&quot;:&quot;1970-01-01T00:00:00.000Z&quot;}"],
  ])("%s", async (_, state, json) => {
    expect(await renderToString(<Local state={state}>{(s) => (void s, null)}</Local>)).toBe(`${scope(json)}</yerd-local>`);
  });

  it("the attribute decodes back to the same JSON", async () => {
    const state = { text: `<"'&> `, list: [1, "two", { three: [true, null] }] };
    const html = await renderToString(<Local state={state}>{(s) => (void s, null)}</Local>);
    const value = /data-yx-local="([^"]*)"/.exec(html)![1]!;
    const decoded = value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    expect(JSON.parse(decoded)).toEqual(state);
  });

  it("the parameter name becomes data-yx-as", async () => {
    expect(await renderToString(<Local state={{}}>{($state) => (void $state, null)}</Local>)).toBe(`${scope("{}", "$state")}</yerd-local>`);
  });

  it("wants a render prop", async () => {
    await expect(renderToString(<Local state={{}}>{"text" as never}</Local>)).rejects.toThrow("<Local> takes a render prop: {(s) => ...}");
  });

  it("calling Local directly throws", () => {
    expect(() => Local({ state: {}, children: () => null })).toThrow("<Local> is rendered by yerd's renderer");
  });
});

describe("text bindings", () => {
  const text = (state: object, read: (s: any) => Child) => renderToString(<Local state={state}>{(s) => read(s)}</Local>).then(inner);

  it.each<[string, object, (s: any) => Child, string]>([
    ["a number", { n: 0 }, (s) => s.n, '<span data-yx-text="n">0</span>'],
    ["a string, escaped", { t: "<b>&" }, (s) => s.t, '<span data-yx-text="t">&lt;b&gt;&amp;</span>'],
    ["a nested field", { a: { b: { c: "x" } } }, (s) => s.a.b.c, '<span data-yx-text="a.b.c">x</span>'],
    ["an array item", { l: ["x", "y"] }, (s) => s.l[1], '<span data-yx-text="l.1">y</span>'],
    ["an array length", { l: [1, 2, 3] }, (s) => s.l.length, '<span data-yx-text="l.length">3</span>'],
    ["a missing field", {}, (s) => s.nope, '<span data-yx-text="nope"></span>'],
    ["below a missing field", {}, (s) => s.a.b, '<span data-yx-text="a.b"></span>'],
    ["null", { v: null }, (s) => s.v, '<span data-yx-text="v"></span>'],
    ["false", { v: false }, (s) => s.v, '<span data-yx-text="v">false</span>'],
    ["an array", { l: [1, 2] }, (s) => s.l, '<span data-yx-text="l">1,2</span>'],
    ["not()", { v: true }, (s) => not(s.v), '<span data-yx-text="!v">false</span>'],
    ["not(not())", { v: true }, (s) => not(not(s.v)), '<span data-yx-text="v">true</span>'],
    ["eq()", { v: 2 }, (s) => eq(s.v, 2), '<span data-yx-text="v=2">true</span>'],
    ["an expression (initial value only)", { n: 2 }, (s) => s.n * 2, "4"],
    ["a template string (initial value only)", { n: 2 }, (s) => `${s.n}!`, "2!"],
    ["string concatenation (initial value only)", { t: "<x>" }, (s) => "a" + s.t, "a&lt;x&gt;"],
    ["a field read twice", { n: 1 }, (s) => [s.n, s.n], '<span data-yx-text="n">1</span><span data-yx-text="n">1</span>'],
  ])("%s", async (_, state, read, html) => {
    expect(await text(state, read)).toBe(html);
  });

  it("a binding in a component prop renders where it's used", async () => {
    const Show = ({ v }: { v: unknown }) => <em>{v as Child}</em>;
    expect(await text({ v: "x" }, (s) => <Show v={s.v} />)).toBe('<em><span data-yx-text="v">x</span></em>');
  });

  it("a binding isn't text inside <script>", async () => {
    await expect(text({ v: "x" }, (s) => <script>{s.v}</script>)).rejects.toThrow("<script> children must be text");
  });

  it("not() and eq() of plain values are plain booleans", () => {
    expect(not(true)).toBe(false);
    expect(not(false)).toBe(true);
    expect(eq(1, 1)).toBe(true);
    expect(eq("a", "b")).toBe(false);
  });
});

describe("attribute bindings", () => {
  const el = (state: object, render: (s: any) => Child) => renderToString(<Local state={state}>{(s) => render(s)}</Local>).then(inner);

  it.each<[string, object, (s: any) => Child, string]>([
    ["a string", { t: 'a"b' }, (s) => <b title={s.t} />, '<b title="a&quot;b" data-yx-bind="title:t"></b>'],
    ["a number", { n: 3 }, (s) => <b tabindex={s.n} />, '<b tabindex="3" data-yx-bind="tabindex:n"></b>'],
    ["hidden, true", { h: true }, (s) => <b hidden={s.h} />, '<b hidden data-yx-bind="hidden:h"></b>'],
    ["hidden, false: omitted but bound", { h: false }, (s) => <b hidden={s.h} />, '<b data-yx-bind="hidden:h"></b>'],
    ["hidden, null: omitted but bound", { h: null }, (s) => <b hidden={s.h} />, '<b data-yx-bind="hidden:h"></b>'],
    ["hidden, missing", {}, (s) => <b hidden={s.h} />, '<b data-yx-bind="hidden:h"></b>'],
    ["aria-*", { o: false }, (s) => <b aria-expanded={s.o} />, '<b aria-expanded="false" data-yx-bind="aria-expanded:o"></b>'],
    ["data-*", { o: true }, (s) => <b data-open={s.o} />, '<b data-open data-yx-bind="data-open:o"></b>'],
    ["value", { v: "<x>" }, (s) => <input value={s.v} />, '<input value="&lt;x&gt;" data-yx-bind="value:v">'],
    ["checked", { c: true }, (s) => <input type="checkbox" checked={s.c} />, '<input type="checkbox" checked data-yx-bind="checked:c">'],
    ["not()", { o: false }, (s) => <b hidden={not(s.o)} />, '<b hidden data-yx-bind="hidden:!o"></b>'],
    ["eq() with a string", { t: "a" }, (s) => <b hidden={eq(s.t, "a")} />, '<b hidden data-yx-bind="hidden:t=%22a%22"></b>'],
    ["eq() with a number", { i: 1 }, (s) => <b hidden={eq(s.i, 2)} />, '<b data-yx-bind="hidden:i=2"></b>'],
    ["eq() with null", { i: null }, (s) => <b hidden={eq(s.i, null)} />, '<b hidden data-yx-bind="hidden:i=null"></b>'],
    ["eq() with false", { i: false }, (s) => <b hidden={eq(s.i, false)} />, '<b hidden data-yx-bind="hidden:i=false"></b>'],
    ["not(eq())", { i: 1 }, (s) => <b hidden={not(eq(s.i, 1))} />, '<b data-yx-bind="hidden:!i=1"></b>'],
    [
      "eq() with ; : = and quotes (URI-encoded, then escaped)",
      { t: "x" },
      (s) => <b hidden={eq(s.t, `a;b:c=d"'&<`)} />,
      '<b data-yx-bind="hidden:t=%22a%3Bb%3Ac%3Dd%5C%22&#39;%26%3C%22"></b>',
    ],
    ["a nested path", { u: { n: "a" } }, (s) => <b title={s.u.n} />, '<b title="a" data-yx-bind="title:u.n"></b>'],
    [
      "several on one element, in prop order",
      { a: "1", b: true },
      (s) => <b title={s.a} hidden={not(s.b)} class={{ on: s.b }} />,
      '<b title="1" class="on" data-yx-bind="title:a;hidden:!b;class.on:b"></b>',
    ],
    ["style from a binding (initial value only)", { c: "red" }, (s) => <b style={{ color: s.c }} />, '<b style="color:red"></b>'],
  ])("%s", async (_, state, render, html) => {
    expect(await el(state, render)).toBe(html);
  });

  it("an object value is refused like any object", async () => {
    await expect(el({ o: { a: 1 } }, (s) => <b title={s.o} />)).rejects.toThrow("Attribute title got an object");
  });

  it("a bound URL attribute is still checked", async () => {
    expect(await el({ u: "javascript:alert(1)" }, (s) => <a href={s.u}>x</a>)).toBe('<a href="about:blank#blocked" data-yx-bind="href:u">x</a>');
  });

  it("a binding passed through a component still binds", async () => {
    const Field = ({ v }: { v: string }) => <input value={v} />;
    expect(await el({ v: "a" }, (s) => <Field v={s.v} />)).toBe('<input value="a" data-yx-bind="value:v">');
  });

  it("a binding outside <Local> is impossible, but a plain value inside is just a value", async () => {
    expect(await el({}, () => <b title="t" hidden={false} />)).toBe('<b title="t"></b>');
  });
});

describe("nested scopes", () => {
  it("each scope writes its own state and name; handlers use their scope's name", async () => {
    const html = await renderToString(
      <Local state={{ a: 1 }}>
        {(outer) => (
          <div>
            <button onClick={() => outer.a++}>{outer.a}</button>
            <Local state={{ b: 2 }}>{(nested) => <button onClick={() => nested.b++}>{nested.b}</button>}</Local>
          </div>
        )}
      </Local>,
    );
    expect(html).toBe(
      `${scope("{&quot;a&quot;:1}", "outer")}<div><button data-yx-on-click="() =&gt; outer.a++"><span data-yx-text="a">1</span></button>` +
        `${scope("{&quot;b&quot;:2}", "nested")}<button data-yx-on-click="() =&gt; nested.b++"><span data-yx-text="b">2</span></button></yerd-local>` +
        "</div></yerd-local>",
    );
  });

  it("handlers after a scope closes are dropped again", async () => {
    const html = await renderToString(
      <>
        <Local state={{}}>{(s) => <i onClick={() => s}>in</i>}</Local>
        <b onClick={() => 1}>out</b>
      </>,
    );
    expect(html).toBe(`${scope("{}")}<i data-yx-on-click="() =&gt; s">in</i></yerd-local><b>out</b>`);
  });

  it("... also after an async scope", async () => {
    const html = await renderToString(
      <>
        <Local state={{}}>{async (s) => <i onClick={() => s}>in</i>}</Local>
        <b onClick={() => 1}>out</b>
      </>,
    );
    expect(html).toBe(`${scope("{}")}<i data-yx-on-click="() =&gt; s">in</i></yerd-local><b>out</b>`);
  });

  it("a render prop that throws rejects with its error", async () => {
    const error = new Error("render prop");
    await expect(renderToString(<Local state={{}}>{(s) => { void s; throw error; }}</Local>)).rejects.toBe(error);
    const Broken = async () => {
      throw error;
    };
    await expect(renderToString(<Local state={{}}>{(s) => (void s, <Broken />)}</Local>)).rejects.toBe(error);
  });
});

describe("persist", () => {
  const persisted = (persist: unknown) => renderToString(<Local state={{}} persist={persist as never}>{(s) => (void s, null)}</Local>);

  it.each<[unknown, string]>([
    ["prefs", ' data-yx-persist="prefs"'],
    [{ key: "prefs" }, ' data-yx-persist="prefs"'],
    [{ key: "prefs", storage: "local" }, ' data-yx-persist="prefs"'],
    [{ key: "prefs", storage: "session" }, ' data-yx-persist="prefs" data-yx-storage="session"'],
    ['a"b<c>&', ' data-yx-persist="a&quot;b&lt;c&gt;&amp;"'],
    [undefined, ""],
  ])("%j", async (persist, attrs) => {
    expect(await persisted(persist)).toBe(`<yerd-local data-yx-local="{}" data-yx-as="s"${attrs} style="display:contents"></yerd-local>`);
  });

  it.each(["", { key: "" }])("refuses an empty key: %j", async (persist) => {
    await expect(persisted(persist)).rejects.toThrow("<Local persist> needs a non-empty key");
  });
});

// Judgment calls, left as they are for now:
describe("open questions", () => {
  // s["a.b"] binds the path "a.b", which the runtime reads as s.a.b; keys with
  // ";", ":" or "=" break the binding list the same way. Refuse, or render unbound?
  it.todo("state keys that can't be written in a binding path");
  // eq(s.x, undefined) writes no "=value", so the runtime binds the field itself
  // while the server rendered the comparison. undefined isn't JSON: refuse it?
  it.todo("eq() with undefined (or an object) as the value");
  // A binding to onclick (or any on* string) sets inline script from state in the browser.
  it.todo("refusing bindings and strings on on* attributes");
  // In dynamic: "only" mode a <Dynamic> inside a <Local> is sent without its
  // scope, so its handlers and bindings have nothing to attach to.
  it.todo("a <Dynamic> inside a <Local> in the runtime's fill-in request");
});

describe("custom attributes and bindings", () => {
  it("prefetch from a binding goes through its render with the value", async () => {
    expect(
      await renderToString(<Local state={{ m: "visible" }}>{(s) => <a href="/x" prefetch={s.m as "visible"}>x</a>}</Local>).then(inner),
    ).toBe('<a href="/x" data-yx-prefetch="visible" data-yx-bind="prefetch:m">x</a>');
  });
});
