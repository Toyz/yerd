import { afterEach, describe, expect, it } from "vitest";
import { Stylesheet, assetUrl, renderToString, resetManifest } from "@toyz/yerd";

afterEach(() => resetManifest());

describe("Stylesheet", () => {
  // Only double quotes were escaped, so an & in a path could form a character
  // reference the browser decodes ("&quot;" turned into a quote in the URL).
  it.each([
    ["src/a.css", "/src/a.css"],
    ["./src/a.css", "/src/a.css"],
    ["/src/a.css", "/src/a.css"],
    ["src/a&b.css", "/src/a&amp;b.css"],
    ["src/a&quot;b.css", "/src/a&amp;quot;b.css"],
    ['src/a"b.css', "/src/a&quot;b.css"],
    ["src/<x>.css", "/src/&lt;x&gt;.css"],
    ["src/it's.css", "/src/it&#39;s.css"],
  ])("%s", async (href, written) => {
    expect(await renderToString(<Stylesheet href={href} />)).toBe(`<link rel="stylesheet" href="${written}">`);
  });
});

describe("assetUrl without a manifest", () => {
  it.each([
    ["src/x.js", "/src/x.js"],
    ["./src/x.js", "/src/x.js"],
    ["/src/x.js", "/src/x.js"],
    ["favicon.svg", "/favicon.svg"],
  ])("%s -> %s", (path, url) => {
    expect(assetUrl(path)).toBe(url);
  });

  it("is escaped when used as an attribute", async () => {
    expect(await renderToString(<link rel="icon" href={assetUrl('a"b.svg')} />)).toBe('<link rel="icon" href="/a&quot;b.svg">');
  });
});
