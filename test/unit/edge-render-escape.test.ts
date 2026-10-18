import { describe, expect, it } from "vitest";
import { createElement, escapeHtml, json, raw, renderToString } from "@toyz/yerd";
import { isRawHtml } from "../../src/render/escape.js";

/** The inverse of escapeHtml, for round trips. */
const unescape = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

describe("escapeHtml", () => {
  it.each([
    ["", ""],
    ["plain", "plain"],
    ["&", "&amp;"],
    ["<", "&lt;"],
    [">", "&gt;"],
    ['"', "&quot;"],
    ["'", "&#39;"],
    ["&<>\"'", "&amp;&lt;&gt;&quot;&#39;"],
    ["<<>>", "&lt;&lt;&gt;&gt;"],
    ["a&b", "a&amp;b"],
    ["&a", "&amp;a"],
    ["a&", "a&amp;"],
    ["&amp;", "&amp;amp;"],
    ["&#39;", "&amp;#39;"],
    ["<script>alert(1)</script>", "&lt;script&gt;alert(1)&lt;/script&gt;"],
    ['" onmouseover="x', "&quot; onmouseover=&quot;x"],
    ["' autofocus x='", "&#39; autofocus x=&#39;"],
    ["<!-- -->", "&lt;!-- --&gt;"],
    ["`backtick` = ok", "`backtick` = ok"],
    ["/ \\ ; :", "/ \\ ; :"],
    ["tab\tnl\ncr\r", "tab\tnl\ncr\r"],
    ["\u0000nul", "\u0000nul"],
    ["\u2028\u2029", "\u2028\u2029"],
    ["\ud800 lone", "\ud800 lone"],
    ["\udfff<", "\udfff&lt;"],
    ["\u{1F600}<\u{1F600}", "\u{1F600}&lt;\u{1F600}"],
    ["é<ü", "é&lt;ü"],
    ["\uFEFF<", "\uFEFF&lt;"],
    ["＜fullwidth＞", "＜fullwidth＞"],
  ])("%j -> %j", (input, output) => {
    expect(escapeHtml(input)).toBe(output);
  });

  it("handles long strings with and without specials", () => {
    const clean = "a".repeat(100_000);
    expect(escapeHtml(clean)).toBe(clean);
    expect(escapeHtml("<".repeat(50_000))).toBe("&lt;".repeat(50_000));
    expect(escapeHtml(`${clean}&${clean}`)).toBe(`${clean}&amp;${clean}`);
  });

  it("round-trips every ASCII and some non-ASCII characters", () => {
    let all = "";
    for (let c = 0; c < 0x300; c++) all += String.fromCharCode(c);
    const escaped = escapeHtml(all);
    expect(escaped).not.toMatch(/[<>"']/);
    expect(escaped.replace(/&(amp|lt|gt|quot|#39);/g, "")).not.toContain("&");
    expect(unescape(escaped)).toBe(all);
  });

  it("is stable across repeated calls (no regex lastIndex state)", () => {
    for (let i = 0; i < 5; i++) expect(escapeHtml("x<y")).toBe("x&lt;y");
  });
});

describe("text children", () => {
  it.each([
    ["<b>", "&lt;b&gt;"],
    ["a & b", "a &amp; b"],
    ['"q"', "&quot;q&quot;"],
    ["\u2028", "\u2028"],
    ["\u0000", "\u0000"],
  ])("%j", async (text, written) => {
    expect(await renderToString(createElement("p", null, text))).toBe(`<p>${written}</p>`);
  });

  it.each([
    [0, "0"],
    [-0, "0"],
    [1.5, "1.5"],
    [-1, "-1"],
    [1e21, "1e+21"],
    [NaN, "NaN"],
    [Infinity, "Infinity"],
    [-Infinity, "-Infinity"],
    [10n, "10"],
    [-(2n ** 70n), "-1180591620717411303424"],
  ])("number %s", async (n, written) => {
    expect(await renderToString(createElement("p", null, n))).toBe(`<p>${written}</p>`);
  });

  it.each([null, undefined, true, false])("%s renders nothing", async (value) => {
    expect(await renderToString(createElement("p", null, value))).toBe("<p></p>");
  });

  it.each([
    [Symbol("s"), "Cannot render symbol as a child"],
    [() => 1, "Cannot render function as a child"],
    [{ toString: () => "x" }, "Cannot render [object Object] as a child"],
    [new Date(0), "Cannot render [object Date] as a child"],
    [/re/, "Cannot render [object RegExp] as a child"],
    [new URL("http://x/"), "Cannot render [object URL] as a child"],
  ])("refuses %s", async (value, message) => {
    await expect(renderToString(createElement("p", null, value as never))).rejects.toThrow(message);
  });
});

describe("raw()", () => {
  it("is branded and written as is", async () => {
    const r = raw("<b>&amp;</b>");
    expect(isRawHtml(r)).toBe(true);
    expect(r.html).toBe("<b>&amp;</b>");
    expect(await renderToString(createElement("p", null, r))).toBe("<p><b>&amp;</b></p>");
  });

  it("is told apart from look-alikes", () => {
    expect(isRawHtml({ html: "<b>" })).toBe(false);
    expect(isRawHtml({ [Symbol("yerd.raw")]: true, html: "<b>" })).toBe(false);
    expect(isRawHtml({ [Symbol.for("yerd.raw")]: "yes", html: "<b>" })).toBe(false);
    expect(isRawHtml(null)).toBe(false);
    expect(isRawHtml("<b>")).toBe(false);
  });

  it("a look-alike object as a child is refused, not written", async () => {
    await expect(renderToString(createElement("p", null, { html: "<b>" } as never))).rejects.toThrow("Cannot render");
  });

  it("empty raw() writes nothing", async () => {
    expect(await renderToString(createElement("p", null, raw("")))).toBe("<p></p>");
  });
});

describe("json()", () => {
  it.each([
    [{ a: 1 }, '{"a":1}'],
    ["</script>", '"\\u003c/script\\u003e"'],
    ["<!--", '"\\u003c!--"'],
    ["-->", '"--\\u003e"'],
    ["a&b", '"a\\u0026b"'],
    ["\u2028\u2029", '"\\u2028\\u2029"'],
    ["'\"", '"\'\\""'],
    ["\u0000", '"\\u0000"'],
    ["\ud800", '"\\ud800"'],
    [[1, null, true], "[1,null,true]"],
    [null, "null"],
    [undefined, "null"],
    [() => 1, "null"],
    [Symbol("s"), "null"],
    [NaN, "null"],
    [new Date(0), '"1970-01-01T00:00:00.000Z"'],
    [{ toJSON: () => "<x>" }, '"\\u003cx\\u003e"'],
    [{ u: undefined, f: () => 1, k: 1 }, '{"k":1}'],
    [{ "<key>": 1 }, '{"\\u003ckey\\u003e":1}'],
  ])("%j", (value, text) => {
    expect(json(value).html).toBe(text);
  });

  it.each([
    "</script><script>alert(1)</script>",
    "<!--<script>",
    "</SCRIPT >",
    "\u2028 & \u2029",
    "</style>",
  ])("parses back to the same value from inside a <script>: %j", async (text) => {
    const html = await renderToString(createElement("script", { type: "application/json" }, json({ text })));
    const inner = html.slice(html.indexOf(">") + 1, html.lastIndexOf("</script>"));
    expect(inner).not.toMatch(/<|>|&|\u2028|\u2029/);
    expect(JSON.parse(inner)).toEqual({ text });
  });

  it("refuses a bigint (JSON can't hold one)", () => {
    expect(() => json(1n)).toThrow(TypeError);
  });

  it("refuses a cycle", () => {
    const a: Record<string, unknown> = {};
    a.a = a;
    expect(() => json(a)).toThrow(TypeError);
  });

  it("is raw() HTML: as text content it's written unescaped (and safe: no <, >, &)", async () => {
    expect(await renderToString(createElement("p", null, json({ a: "<b>" })))).toBe('<p>{"a":"\\u003cb\\u003e"}</p>');
  });
});

describe("json() as an attribute value", () => {
  // JSON is full of double quotes: written verbatim like other raw() values,
  // a string field could end the attribute and add its own.
  it("is escaped, so data can't break out of the attribute", async () => {
    const props = { name: '" onmouseover="alert(1)', tag: "</b><script>" };
    expect(await renderToString(createElement("b", { "data-props": json(props) }))).toBe(
      '<b data-props="{&quot;name&quot;:&quot;\\&quot; onmouseover=\\&quot;alert(1)&quot;,&quot;tag&quot;:&quot;\\u003c/b\\u003e\\u003cscript\\u003e&quot;}"></b>',
    );
  });

  it("decodes back to the same JSON", async () => {
    const data = { a: [1, "x'y"], b: null, c: "&amp; \u2028" };
    const html = await renderToString(createElement("b", { "data-x": json(data) }));
    const value = html.slice('<b data-x="'.length, -'"></b>'.length);
    const decoded = value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    expect(JSON.parse(decoded)).toEqual(data);
  });

  it("scalars are unchanged", async () => {
    expect(await renderToString(createElement("b", { "data-n": json(5), "data-t": json(true), "data-z": json(null) }))).toBe(
      '<b data-n="5" data-t="true" data-z="null"></b>',
    );
  });

  it("plain raw() stays verbatim", async () => {
    expect(await renderToString(createElement("b", { title: raw("&amp;&#x27;") }))).toBe('<b title="&amp;&#x27;"></b>');
  });

  it("as script text it's still unescaped", async () => {
    expect(await renderToString(createElement("script", { type: "application/json" }, json({ a: '"' })))).toBe(
      '<script type="application/json">{"a":"\\""}</script>',
    );
  });
});
