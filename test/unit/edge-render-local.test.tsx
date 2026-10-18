import { describe, expect, it } from "vitest";
import { Local, eq, not, renderToString, type Child } from "@toyz/yerd";
import { jsx } from "@toyz/yerd/jsx-runtime";
import { stateName } from "../../src/render/local.js";

const scope = (state: string, as = "s") =>
  `<yerd-local data-yx-local="${state}" data-yx-as="${as}" style="display:contents">`;

/** What a scope rendered, without its <yerd-local> wrapper. */
const inner = (html: string) => html.replace(/^<yerd-local[^>]*>/, "").replace(/<\/yerd-local>$/, "");

// Function sources as a compiler or minifier may print them.
const fn = (source: string) => new Function(`return ${source}`)() as Function;

describe("stateName", () => {
  it.each([
    ["(s) => 1", "s"],
    ["s => 1", "s"],
    ["s=>1", "s"],
    ["(state)=>1", "state"],
    ["( s ) => 1", "s"],
    ["(s, extra) => 1", "s"],
    ["(s = {}) => 1", "s"],
    ["function (s) { return 1 }", "s"],
    ["function named(s) { return 1 }", "s"],
    ["function(s){return 1}", "s"],
    ["async (s) => 1", "s"],
    ["async s => 1", "s"],
    ["async(s)=>1", "s"],
    ["async function (s) { return 1 }", "s"],
    ["$ => 1", "$"],
    ["_s => 1", "_s"],
    // Names that merely start with a keyword.
    ["asyncState => 1", "asyncState"],
    ["(asyncState) => 1", "asyncState"],
    ['functional => jsx("div", {})', "functional"],
    ["functions => 1", "functions"],
    ["async asyncState => 1", "asyncState"],
  ])("%s -> %s", (source, name) => {
    expect(stateName(fn(source))).toBe(name);
  });

  it.each([
    ["({ a }) => 1", "{"],
    ["([a]) => 1", "[a]"],
    ["(...s) => 1", "...s"],
    ["() => 1", "() => 1"],
  ])("refuses %s", (source, shown) => {
    expect(() => stateName(fn(source))).toThrow(`plain parameter name, like (s) => ..., not ${JSON.stringify(shown)}`);
  });
});

describe("bindings are not thenables", () => {
  it("an async component can return a binding", async () => {
    const Count = async ({ c }: { c: number }) => c;
    expect(await renderToString(<Local state={{ x: 1 }}>{(s) => <i><Count c={s.x} /></i>}</Local>)).toBe(
      `${scope("{&quot;x&quot;:1}")}<i><span data-yx-text="x">1</span></i></yerd-local>`,
    );
  });

  it("a promise of a binding settles", async () => {
    expect(await renderToString(<Local state={{ x: "a" }}>{(s) => Promise.resolve(s.x)}</Local>)).toBe(
      `${scope("{&quot;x&quot;:&quot;a&quot;}")}<span data-yx-text="x">a</span></yerd-local>`,
    );
  });

  it("the render prop may be async", async () => {
    expect(await renderToString(<Local state={{ x: 2 }}>{async (s) => <b>{s.x}</b>}</Local>)).toBe(
      `${scope("{&quot;x&quot;:2}")}<b><span data-yx-text="x">2</span></b></yerd-local>`,
    );
  });

  it("a state field called then is still bound", async () => {
    expect(await renderToString(<Local state={{ then: 3 }}>{(s) => <b>{s.then}</b>}</Local>)).toBe(
      `${scope("{&quot;then&quot;:3}")}<b><span data-yx-text="then">3</span></b></yerd-local>`,
    );
  });
});

