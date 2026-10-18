import { describe, expect, it } from "vitest";
import { createElement, raw, renderToString } from "@toyz/yerd";
import { jsx } from "@toyz/yerd/jsx-runtime";

/** Render one element with these props and return its start tag's attributes. */
async function attrs(props: Record<string, unknown>, tag = "b"): Promise<string> {
  const html = await renderToString(jsx(tag, props));
  return html.slice(tag.length + 1, html.indexOf(">"));
}

describe("attribute values", () => {
  it.each<[string, unknown, string]>([
    ["string", "x", ' title="x"'],
    ["empty string", "", ' title=""'],
    ["escaped string", `<"'&>`, ' title="&lt;&quot;&#39;&amp;&gt;"'],
    ["breakout attempt", '" onmouseover="alert(1)', ' title="&quot; onmouseover=&quot;alert(1)"'],
    ["newline", "a\nb", ' title="a\nb"'],
    ["U+2028", " ", ' title=" "'],
    ["null byte", "\u0000", ' title="\u0000"'],
    ["lone surrogate", "\ud800", ' title="\ud800"'],
    ["zero", 0, ' title="0"'],
    ["negative zero", -0, ' title="0"'],
    ["float", 0.1 + 0.2, ' title="0.30000000000000004"'],
    ["big number", 1e21, ' title="1e+21"'],
    ["Infinity", Infinity, ' title="Infinity"'],
    ["-Infinity", -Infinity, ' title="-Infinity"'],
    ["NaN", NaN, ""],
    ["bigint", 10n, ' title="10"'],
    ["true", true, " title"],
    ["false", false, ""],
    ["null", null, ""],
    ["undefined", undefined, ""],
    ["Date", new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), ' title="2026-01-02T03:04:05.000Z"'],
    ["URL", new URL("https://example.com/a b?q=<x>"), ' title="https://example.com/a%20b?q=%3Cx%3E"'],
    ["raw", raw("&amp;"), ' title="&amp;"'],
  ])("%s", async (_, value, written) => {
    expect(await attrs({ title: value })).toBe(written);
  });

  it.each<[string, unknown, string]>([
    ["object", { a: 1 }, "Attribute title got an object; only class and style accept objects"],
    ["array", ["a"], "Attribute title got an object; only class and style accept objects"],
    ["object with toString", { toString: () => "x" }, "Attribute title got an object"],
    ["Map", new Map(), "Attribute title got an object"],
    ["invalid Date", new Date(NaN), "Attribute title got an invalid Date"],
    ["function", () => 1, "Attribute title got a function"],
  ])("refuses %s", async (_, value, message) => {
    await expect(attrs({ title: value })).rejects.toThrow(message);
  });

  it("keeps prop order", async () => {
    expect(await attrs({ z: "1", a: "2", m: "3" })).toBe(' z="1" a="2" m="3"');
  });

  it("never writes children or key as attributes", async () => {
    expect(await renderToString(jsx("b", { children: "x", id: "i" }, "k"))).toBe('<b id="i" data-key="k">x</b>');
  });
});

describe("boolean and enumerated attributes", () => {
  it.each<[string, unknown, string]>([
    ["hidden", true, " hidden"],
    ["hidden", false, ""],
    ["disabled", true, " disabled"],
    ["hidden", "until-found", ' hidden="until-found"'],
    ["aria-hidden", true, ' aria-hidden="true"'],
    ["aria-hidden", false, ' aria-hidden="false"'],
    ["aria-hidden", "false", ' aria-hidden="false"'],
    ["aria-level", 2, ' aria-level="2"'],
    ["aria-label", "", ' aria-label=""'],
    ["aria-expanded", null, ""],
    ["draggable", true, ' draggable="true"'],
    ["draggable", false, ' draggable="false"'],
    ["spellcheck", false, ' spellcheck="false"'],
    ["spellCheck", true, ' spellCheck="true"'],
    ["contenteditable", true, ' contenteditable="true"'],
    ["contentEditable", false, ' contentEditable="false"'],
    ["contenteditable", "plaintext-only", ' contenteditable="plaintext-only"'],
    ["translate", true, ' translate="yes"'],
    ["translate", false, ' translate="no"'],
    // Omitted, both of these mean "on": false has to be written out.
    ["writingsuggestions", false, ' writingsuggestions="false"'],
    ["writingsuggestions", true, ' writingsuggestions="true"'],
    ["autocorrect", false, ' autocorrect="off"'],
    ["autocorrect", true, ' autocorrect="on"'],
    ["autocorrect", "off", ' autocorrect="off"'],
    ["data-open", true, " data-open"],
    ["data-open", false, ""],
    ["data-aria-x", false, ""],
    ["ariaHidden", false, ""],
    ["Aria-hidden", false, ""],
  ])("%s={%j}", async (name, value, written) => {
    expect(await attrs({ [name]: value })).toBe(written);
  });
});

