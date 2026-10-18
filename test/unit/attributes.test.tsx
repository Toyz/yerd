import { describe, expect, it } from "vitest";
import { attribute, renderToString } from "@toyz/yerd";
import { attributesSource } from "../../src/attributes/attribute.js";

declare module "@toyz/yerd" {
  interface CustomAttributes {
    tooltip?: string;
    "test-config"?: { a: number };
  }
}

attribute<string>("tooltip", {
  render: (text) => ({ tooltip: text, "aria-label": text }),
  client(el, value) {
    el.title = value;
    return () => {
      el.title = "";
    };
  },
});
attribute("test-config", {});

describe("custom attributes on the server", () => {
  it("render through their own render function", async () => {
    expect(await renderToString(<button tooltip="Delete">x</button>)).toBe('<button tooltip="Delete" aria-label="Delete">x</button>');
  });

  it("write objects as JSON when there's no render", async () => {
    expect(await renderToString(<div test-config={{ a: 1 }} />)).toBe('<div test-config="{&quot;a&quot;:1}"></div>');
  });

  it("ship the client half as text, method shorthand included", () => {
    const source = attributesSource();
    expect(source).toContain('yerd.attribute("tooltip", ({ client(el, value)');
    expect(source).not.toContain("test-config");
    // It evaluates on its own: the shorthand is a valid expression.
    const calls: string[] = [];
    new Function("window", source)({ yerd: { attribute: (name: string) => calls.push(name) } });
    expect(calls).toEqual(["tooltip"]);
  });

  it("refuse bad or duplicate names, and built-in ones", () => {
    expect(() => attribute("Bad Name", {})).toThrow(/lowercase/);
    expect(() => attribute("tooltip", {})).toThrow(/twice/);
    expect(() => attribute("prefetch", {})).toThrow(/built-in/);
  });
});

describe("prefetch", () => {
  it("renders the mode for links, defaulting to intent", async () => {
    expect(await renderToString(<a href="/todos" prefetch>t</a>)).toBe('<a href="/todos" data-yx-prefetch="intent">t</a>');
    expect(await renderToString(<a href="/r" prefetch="visible">r</a>)).toBe('<a href="/r" data-yx-prefetch="visible">r</a>');
    expect(await renderToString(<a href="/r" prefetch={false}>r</a>)).toBe('<a href="/r">r</a>');
  });

  it("takes a URL on any element, as a page or JSON", async () => {
    expect(await renderToString(<section prefetch={{ url: "/api/stats", as: "json", on: "load" }} />)).toBe(
      '<section data-yx-prefetch="load" data-yx-prefetch-url="/api/stats" data-yx-prefetch-as="json"></section>',
    );
  });

  it("refuses an element with nothing to prefetch, or an unknown mode", async () => {
    await expect(renderToString(<div prefetch />)).rejects.toThrow(/needs an href/);
    // @ts-expect-error not a mode
    await expect(renderToString(<a href="/" prefetch="soon">x</a>)).rejects.toThrow(/isn't a mode/);
  });
});
