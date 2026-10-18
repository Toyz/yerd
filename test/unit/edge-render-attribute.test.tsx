import { afterEach, describe, expect, it } from "vitest";
import { attribute, json, raw, renderToString, resetAttributeRegistry, type ClientSetup } from "@toyz/yerd";
import { jsx } from "@toyz/yerd/jsx-runtime";
import { attributesSource } from "../../src/attributes/attribute.js";

afterEach(() => resetAttributeRegistry());

// Client halves as a compiler or minifier may print them.
const fn = (source: string) => new Function(`return ${source}`)() as ClientSetup;

/** Evaluate the registration script and return what each attribute registered. */
function registered(): Map<string, Function> {
  const out = new Map<string, Function>();
  new Function("window", attributesSource())({ yerd: { attribute: (name: string, setup: Function) => out.set(name, setup) } });
  return out;
}

/** Render one element with these props and return its start tag's attributes. */
async function attrs(props: Record<string, unknown>, tag = "b"): Promise<string> {
  const html = await renderToString(jsx(tag, props));
  return html.slice(tag.length + 1, html.indexOf(">"));
}

describe("attribute() names", () => {
  it.each(["a", "abc", "a-b", "a1", "a1-b2-c3", "data-x", "aria-x", "onx", "title"])("takes %j", (name) => {
    expect(attribute(name, {}).name).toBe(name);
  });

  it.each(["", "A", "aB", "1a", "-a", "a-", "a--b", "a_b", "a b", "a.b", "a:b", "é", 'a"'])("refuses %j", (name) => {
    expect(() => attribute(name, {})).toThrow(`Custom attribute names are lowercase words joined by dashes; got ${JSON.stringify(name)}`);
  });

  it("can be defined again after a reset", () => {
    attribute("again", {});
    expect(() => attribute("again", {})).toThrow('Custom attribute "again" is defined twice');
    resetAttributeRegistry();
    expect(() => attribute("again", {})).not.toThrow();
  });
});