describe("class bindings", () => {
  const render = (child: (s: { on: boolean; theme: string }) => Child) =>
    renderToString(<Local state={{ on: false, theme: "dark" }}>{child}</Local>).then(inner);

  it("a binding as a class name in a list renders its value (it was dropped)", async () => {
    expect(await render((s) => <b class={["card", s.theme]} />)).toBe('<b class="card dark"></b>');
    expect(await render((s) => <b class={[[s.theme]]} />)).toBe('<b class="dark"></b>');
  });

  it("className flags are bound when class is given too (they rendered as always on)", async () => {
    expect(await render((s) => <b class="btn" className={{ active: s.on }} />)).toBe(
      '<b class="btn" data-yx-bind="class.active:on"></b>',
    );
    expect(await render((s) => <b className={{ active: s.on }} class={["btn", { big: not(s.on) }]} />)).toBe(
      '<b class="btn big" data-yx-bind="class.active:on;class.big:!on"></b>',
    );
  });

  it("a whole-attribute className binding binds class (the runtime would set a classname attribute)", async () => {
    expect(await render((s) => <b className={s.theme} />)).toBe('<b class="dark" data-yx-bind="class:theme"></b>');
    expect(await render((s) => <b class={s.theme} />)).toBe('<b class="dark" data-yx-bind="class:theme"></b>');
  });

  it("next to the other spelling a whole-attribute binding is just its value (binding it would drop the rest)", async () => {
    expect(await render((s) => <b class="btn" className={s.theme} />)).toBe('<b class="btn dark"></b>');
    expect(await render((s) => <b class={s.theme} className="btn" />)).toBe('<b class="dark btn"></b>');
  });

  it("a flag naming several classes binds each one", async () => {
    expect(await render((s) => <b class={{ "text-red  bold": not(s.on) }} />)).toBe(
      '<b class="text-red  bold" data-yx-bind="class.text-red:!on;class.bold:!on"></b>',
    );
    expect(await render((s) => <b class={{ " pad ": s.on }} />)).toBe('<b data-yx-bind="class.pad:on"></b>');
  });

  it("flags with colons (Tailwind variants) keep their name", async () => {
    expect(await render((s) => <b class={{ "md:block": not(s.on), "hover:underline": s.on }} />)).toBe(
      '<b class="md:block" data-yx-bind="class.md:block:!on;class.hover:underline:on"></b>',
    );
  });
});

describe("state that isn't an object", () => {
  // It rendered data-yx-local="undefined" (or "null", or a bare string), which the runtime can't use.
  it.each([
    [undefined, "undefined"],
    [() => 1, "function"],
    [Symbol("s"), "symbol"],
    [null, "null"],
    [3, "3"],
    ["x", '"x"'],
    [true, "true"],
    [new Date(0), '"1970-01-01T00:00:00.000Z"'],
  ])("refuses %s", async (state, shown) => {
    await expect(renderToString(<Local state={state as never}>{() => <b />}</Local>)).rejects.toThrow(
      `<Local> state must be an object, got ${shown}`,
    );
  });

  it("takes an array", async () => {
    expect(await renderToString(<Local state={[1, "a"]}>{(s) => <b>{s[1]}</b>}</Local>)).toBe(
      `${scope("[1,&quot;a&quot;]")}<b><span data-yx-text="1">a</span></b></yerd-local>`,
    );
  });

  it("refuses a bigint inside with the JSON message", async () => {
    await expect(renderToString(<Local state={{ n: 1n }}>{() => <b />}</Local>)).rejects.toThrow(
      /^<Local> state must be JSON \(plain objects, arrays, strings, numbers, booleans\): /,
    );
  });
});

describe("eq() and not()", () => {
  it("refuses eq(not(field), value): the runtime would compare the field itself", async () => {
    await expect(
      renderToString(<Local state={{ on: false }}>{(s) => <b hidden={eq(not(s.on), true)} />}</Local>),
    ).rejects.toThrow("eq() takes a field of the state, not not(); write not(eq(field, value))");
  });

  it("refuses eq(eq(...))", async () => {
    await expect(
      renderToString(<Local state={{ on: false }}>{(s) => <b hidden={eq(eq(s.on, true), true)} />}</Local>),
    ).rejects.toThrow("not another eq()");
  });
});