describe("attribute names", () => {
  it.each([
    ["a b"],
    ["a\tb"],
    ["a\nb"],
    ['a"b'],
    ["a'b"],
    ["a<b"],
    ["a>b"],
    ["a/b"],
    ["a=b"],
    ["a\u0000b"],
    ["a\u001fb"],
    ["a\u007fb"],
    [""],
    [" "],
    ['"><script>alert(1)</script>'],
  ])("refuses %j", async (name) => {
    await expect(attrs({ [name]: "x" })).rejects.toThrow(`Invalid attribute name: ${JSON.stringify(name)}`);
  });

  it.each([
    ["data-é", "x"],
    ["x:y", "x"],
    ["@click", "x"],
    [":prop", "x"],
    ["a.b", "x"],
    ["[x]", "x"],
    ["UPPER", "x"],
    ["a`b", "x"],
    ["a&b", "x"],
  ])("writes %j as is (not something HTML ends a name at)", async (name, value) => {
    expect(await attrs({ [name]: value })).toBe(` ${name}="${value}"`);
  });

  it("checks names even when the value is true", async () => {
    await expect(attrs({ "a b": true })).rejects.toThrow("Invalid attribute name");
  });

  it("writes nothing (and doesn't check) for omitted values", async () => {
    expect(await attrs({ "a b": false, "c d": null, "e f": undefined })).toBe("");
  });

  it("a string on* attribute is written as is, escaped", async () => {
    expect(await attrs({ onclick: "go('<x>')" })).toBe(' onclick="go(&#39;&lt;x&gt;&#39;)"');
  });

  it.each(["onClick", "onclick", "on", "onx"])("drops a %s function outside <Local>", async (name) => {
    expect(await attrs({ [name]: () => 1, id: "i" })).toBe(' id="i"');
  });

  it("a function under a name that only looks like a handler is refused", async () => {
    await expect(attrs({ ONCLICK: () => 1 })).rejects.toThrow("Attribute ONCLICK got a function");
    await expect(attrs({ "data-on": () => 1 })).rejects.toThrow("Attribute data-on got a function");
  });
});

describe("class and className", () => {
  it.each<[string, unknown, string]>([
    ["string", "a b", ' class="a b"'],
    ["empty string", "", ""],
    ["false", false, ""],
    ["null", null, ""],
    ["array", ["a", "b"], ' class="a b"'],
    ["array with falsy items", ["a", null, undefined, false, "", "b"], ' class="a b"'],
    ["nested arrays", ["a", ["b", ["c", [[["d"]]]]]], ' class="a b c d"'],
    ["empty array", [], ""],
    ["array of empties", [[], [null], [[false]]], ""],
    ["object", { a: true, b: false, c: 1, d: 0, e: "", f: "yes", g: null }, ' class="a c f"'],
    ["empty object", {}, ""],
    ["object in array", ["x", { y: true, z: false }], ' class="x y"'],
    ["array in object position", [{ a: true }, [{ b: true }]], ' class="a b"'],
    ["escaped", ['a"b', "<c>", { "d&e": true }], ' class="a&quot;b &lt;c&gt; d&amp;e"'],
    ["whitespace kept", "  a   b  ", ' class="  a   b  "'],
    ["number (ignored)", 5, ""],
  ])("%s", async (_, value, written) => {
    expect(await attrs({ class: value })).toBe(written);
    expect(await attrs({ className: value })).toBe(written);
  });

  it.each<[Record<string, unknown>, string]>([
    [{ class: "a", className: "b" }, ' class="a b"'],
    [{ className: "b", class: "a" }, ' class="b a"'],
    [{ class: "a", className: ["b", { c: true }] }, ' class="a b c"'],
    [{ class: false, className: "b" }, ' class="b"'],
    [{ class: "a", className: false }, ' class="a"'],
    [{ class: "", className: "b" }, ' class="b"'],
    [{ class: null, className: null }, ""],
    [{ class: [], className: {} }, ""],
    [{ id: "i", class: "a", title: "t", className: "b" }, ' id="i" class="a b" title="t"'],
  ])("merges %j into one attribute", async (props, written) => {
    expect(await attrs(props)).toBe(written);
  });

  it("raw() in a class is its text (it rendered as class=\"html\")", async () => {
    // The JSX types don't take raw() here; a spread or plain jsx() call can.
    expect(await renderToString(<b class={raw("a b") as never} />)).toBe('<b class="a b"></b>');
    expect(await renderToString(<b class={["x", raw("y")] as never} />)).toBe('<b class="x y"></b>');
    expect(await renderToString(<b class="x" className={raw("y") as never} />)).toBe('<b class="x y"></b>');
  });
});

