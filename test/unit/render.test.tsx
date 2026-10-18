import { describe, expect, it } from "vitest";
import { raw, renderToStream, renderToString, type Child } from "@toyz/yerd";

describe("renderToString", () => {
  it("renders elements, attributes and text", async () => {
    expect(await renderToString(<a href="/x" title="hi">go</a>)).toBe('<a href="/x" title="hi">go</a>');
  });

  it("escapes text and attribute values", async () => {
    const evil = `<script>alert("x")</script>&'`;
    expect(await renderToString(<p title={evil}>{evil}</p>)).toBe(
      `<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;</p>`,
    );
  });

  it("writes raw() without escaping", async () => {
    expect(await renderToString(<div>{raw("<b>bold</b>")}</div>)).toBe("<div><b>bold</b></div>");
  });

  it("handles boolean, null and false attributes", async () => {
    expect(await renderToString(<input disabled={true} hidden={false} value={null} />)).toBe("<input disabled>");
  });

  it("never closes void elements", async () => {
    expect(await renderToString(<div><br /><img src="a.png" /></div>)).toBe('<div><br><img src="a.png"></div>');
  });

  it("builds class from strings, arrays and objects", async () => {
    expect(await renderToString(<div class={["a", { b: true, c: false }, null]} />)).toBe('<div class="a b"></div>');
  });

  it("builds style from an object", async () => {
    expect(await renderToString(<div style={{ backgroundColor: "red", "--gap": "2px", margin: null }} />)).toBe(
      '<div style="background-color:red;--gap:2px"></div>',
    );
  });

  it("skips nullish and boolean children, renders numbers and arrays", async () => {
    expect(await renderToString(<ul>{[1, 2].map((n) => <li>{n}</li>)}{null}{false}{true}</ul>)).toBe(
      "<ul><li>1</li><li>2</li></ul>",
    );
  });

  it("renders fragments and function components", async () => {
    const Item = ({ label }: { label: string }) => <li>{label}</li>;
    expect(await renderToString(<><Item label="a" /><Item label="b" /></>)).toBe("<li>a</li><li>b</li>");
  });

  it("awaits async components and promise children", async () => {
    const Slow = async ({ n }: { n: number }) => {
      await new Promise((r) => setTimeout(r, 5));
      return <b>{n}</b>;
    };
    expect(await renderToString(<p><Slow n={1} />{Promise.resolve("x")}</p>)).toBe("<p><b>1</b>x</p>");
  });

  it("adds a doctype only for documents rooted at <html>", async () => {
    expect(await renderToString(<html><body /></html>, { document: true })).toBe("<!doctype html><html><body></body></html>");
    expect(await renderToString(<div />, { document: true })).toBe("<div></div>");
  });

  it("drops event handler props on the server", async () => {
    expect(await renderToString(<button onClick={() => 1}>x</button>)).toBe("<button>x</button>");
  });

  it("rejects attribute names that could break out of the tag", async () => {
    const props = { 'x"><script>': "1" } as Record<string, string>;
    await expect(renderToString(<div {...props} />)).rejects.toThrow(/Invalid attribute name/);
  });

  it("rejects children on void elements", async () => {
    // @ts-expect-error void elements are typed to reject children; this checks the runtime guard too
    await expect(renderToString(<br>{"x" as Child}</br>)).rejects.toThrow(/void element/);
  });

  it("flushes the buffer before waiting on an async component", async () => {
    const Slow = async () => {
      await new Promise((r) => setTimeout(r, 5));
      return <i>late</i>;
    };
    const chunks: string[] = [];
    for await (const chunk of renderToStream(<main><h1>top</h1><Slow /></main>)) chunks.push(chunk);
    expect(chunks).toEqual(["<main><h1>top</h1>", "<i>late</i></main>"]);
  });
});
