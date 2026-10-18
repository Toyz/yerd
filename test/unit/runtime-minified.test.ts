// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runtimePieces, runtimeSource } from "../../src/client/runtime.js";
import { minifyPieces, minifyRuntime } from "../../scripts/minify-runtime.js";
import type { YerdClient as Yerd } from "../../src/attributes/attribute.js";

// What `npm run build` ships: the same runtime, minified at build time.
let minified: string;
let yerd: Yerd;

beforeAll(async () => {
  minified = await minifyRuntime(runtimeSource());
  new Function(minified)();
  yerd = (window as unknown as { yerd: Yerd }).yerd;
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("the minified runtime", () => {
  it("is smaller than the source, with its comments and indentation gone", () => {
    expect(minified.length).toBeLessThan(runtimeSource().length * 0.75);
    expect(minified).not.toContain("\n  ");
    expect(minified).not.toContain("Every navigation bumps");
  });

  it("keeps the public API", () => {
    expect(Object.keys(yerd).sort()).toEqual(["attribute", "clock", "net", "page"]);
    expect(Object.keys(yerd.page).sort()).toEqual(["apply", "load", "morph", "refresh"]);
    expect(Object.keys(yerd.net).sort()).toEqual(["fetch", "prefetch"]);
    expect(Object.keys(yerd.clock).sort()).toEqual(["now", "sync"]);
  });

  it("morphs Regions in", () => {
    document.body.innerHTML = '<ul id="r" data-yx-region><li data-key="a">a</li></ul>';
    const a = document.querySelector("li")!;
    expect(yerd.page.apply('<ul id="r" data-yx-region><li data-key="b">b</li><li data-key="a">a!</li></ul>')).toBe(1);
    expect(Array.from(document.querySelectorAll("li"), (li) => li.textContent)).toEqual(["b", "a!"]);
    expect(document.querySelectorAll("li")[1]).toBe(a);
  });

  it("submits an action form and applies the response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('<p id="out" data-yx-region>done</p>', { headers: { "content-type": "text/html" } })));
    document.body.innerHTML = '<form data-yx action="/do" method="post"><button>go</button></form><p id="out" data-yx-region>waiting</p>';
    document.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(document.getElementById("out")!.textContent).toBe("done");
  });

  it("runs custom attributes and <Local> handlers", async () => {
    yerd.attribute("x-shout", (el, value) => void (el.textContent = value.toUpperCase()));
    document.body.innerHTML = `<b x-shout="hi"></b><yerd-local data-yx-local='{"n":0}' data-yx-as="s"><button data-yx-on-click="() => s.n++">+</button><i data-yx-text="n">0</i></yerd-local>`;
    document.dispatchEvent(new CustomEvent("yx:applied", { detail: { regions: 0 } }));
    await flush();
    expect(document.querySelector("b")!.textContent).toBe("HI");
    document.querySelector("button")!.click();
    expect(document.querySelector("i")!.textContent).toBe("1");
  });

  it("minifies the core and each chunk on its own, each still one self-contained function", async () => {
    const pieces = runtimePieces();
    const small = await minifyPieces(pieces);
    expect(Object.keys(small.chunks).sort()).toEqual(["cues", "dnd", "lazy", "local"]);
    for (const [name, fn] of [["core", small.core], ...Object.entries(small.chunks)] as Array<[string, string]>) {
      expect(fn, name).toMatch(/^(async )?function\b/);
      expect(typeof new Function(`return (${fn});`)(), name).toBe("function");
    }
    expect(small.core.length).toBeLessThan(pieces.core.length * 0.75);
    // What the import() and the chunk modules hang on survives minifying.
    expect(small.core).toContain("runtime-");
    expect(small.chunks.local).toContain("yerd-local");
  });
});
