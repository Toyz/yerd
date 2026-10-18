// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runtimeSource } from "../../src/client/runtime.js";
import { Dynamic, Region, css, renderToString } from "@toyz/yerd";
import { jsx } from "@toyz/yerd/jsx-runtime";

interface Yerd {
  apply(html: string): number;
  load(url: string, push: boolean): Promise<void>;
}

let yerd: Yerd;

const style = (name: string, text = `.${name}{--n:${name}}`) => `<style data-yx-css="${name}">${text}</style>`;

beforeAll(() => {
  document.head.innerHTML = `<title>start</title>${style("global", ":root{--g:1}")}`;
  document.body.innerHTML = [
    style("yx-a"),
    `<div class="yx-a">a</div>`,
    `<section>`,
    `<div><div><div>${style("yx-deep")}<p class="yx-deep">deep</p></div></div></div>`,
    `</section>`,
    // A repeat of one already sent (two renders' output side by side) and one <Styles /> put in <body>.
    style("yx-a"),
    style("global", ":root{--g:1}"),
    `<template>${style("yx-in-template")}<p class="yx-in-template"></p></template>`,
  ].join("");
  new Function(runtimeSource())();
  yerd = (window as unknown as { yerd: Yerd }).yerd;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const inHead = () => Array.from(document.head.querySelectorAll("style[data-yx-css]"), (s) => s.getAttribute("data-yx-css")!);
const inBody = () => document.body.querySelectorAll("style[data-yx-css]").length;
const unique = (names: string[]) => new Set(names).size === names.length;

function page(body: string, head = ""): Response {
  return new Response(`<!doctype html><html><head><title>p</title>${head}</head><body>${body}</body></html>`, {
    headers: { "content-type": "text/html" },
  });
}

describe("on start", () => {
  it("moves the page's styles into <head>, after what's there, in page order", () => {
    expect(inHead()).toEqual(["global", "yx-a", "yx-deep"]);
  });

  it("drops repeats, including one of a name <head> already had", () => {
    expect(inBody()).toBe(0);
    expect(unique(inHead())).toBe(true);
  });

  it("leaves the elements alone", () => {
    expect(document.querySelector(".yx-a")!.textContent).toBe("a");
    expect(document.querySelector("section p.yx-deep")!.textContent).toBe("deep");
  });

  it("doesn't reach into <template> content (it isn't part of the page)", () => {
    const template = document.querySelector("template")!;
    expect(template.content.querySelectorAll("style[data-yx-css]")).toHaveLength(1);
    expect(inHead()).not.toContain("yx-in-template");
  });

  it("keeps the text of the first copy of each", () => {
    const a = document.head.querySelector('style[data-yx-css="yx-a"]')!;
    expect(a.textContent).toBe(".yx-a{--n:yx-a}");
  });
});

describe("apply", () => {
  it("hoists styles from many applies, keeping one per class", async () => {
    document.body.innerHTML = `<ul id="list" data-yx-region></ul>`;
    for (let i = 0; i < 60; i++) {
      const names = [`yx-r${i % 7}`, `yx-r${(i + 3) % 7}`, "yx-a"];
      yerd.apply(`<ul id="list" data-yx-region>${names.map((n) => style(n)).join("")}<li class="${names.join(" ")}">${i}</li></ul>`);
    }
    await flush();
    expect(inBody()).toBe(0);
    expect(unique(inHead())).toBe(true);
    for (let r = 0; r < 7; r++) expect(inHead()).toContain(`yx-r${r}`);
    expect(document.querySelectorAll("#list li")).toHaveLength(1);
    expect(document.querySelector("#list li")!.textContent).toBe("59");
  });

  it("keeps head order stable: new classes are appended, known ones don't move", async () => {
    const before = inHead();
    document.body.innerHTML = `<div id="r" data-yx-region></div>`;
    yerd.apply(`<div id="r" data-yx-region>${style("yx-new2")}${style("yx-a")}${style("yx-new1")}<p class="yx-new1 yx-new2 yx-a"></p></div>`);
    await flush();
    expect(inHead()).toEqual([...before, "yx-new2", "yx-new1"]);
  });

  it("hoists styles nested deep inside a region", async () => {
    document.body.innerHTML = `<main id="deep" data-yx-region></main>`;
    let inner = `${style("yx-very-deep")}<b class="yx-very-deep">x</b>`;
    for (let i = 0; i < 25; i++) inner = `<div>${inner}</div>`;
    yerd.apply(`<main id="deep" data-yx-region>${inner}</main>`);
    await flush();
    expect(inHead()).toContain("yx-very-deep");
    expect(inBody()).toBe(0);
    expect(document.querySelector("b.yx-very-deep")).not.toBeNull();
  });

  it("hoists styles from several regions in one response", async () => {
    document.body.innerHTML = `<div id="one" data-yx-region></div><div id="two" data-yx-region></div>`;
    yerd.apply(
      `<div id="one" data-yx-region>${style("yx-one")}<i class="yx-one"></i></div><div id="two" data-yx-region>${style("yx-one")}${style("yx-two")}<i class="yx-one yx-two"></i></div>`,
    );
    await flush();
    expect(inHead().filter((n) => n === "yx-one" || n === "yx-two")).toEqual(["yx-one", "yx-two"]);
    expect(inBody()).toBe(0);
  });

  it("takes the styles for a class on the region element itself (sent before it, outside the region)", async () => {
    document.body.innerHTML = `<ul id="status" data-yx-region class="yx-pending"></ul>`;
    yerd.apply(`${style("yx-done-region")}<ul id="status" data-yx-region class="yx-done-region"><li>done</li></ul>`);
    await flush();
    expect(document.getElementById("status")!.className).toBe("yx-done-region");
    expect(inHead()).toContain("yx-done-region");
  });

  it("takes styles a filled-in <Dynamic> wrapper's class brought along", async () => {
    document.body.innerHTML = `<section id="cart" data-yx-region data-yx-defer>...</section>`;
    yerd.apply(`${style("yx-cart-wrapper")}<section id="cart" data-yx-region class="yx-cart-wrapper">3 items</section>`);
    await flush();
    expect(inHead()).toContain("yx-cart-wrapper");
  });

  it("takes a response's styles once even when none of its regions are on the page (they're scoped: harmless)", async () => {
    document.body.innerHTML = `<div id="here" data-yx-region></div>`;
    const applied = yerd.apply(`<div id="elsewhere" data-yx-region>${style("yx-elsewhere")}</div>`);
    yerd.apply(`<div id="elsewhere" data-yx-region>${style("yx-elsewhere")}</div>`);
    await flush();
    expect(applied).toBe(0);
    expect(inBody()).toBe(0);
    expect(inHead().filter((n) => n === "yx-elsewhere")).toHaveLength(1);
  });

  it("applies a response that carries only styles without touching the page", async () => {
    document.body.innerHTML = `<div id="keep" data-yx-region>kept</div>`;
    expect(yerd.apply(style("yx-only-style"))).toBe(0);
    await flush();
    expect(document.getElementById("keep")!.textContent).toBe("kept");
    expect(inHead()).toContain("yx-only-style");
  });

  it("hoists styles from appended children and doesn't duplicate on repeat appends", async () => {
    document.body.innerHTML = `<ol id="feed" data-yx-region data-yx-append></ol>`;
    for (let i = 0; i < 5; i++) {
      yerd.apply(`<ol id="feed" data-yx-region data-yx-append>${style("yx-feed-item")}<li class="yx-feed-item" data-key="${i}">${i}</li></ol>`);
    }
    await flush();
    expect(document.querySelectorAll("#feed li")).toHaveLength(5);
    expect(document.querySelectorAll("#feed style")).toHaveLength(0);
    expect(inHead().filter((n) => n === "yx-feed-item")).toHaveLength(1);
  });

  it("doesn't duplicate after repeated morphs of the same region, and leaves no stray nodes", async () => {
    document.body.innerHTML = `<div id="m" data-yx-region></div>`;
    const html = `<div id="m" data-yx-region>${style("yx-m1")}<p class="yx-m1">a</p>${style("yx-m2")}<p class="yx-m2">b</p></div>`;
    for (let i = 0; i < 10; i++) {
      yerd.apply(html);
      await flush();
    }
    const region = document.getElementById("m")!;
    expect(Array.from(region.children, (el) => el.tagName)).toEqual(["P", "P"]);
    expect(inHead().filter((n) => n === "yx-m1" || n === "yx-m2")).toEqual(["yx-m1", "yx-m2"]);
  });

  it("dedupes by class name: a repeat with different text keeps the first", async () => {
    document.body.innerHTML = `<div id="d" data-yx-region></div>`;
    yerd.apply(`<div id="d" data-yx-region>${style("yx-a", ".yx-a{--changed:1}")}</div>`);
    await flush();
    expect(document.head.querySelectorAll('style[data-yx-css="yx-a"]')).toHaveLength(1);
    expect(document.head.querySelector('style[data-yx-css="yx-a"]')!.textContent).toBe(".yx-a{--n:yx-a}");
  });

  it("leaves other <style> elements in a response where they are", async () => {
    document.body.innerHTML = `<div id="o" data-yx-region></div>`;
    yerd.apply(`<div id="o" data-yx-region><style>.mine{}</style><p>x</p></div>`);
    await flush();
    expect(document.querySelector("#o style")!.textContent).toBe(".mine{}");
  });
});

describe("boosted navigation", () => {
  it("survives many navigations back and forth without duplicates", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      return n % 2
        ? page(`${style("yx-page-a")}<main class="yx-page-a">${style("yx-shared")}<p class="yx-shared">A</p></main>`)
        : page(`${style("yx-page-b")}<main class="yx-page-b">${style("yx-shared")}<p class="yx-shared">B</p></main>`);
    }));
    for (let i = 0; i < 12; i++) {
      await yerd.load(`/p${i}`, true);
      await flush();
      expect(inBody()).toBe(0);
    }
    expect(unique(inHead())).toBe(true);
    for (const name of ["yx-page-a", "yx-page-b", "yx-shared"]) expect(inHead()).toContain(name);
    expect(document.querySelector("main")!.className).toBe("yx-page-b");
    expect(document.querySelector("main p")!.textContent).toBe("B");
  });

  it("takes styles the new page has in its <head> (a class on <body> or <html> puts them there)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => page(`<p>body class page</p>`, style("yx-body-class"))));
    await yerd.load("/body-class", true);
    await flush();
    expect(inHead()).toContain("yx-body-class");
    expect(unique(inHead())).toBe(true);
  });

  it("doesn't duplicate the global styles the new page's <head> repeats", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => page(`<p>x</p>`, style("global", ":root{--g:1}"))));
    await yerd.load("/global-again", true);
    await flush();
    expect(inHead().filter((n) => n === "global")).toHaveLength(1);
  });

  it("keeps hoisted styles across a navigation to a page that doesn't use them", async () => {
    const before = inHead();
    vi.stubGlobal("fetch", vi.fn(async () => page(`<p>nothing styled</p>`)));
    await yerd.load("/plain", true);
    await flush();
    expect(inHead()).toEqual(before);
  });

  it("takes styles from both the <head> and the <body> of the new page", async () => {
    document.body.innerHTML = `<p>before</p>`;
    vi.stubGlobal("fetch", vi.fn(async () => page(`${style("yx-after-post")}<p class="yx-after-post">posted</p>`, style("yx-after-post-body"))));
    await yerd.load("/submit", true);
    await flush();
    expect(inHead()).toEqual(expect.arrayContaining(["yx-after-post", "yx-after-post-body"]));
    expect(inBody()).toBe(0);
  });

  it("keeps first-seen order across navigations", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => page(`${style("yx-order-2")}${style("yx-order-1")}<p class="yx-order-1 yx-order-2">x</p>`)));
    await yerd.load("/order", true);
    await flush();
    const names = inHead();
    expect(names.indexOf("yx-order-2")).toBeLessThan(names.indexOf("yx-order-1"));
    expect(names.indexOf("yx-a")).toBeLessThan(names.indexOf("yx-order-2"));
  });
});