describe("custom attributes on the server", () => {
  it.each<[string, unknown, string]>([
    ["a string", "x", ' probe="x"'],
    ["an escaped string", '"<&>', ' probe="&quot;&lt;&amp;&gt;"'],
    ["true", true, " probe"],
    ["false", false, ""],
    ["a number", 3, ' probe="3"'],
    ["NaN", NaN, ""],
    ["an object, as JSON", { a: "<b>" }, ' probe="{&quot;a&quot;:&quot;&lt;b&gt;&quot;}"'],
    ["an array, as JSON", [1, "x"], ' probe="[1,&quot;x&quot;]"'],
    ["raw(), verbatim", raw("&amp;"), ' probe="&amp;"'],
    ["json(), escaped", json({ a: 1 }), ' probe="{&quot;a&quot;:1}"'],
    ["a Date, as JSON", new Date(0), ' probe="&quot;1970-01-01T00:00:00.000Z&quot;"'],
    ["null", null, ""],
  ])("without render, writes %s under its own name", async (_, value, written) => {
    attribute("probe", {});
    expect(await attrs({ probe: value })).toBe(written);
  });

  it.each<[string, unknown, string]>([
    ["null", null, ' id="i"'],
    ["undefined", undefined, ' id="i"'],
    ["an empty object", {}, ' id="i"'],
    ["several attributes", { "data-a": "1", "aria-label": "<x>", hidden: true, off: false }, ' data-a="1" aria-label="&lt;x&gt;" hidden id="i"'],
    ["its own name", { probe: "self" }, ' probe="self" id="i"'],
    ["a class and a style", { class: ["a", { b: true }], style: { marginTop: "1px" } }, ' class="a b" style="margin-top:1px" id="i"'],
    ["a URL attribute (still checked)", { href: "javascript:x" }, ' href="about:blank#blocked" id="i"'],
  ])("render returning %s", async (_, rendered, written) => {
    attribute("probe", { render: () => rendered as Record<string, unknown> });
    expect(await attrs({ probe: "v", id: "i" })).toBe(written);
  });

  it("render gets the value, the tag and all the props", async () => {
    const seen: unknown[] = [];
    attribute<{ n: number }>("probe", {
      render: (value, element) => {
        seen.push(value, element.tag, element.props);
        return null;
      },
    });
    const props = { probe: { n: 1 }, id: "x" };
    await attrs(props, "section");
    expect(seen).toEqual([{ n: 1 }, "section", props]);
  });

  it("render isn't called for null or undefined", async () => {
    let calls = 0;
    attribute("probe", { render: () => (calls++, null) });
    await attrs({ probe: null });
    await attrs({ probe: undefined });
    expect(calls).toBe(0);
  });

  it("render is called for false (it decides)", async () => {
    attribute<boolean>("probe", { render: (on) => ({ "data-on": on ? "yes" : "no" }) });
    expect(await attrs({ probe: false })).toBe(' data-on="no"');
  });

  it("what render writes is checked: bad names, functions and objects throw", async () => {
    attribute("bad-name", { render: () => ({ "a b": "x" }) });
    attribute("bad-fn", { render: () => ({ title: () => 1 }) });
    attribute("bad-obj", { render: () => ({ title: { a: 1 } }) });
    await expect(attrs({ "bad-name": "v" })).rejects.toThrow('Invalid attribute name: "a b"');
    await expect(attrs({ "bad-fn": "v" })).rejects.toThrow("Attribute title got a function");
    await expect(attrs({ "bad-obj": "v" })).rejects.toThrow("Attribute title got an object");
  });

  it("another custom attribute's name in render's output is written plain, not rendered again", async () => {
    let otherCalls = 0;
    attribute("other", { render: () => (otherCalls++, { "data-other": "1" }) });
    attribute("probe", { render: () => ({ other: "plain" }) });
    expect(await attrs({ probe: "v" })).toBe(' other="plain"');
    expect(otherCalls).toBe(0);
  });

  it("an error in render rejects the render", async () => {
    attribute("probe", { render: () => { throw new Error("render broke"); } });
    await expect(attrs({ probe: "v" })).rejects.toThrow("render broke");
  });

  it("a custom attribute can take over a real attribute's name", async () => {
    attribute<string>("title", { render: (t) => ({ title: t.toUpperCase() }) });
    expect(await attrs({ title: "hi" })).toBe(' title="HI"');
  });

  it("defining or resetting attributes after a render takes effect on the next one", async () => {
    expect(await attrs({ late: "v" })).toBe(' late="v"');
    attribute("late", { render: () => ({ "data-late": "yes" }) });
    expect(await attrs({ late: "v" })).toBe(' data-late="yes"');
    resetAttributeRegistry();
    expect(await attrs({ late: "v" })).toBe(' late="v"');
  });

  it("built-ins survive a reset", async () => {
    resetAttributeRegistry();
    expect(await attrs({ href: "/x", prefetch: true }, "a")).toBe(' href="/x" data-yx-prefetch="intent"');
  });

  // Judgment call: render's output and the element's own props can name the
  // same attribute; both are written and the browser keeps the first.
  it.todo("render's output and the element's own attributes are merged (class) or de-duplicated");
});