describe("style", () => {
  it.each<[string, unknown, string]>([
    ["string as given", "color: red; --x: 1", ' style="color: red; --x: 1"'],
    ["string escaped", 'a:"b"', ' style="a:&quot;b&quot;"'],
    ["empty object", {}, ""],
    ["empty string", "", ""],
    ["camelCase", { marginTop: "1px", borderTopLeftRadius: "2px" }, ' style="margin-top:1px;border-top-left-radius:2px"'],
    ["kebab-case", { "margin-top": "1px" }, ' style="margin-top:1px"'],
    ["custom property", { "--gap": "1rem", "--Mixed_case-1": "2" }, ' style="--gap:1rem;--Mixed_case-1:2"'],
    ["numbers without units", { opacity: 0, zIndex: 10, width: 1.5 }, ' style="opacity:0;z-index:10;width:1.5"'],
    ["vendor prefixes", { WebkitTransform: "none", MozAppearance: "none", msTransform: "none" }, ' style="-webkit-transform:none;-moz-appearance:none;-ms-transform:none"'],
    ["already prefixed", { "-webkit-box-flex": "1" }, ' style="-webkit-box-flex:1"'],
    ["skips empties", { a: null, b: undefined, c: false, d: "", e: 0 }, ' style="e:0"'],
    ["all empty", { a: null, b: "" }, ""],
    ["true", { color: true }, ' style="color:true"'],
    ["escapes quotes and ampersands", { fontFamily: '"A&B", serif' }, ' style="font-family:&quot;A&amp;B&quot;, serif"'],
    ["keeps url() and >", { background: "url(/a.png)", content: "'>'" }, ' style="background:url(/a.png);content:&#39;&gt;&#39;"'],
    ["!important", { color: "red !important" }, ' style="color:red !important"'],
    ["raw", raw("a:b;c:d"), ' style="a:b;c:d"'],
    ["null", null, ""],
  ])("%s", async (_, value, written) => {
    expect(await attrs({ style: value })).toBe(written);
  });

  it.each([
    [{ color: "red;background:url(x)" }, 'Invalid value for style color: "red;background:url(x)"'],
    [{ color: "red}" }, "Invalid value for style color"],
    [{ color: "{" }, "Invalid value for style color"],
    [{ color: "</style><script>" }, "Invalid value for style color"],
    [{ "--x": "a;b" }, "Invalid value for style --x"],
  ])("refuses values that could end the declaration: %j", async (value, message) => {
    await expect(attrs({ style: value })).rejects.toThrow(message);
  });

  it.each(["co lor", "color:", "a;b", "1px", "--", "--a b", "-", "a_b", '"x"', "é"])("refuses property name %j", async (name) => {
    await expect(attrs({ style: { [name]: "1" } })).rejects.toThrow(`Invalid style property: ${JSON.stringify(name)}`);
  });

  it("refuses a bad name even after the same name was fine elsewhere (no cache confusion)", async () => {
    expect(await attrs({ style: { fontSize: "1px" } })).toBe(' style="font-size:1px"');
    await expect(attrs({ style: { "font size": "1px" } })).rejects.toThrow("Invalid style property");
    expect(await attrs({ style: { fontSize: "2px" } })).toBe(' style="font-size:2px"');
  });

  it("a number or boolean style is nothing", async () => {
    expect(await attrs({ style: 5 })).toBe("");
    expect(await attrs({ style: true })).toBe("");
  });
});