describe("handler source", () => {
  const handler = (on: unknown) =>
    renderToString(<Local state={{ n: 0 }}>{(s) => (void s, jsx("b", { onClick: on })) as never}</Local>).then(inner);

  it.each([
    [fn("() => s.n++"), "() =&gt; s.n++"],
    [fn("(e) => { s.n = e.detail }"), "(e) =&gt; { s.n = e.detail }"],
    [fn("e=>s.n++"), "e=&gt;s.n++"],
    [fn("async (e) => { await 1; s.n++ }"), "async (e) =&gt; { await 1; s.n++ }"],
    [fn("async(e)=>{s.n++}"), "async(e)=&gt;{s.n++}"],
    [fn("function (e) { s.n++ }"), "function (e) { s.n++ }"],
    [fn("function named(e) { s.n++ }"), "function named(e) { s.n++ }"],
    [fn("async function (e) { s.n++ }"), "async function (e) { s.n++ }"],
    [fn("() => { /* a \"comment\" */ s.n++ // more\n}"), "() =&gt; { /* a &quot;comment&quot; */ s.n++ // more\n}"],
    [fn("() => s.n = '<\\/script>&amp;'"), "() =&gt; s.n = &#39;&lt;\\/script&gt;&amp;amp;&#39;"],
  ])("%s", async (on, written) => {
    expect(await handler(on)).toBe(`<b data-yx-on-click="${written}"></b>`);
  });

  // A method from a spread object prints as `onClick() {...}`, which isn't an
  // expression on its own: the runtime's `return (...)` would not compile.
  it("wraps method shorthand so it's an expression", async () => {
    const methods = fn("{ onClick(e) { s.n++ }, async onInput() { s.n-- } }") as unknown as Record<string, unknown>;
    expect(await renderToString(<Local state={{ n: 0 }}>{(s) => (void s, jsx("b", methods)) as never}</Local>).then(inner)).toBe(
      '<b data-yx-on-click="({ onClick(e) { s.n++ } })[&quot;onClick&quot;]"' +
        ' data-yx-on-input="({ async onInput() { s.n-- } })[&quot;onInput&quot;]"></b>',
    );
  });

  it.each([
    ["a built-in", console.log],
    ["a bound function", (() => 1).bind(null)],
  ])("refuses %s: there's no source to send", async (_, on) => {
    await expect(handler(on)).rejects.toThrow("onClick in <Local> is a built-in or bound function");
  });

  it.each([
    "function () { return __awaiter(this, void 0, void 0, function* () {}) }",
    "() => __name(() => 1, 'x')",
  ])("refuses compiler helpers: %s", async (source) => {
    await expect(handler(fn(source))).rejects.toThrow("was compiled with a helper");
  });
});

describe("<Local> handler names", () => {
  // A spread object's keys reach the renderer unchecked; inside <Local> a
  // handler's name becomes part of an attribute name.
  it.each(['on x"><i', "on click", "on<b>", "on=x", "on/x", "on'x", "on\nx"])("refuses %j inside <Local>", async (name) => {
    await expect(
      renderToString(<Local state={{ x: 1 }}>{(s) => jsx("b", { [name]: () => s.x }) as never}</Local>),
    ).rejects.toThrow(`Invalid attribute name: ${JSON.stringify(name)}`);
  });

  it("still drops an invalid handler name outside <Local> (nothing is written)", async () => {
    expect(await renderToString(jsx("b", { 'on x"><i': () => 1 }))).toBe("<b></b>");
  });

  it("writes a valid one, lowercased", async () => {
    expect(await renderToString(<Local state={{}}>{(s) => <b onMouseEnter={() => s}>x</b>}</Local>)).toBe(
      `${scope("{}")}<b data-yx-on-mouseenter="() =&gt; s">x</b></yerd-local>`,
    );
  });
});
