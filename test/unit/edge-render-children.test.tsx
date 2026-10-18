import { describe, expect, it } from "vitest";
import { Fragment, createElement, json, raw, renderToString, type Child } from "@toyz/yerd";
import { jsx } from "@toyz/yerd/jsx-runtime";

const VOID = ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"];
const later = <T,>(value: T, ms = 1) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe("void elements", () => {
  it.each(VOID)("<%s> has no end tag", async (tag) => {
    expect(await renderToString(jsx(tag, { id: "x" }))).toBe(`<${tag} id="x">`);
  });

  it.each<[string, unknown]>([
    ["undefined", undefined],
    ["null", null],
    ["false", false],
    ["true", true],
    ["empty string", ""],
    ["empty array", []],
    ["array of empties", [null, false, "", [undefined, [true]]]],
  ])("takes %s as children", async (_, children) => {
    expect(await renderToString(jsx("br", { children }))).toBe("<br>");
  });

  it.each<[string, unknown]>([
    ["text", "x"],
    ["a space", " "],
    ["zero", 0],
    ["an element", <i />],
    ["text in an array", [null, "x"]],
    ["raw()", raw("")],
    ["a promise", Promise.resolve(null)],
  ])("refuses %s as children", async (_, children) => {
    await expect(renderToString(jsx("img", { children }))).rejects.toThrow("<img> is a void element and cannot have children");
  });

  it("void-ness goes by the exact tag (an unknown or custom tag gets an end tag)", async () => {
    expect(await renderToString(jsx("my-br", {}))).toBe("<my-br></my-br>");
    expect(await renderToString(jsx("brx", {}))).toBe("<brx></brx>");
  });
});

describe("element names", () => {
  it.each(["div", "h1", "my-element", "x-1-2", "svg", "foreignObject", "A"])("takes %s", async (tag) => {
    expect(await renderToString(jsx(tag, {}))).toBe(`<${tag}></${tag}>`);
  });

  it.each(["", "1a", "-a", "a b", "a>b", "a/b", 'a"b', "a_b", "a.b", "a:b", "é", "a\u0000", "<a"])("refuses %j", async (tag) => {
    await expect(renderToString(jsx(tag, {}))).rejects.toThrow(`Invalid element name: ${JSON.stringify(tag)}`);
  });

  it("refuses the same bad name again (the check is cached only for good names)", async () => {
    await expect(renderToString(jsx("a b", {}))).rejects.toThrow("Invalid element name");
    await expect(renderToString(jsx("a b", {}))).rejects.toThrow("Invalid element name");
  });
});

