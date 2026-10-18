// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runtimeSource } from "../../src/client/runtime.js";
import type { YerdClient } from "../../src/attributes/attribute.js";

beforeAll(() => {
  document.body.innerHTML = `<style data-yx-css="yx-a">.yx-a{color:red}</style><div class="yx-a">first</div>`;
  new Function(runtimeSource())();
});

afterEach(() => vi.restoreAllMocks());

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const inHead = () => Array.from(document.head.querySelectorAll("style[data-yx-css]"), (s) => s.getAttribute("data-yx-css"));
const inBody = () => document.body.querySelectorAll("style[data-yx-css]").length;

describe("css styles in the runtime", () => {
  it("moves styles that came with the page into <head> on start", () => {
    expect(inHead()).toEqual(["yx-a"]);
    expect(inBody()).toBe(0);
    expect(document.querySelector(".yx-a")!.textContent).toBe("first");
  });

  it("keeps one per class when a response repeats them, and adds new ones", async () => {
    document.body.innerHTML = `<div id="list" data-yx-region></div>`;
    (window as unknown as { yerd: YerdClient }).yerd.page.apply(
      `<div id="list" data-yx-region><style data-yx-css="yx-a">.yx-a{color:red}</style><style data-yx-css="yx-b">.yx-b{color:blue}</style><p class="yx-a yx-b">x</p></div>`,
    );
    await flush();
    expect(inHead()).toEqual(["yx-a", "yx-b"]);
    expect(inBody()).toBe(0);
    expect(document.querySelector("#list p")!.className).toBe("yx-a yx-b");
  });

  it("does the same after a boosted page load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `<html><head><title>t</title></head><body><style data-yx-css="yx-b">.yx-b{color:blue}</style><style data-yx-css="yx-c">.yx-c{}</style><main class="yx-c">next</main></body></html>`,
      { headers: { "content-type": "text/html" } },
    )));
    await (window as unknown as { yerd: YerdClient }).yerd.page.load("/next", true);
    await flush();
    expect(inHead()).toEqual(["yx-a", "yx-b", "yx-c"]);
    expect(inBody()).toBe(0);
    vi.unstubAllGlobals();
  });
});
