import { describe, expect, it } from "vitest";
import { createElement, json, raw, renderToString } from "@toyz/yerd";

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