describe("with the server's own output", () => {
  /** What the runtime does after any change to the page. */
  const applied = () => document.dispatchEvent(new CustomEvent("yx:applied", { detail: { regions: -1 } }));

  it("styles a Region whose class changes in an action's response", async () => {
    const pending = css`--state: pending;`;
    const done = css`--state: done;`;
    const item = css`--state: item;`;
    const view = (cls: string, items: string[]) => jsx(Region, { id: "job", as: "ul", class: cls, children: items.map((t) => jsx("li", { class: item, children: t })) });
    document.body.innerHTML = await renderToString(jsx("main", { children: view(pending, ["a"]) }));
    applied();
    expect(inBody()).toBe(0);
    yerd.apply(await renderToString(view(done, ["a", "b"])));
    await flush();
    expect(document.getElementById("job")!.className).toBe(done);
    expect(document.querySelectorAll("#job li")).toHaveLength(2);
    expect(inHead()).toEqual(expect.arrayContaining([pending, done, item]));
    expect(unique(inHead())).toBe(true);
    expect(inBody()).toBe(0);
  });

  it("styles a prerendered <Dynamic> part (and its wrapper) once the runtime fills it in", async () => {
    const wrapper = css`--dynamic: wrapper;`;
    const inner = css`--dynamic: inner;`;
    const skeleton = css`--dynamic: skeleton;`;
    const node = jsx("main", {
      children: jsx(Dynamic, { id: "dyn", class: wrapper, fallback: jsx("i", { class: skeleton, children: "..." }), children: () => jsx("b", { class: inner, children: "live" }) }),
    });
    const fill = await renderToString(node, { dynamic: "only" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(fill, { headers: { "content-type": "text/html" } })));
    document.body.innerHTML = await renderToString(node, { dynamic: "fallback" });
    applied();
    await flush();
    expect(document.querySelector("#dyn b")!.textContent).toBe("live");
    expect(document.getElementById("dyn")!.hasAttribute("data-yx-defer")).toBe(false);
    expect(inHead()).toEqual(expect.arrayContaining([wrapper, inner, skeleton]));
    expect(unique(inHead())).toBe(true);
    expect(inBody()).toBe(0);
  });
});