describe("<script> and <style> text", () => {
  it.each<[string, Child, string]>([
    ["text", "a < b && c > d", "a < b && c > d"],
    ["quotes and entities", `"x" 'y' &amp;`, `"x" 'y' &amp;`],
    ["numbers", [1, 2n, " ", -0], "12 0"],
    ["nested arrays", ["a", ["b", ["c"]]], "abc"],
    ["skipped values", [null, undefined, true, false, "x"], "x"],
    ["raw()", raw("if (a<b) {}"), "if (a<b) {}"],
    ["json()", json({ a: "</script>" }), '{"a":"\\u003c/script\\u003e"}'],
    ["</style in a script", "'</style>'", "'</style>'"],
    ["U+2028", "'\u2028'", "'\u2028'"],
    ["nothing", null, ""],
  ])("script: %s", async (_, children, text) => {
    expect(await renderToString(jsx("script", { children }))).toBe(`<script>${text}</script>`);
  });

  it.each([
    "</script>",
    "</script",
    "</SCRIPT>",
    "</ScRiPt>",
    "</script >",
    "</script/>",
    "</script\n>",
    "x</scriptx",
    "<!--",
    "a<!--b",
  ])("script refuses %j", async (text) => {
    await expect(renderToString(jsx("script", { children: text }))).rejects.toThrow(
      "<script> text can't contain </script or <!--; for data, use json()",
    );
  });

  it.each<[string, Child]>([
    ["split over strings", ["</scr", "ipt>"]],
    ["split over a string and raw()", ["<!-", raw("-")]],
    ["split over nested arrays", [["<"], [["/script"]]]],
    ["in raw()", raw("</script>")],
  ])("script refuses it %s", async (_, children) => {
    await expect(renderToString(jsx("script", { children }))).rejects.toThrow("can't contain </script");
  });

  it.each([
    ["</style>", true],
    ["</STYLE", true],
    ["a</style", true],
    ["<!-- fine in css -->", false],
    ["</script>", false],
    ["a > b", false],
  ])("style %j refused: %s", async (text, refused) => {
    const render = renderToString(jsx("style", { children: text }));
    if (refused) await expect(render).rejects.toThrow("<style> text can't contain </style; for data, use json()");
    else expect(await render).toBe(`<style>${text}</style>`);
  });

  it.each<[string, unknown]>([
    ["an element", <b />],
    ["a promise", Promise.resolve("x")],
    ["an object", { a: 1 }],
    ["a function", () => "x"],
    ["a Set", new Set(["x"])],
  ])("refuses %s as script text", async (_, children) => {
    await expect(renderToString(jsx("script", { children }))).rejects.toThrow(
      "<script> children must be text (strings, numbers, raw() or json())",
    );
  });

  // jsx("SCRIPT") / jsx("IMG") (not reachable from typed TSX) aren't treated as
  // raw text or void: tag checks are case-sensitive. Escaped text can't break
  // out, so it's a correctness question, not a hole.
  it.todo("upper-case raw text and void tag names");

  it("keeps attributes", async () => {
    expect(await renderToString(<script type="module" src="/a.js" async />)).toBe('<script type="module" src="/a.js" async></script>');
    expect(await renderToString(<style media="print">{"p{}"}</style>)).toBe('<style media="print">p{}</style>');
  });

  // Other raw text and RCDATA elements get ordinary escaped text: it can't
  // contain a "<", so it can't end them early.
  it.each(["textarea", "title", "noscript", "iframe", "xmp", "noembed", "noframes"])("<%s> text is escaped", async (tag) => {
    expect(await renderToString(jsx(tag, { children: `</${tag}><script>x</script>` }))).toBe(
      `<${tag}>&lt;/${tag}&gt;&lt;script&gt;x&lt;/script&gt;</${tag}>`,
    );
  });
});

describe("fragments, arrays and iterables", () => {
  it.each<[string, Child, string]>([
    ["empty fragment", <></>, ""],
    ["nested fragments", <><><>a</></><>b</></>, "ab"],
    ["Fragment with a key", createElement(Fragment, { key: "k" }, "a"), "a"],
    ["empty array", [], ""],
    ["deep arrays", [[[["a"]]], [[["b"]]]], "ab"],
    ["holes", [null, undefined, false, true, "", "x"], "x"],
    ["Set", new Set(["a", "b"]), "ab"],
    ["Map (entries)", new Map([["k", "v"]]), "kv"],
    ["generator", (function* () { yield "a"; yield <i>b</i>; })(), "a<i>b</i>"],
    ["array iterator", ["a", "b"].values(), "ab"],
    ["mixed", ["a", 1, <b>2</b>, raw("<i>3</i>"), [new Set([4])]], "a1<b>2</b><i>3</i>4"],
  ])("%s", async (_, child, html) => {
    expect(await renderToString(child)).toBe(html);
  });

  it("a string is text, not an iterable of characters", async () => {
    expect(await renderToString(["ab", "<"])).toBe("ab&lt;");
  });

  it("a generator is consumed once", async () => {
    let runs = 0;
    const gen = (function* () { runs++; yield "x"; })();
    expect(await renderToString(<p>{gen}</p>)).toBe("<p>x</p>");
    expect(runs).toBe(1);
  });

  it("an async generator is refused", async () => {
    const gen = (async function* () { yield "x"; })();
    await expect(renderToString(gen as never)).rejects.toThrow("Cannot render [object AsyncGenerator] as a child");
  });

  it("a generator that throws rejects", async () => {
    const gen = (function* () { yield "a"; throw new Error("gen broke"); })();
    await expect(renderToString(<p>{gen}</p>)).rejects.toThrow("gen broke");
  });
});

