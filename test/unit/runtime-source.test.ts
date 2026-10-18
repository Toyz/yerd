import { describe, expect, it, vi } from "vitest";

// As in a built package: scripts/minify-runtime.ts filled runtime-min.js in.
vi.mock("../../src/client/runtime-min.js", () => ({ minified: "(function(){/* minified */})();" }));

const { runtimeSource } = await import("../../src/client/runtime.js");

describe("runtimeSource()", () => {
  it("serves the minified build when there is one", () => {
    expect(runtimeSource()).toBe("(function(){/* minified */})();");
  });
});