describe("URL attributes", () => {
  const blocked = "about:blank#blocked";
  it.each<[string, string, string]>([
    ["href", "javascript:alert(1)", blocked],
    ["href", "JAVASCRIPT:alert(1)", blocked],
    ["href", " \t\njavascript:alert(1)", blocked],
    ["href", "java\tscript:alert(1)", blocked],
    ["href", "java\nscript:alert(1)", blocked],
    ["href", "java\u0000script:alert(1)", blocked],
    ["href", "\u0001javascript:alert(1)", blocked],
    ["href", "vbscript:msgbox(1)", blocked],
    ["href", "data:text/html,<script>", blocked],
    ["href", "data:image/png;base64,AA", blocked],
    ["src", "data:image/png;base64,AA", "data:image/png;base64,AA"],
    ["src", "DATA:IMAGE/png;base64,AA", "DATA:IMAGE/png;base64,AA"],
    ["src", "data: image/png,x", "data: image/png,x"],
    ["poster", "data:image/gif,x", "data:image/gif,x"],
    ["src", "data:text/html,x", blocked],
    ["src", "data:image/svg+xml,<svg onload=alert(1)>", "data:image/svg+xml,&lt;svg onload=alert(1)&gt;"],
    ["action", "javascript:x", blocked],
    ["formaction", "javascript:x", blocked],
    ["formAction", "javascript:x", blocked],
    ["xlink:href", "javascript:x", blocked],
    ["ping", "javascript:x", blocked],
    ["cite", "javascript:x", blocked],
    ["background", "javascript:x", blocked],
    ["data", "javascript:x", blocked],
    ["href", "/javascript:x", "/javascript:x"],
    ["href", "./javascript:x", "./javascript:x"],
    ["href", "#javascript:x", "#javascript:x"],
    ["href", "?javascript:x", "?javascript:x"],
    ["href", "https://example.com/?u=javascript:x", "https://example.com/?u=javascript:x"],
    ["href", "mailto:a@b.c", "mailto:a@b.c"],
    ["href", "tel:+1", "tel:+1"],
    ["href", "javascript", "javascript"],
    ["href", "", ""],
    ["href", "a&b", "a&amp;b"],
    ["title", "javascript:x", "javascript:x"],
    ["data-href", "javascript:x", "javascript:x"],
  ])("%s=%j", async (name, url, written) => {
    expect(await attrs({ [name]: url })).toBe(` ${name}="${written}"`);
  });

  it("checks URL objects too", async () => {
    expect(await attrs({ href: new URL("javascript:alert(1)") })).toBe(` href="${blocked}"`);
    expect(await attrs({ href: new URL("https://example.com/") })).toBe(' href="https://example.com/"');
  });

  it("raw() opts out", async () => {
    expect(await attrs({ href: raw("javascript:void 0") })).toBe(' href="javascript:void 0"');
  });

  // The names are matched exactly, as written in JSX.
  it("leaves other spellings alone", async () => {
    expect(await attrs({ HREF: "javascript:x" })).toBe(' HREF="javascript:x"');
  });
});

describe("key", () => {
  it.each<[unknown, string]>([
    ["k", ' data-key="k"'],
    [0, ' data-key="0"'],
    ["", ' data-key=""'],
    ['"><x', ' data-key="&quot;&gt;&lt;x"'],
  ])("%j", async (key, written) => {
    expect(await renderToString(jsx("li", {}, key as string))).toBe(`<li${written}></li>`);
  });

  it("an explicit data-key wins", async () => {
    expect(await renderToString(jsx("li", { "data-key": "mine" }, "k"))).toBe('<li data-key="mine"></li>');
  });

  // null writes nothing, so it can't stand in for the key (the key was lost).
  it("a null data-key doesn't count as explicit", async () => {
    expect(await renderToString(jsx("li", { "data-key": null }, "k"))).toBe('<li data-key="k"></li>');
  });

  // createElement (a key after a spread) takes the key from props, where it can be null.
  it("a null key is no key (it rendered data-key=\"null\")", async () => {
    expect(await renderToString(createElement("li", { key: null }))).toBe("<li></li>");
  });

  it("goes after the other attributes", async () => {
    expect(await renderToString(jsx("li", { id: "a", class: "b" }, "k"))).toBe('<li id="a" class="b" data-key="k"></li>');
  });

  it("is dropped on components and fragments", async () => {
    const C = () => <i />;
    expect(await renderToString(createElement(C, { key: "k" }))).toBe("<i></i>");
    expect(await renderToString(<>{[<i key="a" />]}</>)).toBe('<i data-key="a"></i>');
  });

  it("a void element gets it too", async () => {
    expect(await renderToString(jsx("br", {}, 1))).toBe('<br data-key="1">');
  });
});

describe("dropTo", () => {
  it("becomes data-yx-drop-to, escaped", async () => {
    expect(await attrs({ dropTo: '#a"b' }, "div")).toBe(' data-yx-drop-to="#a&quot;b"');
  });
});