describe("components", () => {
  it.each<[string, unknown, string]>([
    ["undefined", undefined, ""],
    ["null", null, ""],
    ["false", false, ""],
    ["true", true, ""],
    ["0", 0, "0"],
    ["NaN", NaN, "NaN"],
    ["empty string", "", ""],
    ["a string", "<x>", "&lt;x&gt;"],
    ["an array", ["a", <i />], "a<i></i>"],
    ["a fragment", <>f</>, "f"],
  ])("returning %s", async (_, value, html) => {
    const C = () => value as Child;
    expect(await renderToString(<p><C /></p>)).toBe(`<p>${html}</p>`);
  });

  it.each<[string, unknown, string]>([
    ["undefined", undefined, ""],
    ["null", null, ""],
    ["0", 0, "0"],
    ["a promise of a promise", Promise.resolve(Promise.resolve("x")), "x"],
    ["an array of promises", [later("a", 5), later("b", 1)], "ab"],
  ])("async, returning %s", async (_, value, html) => {
    const C = (async () => value) as () => Child;
    expect(await renderToString(<p><C /></p>)).toBe(`<p>${html}</p>`);
  });

  it("receives its props and children", async () => {
    const C = (props: { a: string; children?: Child }) => <i data-a={props.a}>{props.children}</i>;
    expect(await renderToString(<C a="1">kid</C>)).toBe('<i data-a="1">kid</i>');
  });

  it("a component returning a component", async () => {
    const Inner = () => <b>in</b>;
    const Outer = () => <Inner />;
    expect(await renderToString(<Outer />)).toBe("<b>in</b>");
  });

  it("a sync throw rejects with the same error", async () => {
    const error = new Error("sync boom");
    const C = () => {
      throw error;
    };
    await expect(renderToString(<div><C /></div>)).rejects.toBe(error);
  });

  it("an async throw rejects with the same error", async () => {
    const error = new Error("async boom");
    const C = async () => {
      await later(null);
      throw error;
    };
    await expect(renderToString(<div><C /></div>)).rejects.toBe(error);
  });

  it("a non-Error throw comes through as is", async () => {
    const C = () => {
      throw "plain";
    };
    await expect(renderToString(<C />)).rejects.toBe("plain");
  });

  it("a rejected promise child rejects", async () => {
    await expect(renderToString(<p>{Promise.reject(new Error("nope"))}</p>)).rejects.toThrow("nope");
  });

  it("a thenable that isn't a Promise is awaited", async () => {
    const thenable: unknown = { then: (resolve: (v: unknown) => void) => resolve(<i>t</i>) };
    expect(await renderToString(<p>{thenable as never}</p>)).toBe("<p><i>t</i></p>");
  });

  it("siblings keep their order whatever finishes first", async () => {
    const Slow = async ({ v, ms }: { v: string; ms: number }) => later(v, ms);
    expect(await renderToString(<ul><Slow v="a" ms={15} />{later("b", 1)}<Slow v="c" ms={5} />d</ul>)).toBe("<ul>abcd</ul>");
  });

  it("deep nesting works well within the stack", async () => {
    let node: Child = "leaf";
    for (let i = 0; i < 1000; i++) node = <i>{node}</i>;
    expect(await renderToString(node)).toBe(`${"<i>".repeat(1000)}leaf${"</i>".repeat(1000)}`);
  });

  it("deep async nesting works", async () => {
    let node: Child = "leaf";
    for (let i = 0; i < 200; i++) {
      const inner = node;
      const A = async () => <b>{inner}</b>;
      node = <A />;
    }
    expect(await renderToString(node)).toBe(`${"<b>".repeat(200)}leaf${"</b>".repeat(200)}`);
  });

  it("a component rendering itself without end gets the explained overflow", async () => {
    const Loop = (): Child => <i><Loop /></i>;
    await expect(renderToString(<Loop />)).rejects.toThrow("Rendering overflowed the call stack");
  });
});

describe("document", () => {
  it.each<[string, Child, string]>([
    ["html first", <html><body /></html>, "<!doctype html><html><body></body></html>"],
    ["html in a fragment", <><html /></>, "<!doctype html><html></html>"],
    ["html from a component", createElement(() => <html />, null), "<!doctype html><html></html>"],
    ["upper-case HTML", jsx("HTML", {}), "<!doctype html><HTML></HTML>"],
    ["another element first", <div><html /></div>, "<div><html></html></div>"],
    ["a later html", [<p />, <html />], "<p></p><html></html>"],
  ])("%s", async (_, node, html) => {
    expect(await renderToString(node, { document: true })).toBe(html);
  });

  it("only with the option", async () => {
    expect(await renderToString(<html />)).toBe("<html></html>");
  });

  it("an async html root still gets it", async () => {
    const Page = async () => <html><body>x</body></html>;
    expect(await renderToString(<Page />, { document: true })).toBe("<!doctype html><html><body>x</body></html>");
  });
});
