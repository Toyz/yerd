import { describe, expect, it, vi } from "vitest";

// As in a built package: scripts/minify-runtime.ts filled runtime-min.js in.
vi.mock("../../src/client/runtime-min.js", () => ({
  minified: { core: "function(){/* core */}", chunks: { cues: "function(){/* cues */}", dnd: "function(){/* dnd */}", local: "function(){/* local */}", lazy: "function(){/* lazy */}" } },
}));

const { chunkSource, chunkVersion, runtimeSource } = await import("../../src/client/runtime.js");

describe("runtimeSource()", () => {
  it("serves the minified build when there is one", () => {
    const versions = JSON.stringify({ cues: chunkVersion("cues"), dnd: chunkVersion("dnd"), local: chunkVersion("local"), lazy: chunkVersion("lazy") });
    expect(runtimeSource({ chunks: "split" })).toBe(`(function(){/* core */})(new URL(".", import.meta.url).href, undefined, (url) => import(url), ${versions});\n`);
    expect(chunkSource("dnd")).toBe("export default function(){/* dnd */};\n");
  });

  it("inlines the minified chunks into the one-script bundle", () => {
    expect(runtimeSource()).toBe(
      '(function(){/* core */})("", { cues: function(){/* cues */}, dnd: function(){/* dnd */}, local: function(){/* local */}, lazy: function(){/* lazy */} });\n',
    );
  });

  it("has no chunk by any other name", () => {
    expect(chunkSource("nope")).toBeUndefined();
    expect(chunkSource("toString")).toBeUndefined();
    expect(chunkSource("__proto__")).toBeUndefined();
  });
});
