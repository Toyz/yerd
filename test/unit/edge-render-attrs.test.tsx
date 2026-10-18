import { describe, expect, it } from "vitest";
import { raw, renderToString } from "@toyz/yerd";

describe("class", () => {
  it("raw() in a class is its text (it rendered as class=\"html\")", async () => {
    expect(await renderToString(<b class={raw("a b")} />)).toBe('<b class="a b"></b>');
    expect(await renderToString(<b class={["x", raw("y")]} />)).toBe('<b class="x y"></b>');
    expect(await renderToString(<b class="x" className={raw("y")} />)).toBe('<b class="x y"></b>');
  });
});