describe("prefetch", () => {
  it.each<[unknown, string, Record<string, unknown>, string]>([
    [true, "a", { href: "/x" }, ' href="/x" data-yx-prefetch="intent"'],
    ["visible", "a", { href: "/x" }, ' href="/x" data-yx-prefetch="visible"'],
    ["load", "area", { href: "/x" }, ' href="/x" data-yx-prefetch="load"'],
    [false, "a", { href: "/x" }, ' href="/x"'],
    [{ url: "/api", as: "json" }, "div", {}, ' data-yx-prefetch="intent" data-yx-prefetch-url="/api" data-yx-prefetch-as="json"'],
    [{ url: "/p", on: "visible", as: "page" }, "div", {}, ' data-yx-prefetch="visible" data-yx-prefetch-url="/p"'],
    [{ url: '/a"b' }, "div", {}, ' data-yx-prefetch="intent" data-yx-prefetch-url="/a&quot;b"'],
  ])("%j on <%s>", async (value, tag, props, written) => {
    expect(await attrs({ ...props, prefetch: value }, tag)).toBe(written);
  });

  it.each<[unknown, string, Record<string, unknown>, string]>([
    [true, "div", {}, "prefetch on <div> needs an href to prefetch, or prefetch={{ url }}"],
    [true, "a", {}, "prefetch on <a> needs an href"],
    [true, "a", { href: new URL("http://x/") }, "prefetch on <a> needs an href"],
    ["hover", "a", { href: "/x" }, 'prefetch="hover" isn\'t a mode; use "intent", "visible" or "load"'],
    [{ url: "/x", on: "soon" }, "div", {}, 'prefetch="soon" isn\'t a mode'],
  ])("refuses %j on <%s>", async (value, tag, props, message) => {
    await expect(attrs({ ...props, prefetch: value }, tag)).rejects.toThrow(message);
  });
});

describe("client half source", () => {
  it.each([
    ["(el) => { el.title = 'x' }", "(el) => { el.title = 'x' }"],
    ["el => el.remove()", "el => el.remove()"],
    ["async (el) => { el.title = 'x' }", "async (el) => { el.title = 'x' }"],
    // Minified: no space after async. It was taken for method shorthand and
    // wrapped into ({ async(el)=>... })[""], which doesn't parse.
    ["async(el)=>{el.title='x'}", "async(el)=>{el.title='x'}"],
    ["async el=>{el.title='x'}", "async el=>{el.title='x'}"],
    ["function (el) { el.title = 'x' }", "function (el) { el.title = 'x' }"],
    ["function named(el) { el.title = 'x' }", "function named(el) { el.title = 'x' }"],
    ["async function (el) { el.title = 'x' }", "async function (el) { el.title = 'x' }"],
    ["async => async", "async => async"],
  ])("%s", (source, written) => {
    attribute("probe", { client: fn(source) });
    expect(attributesSource()).toBe(`((yerd) => {\n  yerd.attribute("probe", ${written});\n})(window.yerd);\n`);
    expect(typeof registered().get("probe")).toBe("function");
  });

  it.each([
    ["{ client(el) { el.title = 'x' } }.client", '({ client(el) { el.title = \'x\' } })["client"]'],
    ["{ async client(el) { el.title = 'x' } }.client", '({ async client(el) { el.title = \'x\' } })["client"]'],
    ["{ *client(el) {} }.client", '({ *client(el) {} })["client"]'],
    ['{ "my-client"(el) {} }["my-client"]', '({ "my-client"(el) {} })["my-client"]'],
    ["{ asyncSetup(el) {} }.asyncSetup", '({ asyncSetup(el) {} })["asyncSetup"]'],
    ["{ functional(el) {} }.functional", '({ functional(el) {} })["functional"]'],
  ])("wraps method shorthand: %s", (source, written) => {
    attribute("probe", { client: fn(`(${source})`) });
    expect(attributesSource()).toContain(`yerd.attribute("probe", ${written});`);
    expect(typeof registered().get("probe")).toBe("function");
  });

  it("is empty with no client halves, and skips server-only attributes", () => {
    expect(attributesSource()).toBe("");
    attribute("server-only", { render: (v: string) => ({ "data-v": v }) });
    expect(attributesSource()).toBe("");
  });

  it("lists attributes in definition order and refreshes when one is added", () => {
    attribute("b-one", { client: fn("() => {}") });
    const first = attributesSource();
    expect(attributesSource()).toBe(first);
    attribute("a-two", { client: fn("() => {}") });
    expect([...registered().keys()]).toEqual(["b-one", "a-two"]);
  });

  it("refuses compiler helpers", () => {
    attribute("probe", { client: fn("function () { return __awaiter(this, void 0, void 0, function* () {}) }") });
    expect(() => attributesSource()).toThrow('The client half of attribute "probe" uses a compiler helper');
  });
});
