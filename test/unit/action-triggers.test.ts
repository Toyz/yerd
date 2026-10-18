// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runtimeSource } from "../../src/client/runtime.js";

let observed: Array<{ el: Element; fire: () => void }> = [];

beforeAll(() => {
  // A controllable IntersectionObserver: tests decide when something scrolls into view.
  class FakeObserver {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(el: Element) {
      observed.push({ el, fire: () => this.callback([{ target: el, isIntersecting: true } as unknown as IntersectionObserverEntry], this as never) });
    }
    unobserve(el: Element) {
      observed = observed.filter((o) => o.el !== el);
    }
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  new Function(runtimeSource())();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  observed = [];
});

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stubFetch(handler: (body: URLSearchParams) => Response | Promise<Response>) {
  const fn = vi.fn(async (_url: string | URL, init: RequestInit = {}) => handler(new URLSearchParams(String(init.body))));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

/** Put markup on the page and let the runtime wire it, as after a morph. */
function show(markup: string): void {
  document.body.innerHTML = markup;
  document.dispatchEvent(new CustomEvent("yx:applied", { detail: { regions: 0 } }));
}

describe("element actions", () => {
  it("posts the token with live values from the element, refs and data-*, then morphs the result", async () => {
    const fetch = stubFetch(() => html('<div id="out" data-yx-region>done</div>'));
    show(`
      <input id="sort" value="new">
      <div id="out" data-yx-region>before</div>
      <button id="go" data-yx-action="/list" data-yx-token="T" data-yx-trigger="click" data-id="7"
        data-yx-holes='[["el","dataset","id"],["ref","#sort","value"],["el","textContent"]]'>Go</button>`);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.getElementById("go")!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    await flush();
    const body = new URLSearchParams(String(fetch.mock.calls[0]![1]!.body));
    expect(Object.fromEntries(body)).toEqual({ _yx: "T", _yxh0: "7", _yxh1: "new", _yxh2: "Go" });
    expect((fetch.mock.calls[0]![1]!.headers as Record<string, string>).yx).toBe("1");
    expect(document.getElementById("out")!.textContent).toBe("done");
  });

  it("doesn't send when a ref matches nothing", async () => {
    const fetch = stubFetch(() => html(""));
    vi.spyOn(console, "error").mockImplementation(() => {});
    show(`<button id="go" data-yx-action="/x" data-yx-token="T" data-yx-trigger="click" data-yx-holes='[["ref","#nope","value"]]'>Go</button>`);
    document.getElementById("go")!.click();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("typeahead: debounces input, sends the field, and a newer run cancels the older", async () => {
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_url: string | URL, init: RequestInit = {}) => {
      signals.push(init.signal!);
      return new Promise<Response>((resolve) => setTimeout(() => resolve(html('<ul id="hits" data-yx-region><li>x</li></ul>')), 60));
    });
    vi.stubGlobal("fetch", fetch);
    show(`<input id="q" name="q" data-yx-action="/s" data-yx-token="T" data-yx-trigger="input 20ms" data-yx-holes='[["el","value"]]'><ul id="hits" data-yx-region></ul>`);
    const q = document.getElementById("q") as HTMLInputElement;
    for (const value of ["c", "ca", "cat"]) {
      q.value = value;
      q.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await wait(30); // debounce done, request still out
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(new URLSearchParams(String(fetch.mock.calls[0]![1]!.body)))).toEqual({ _yx: "T", _yxh0: "cat", q: "cat" });
    q.value = "cats";
    q.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(30);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(signals[0]!.aborted).toBe(true);
    await wait(80);
    expect(document.querySelectorAll("#hits li")).toHaveLength(1);
  });

  it("filters key triggers", async () => {
    const fetch = stubFetch(() => new Response(null, { status: 204 }));
    vi.spyOn(globalThis, "fetch");
    show(`<input id="k" data-yx-action="/k" data-yx-token="T" data-yx-trigger="keydown:Enter">`);
    const k = document.getElementById("k")!;
    k.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(fetch).not.toHaveBeenCalled();
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    k.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    await flush();
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/k"))).toHaveLength(1);
  });

  it("infinite scroll: visible fires once per token, and appending Regions add rows", async () => {
    let page = 1;
    const fetch = stubFetch(() => {
      page++;
      return html(`<ul id="feed" data-yx-region data-yx-append><li data-key="r${page}">row ${page}</li></ul>
        <div id="more" data-yx-region><div id="sentinel" data-yx-action="/feed" data-yx-token="T${page}" data-yx-trigger="visible">more</div></div>`);
    });
    show(`<ul id="feed" data-yx-region><li data-key="r1">row 1</li></ul>
      <div id="more" data-yx-region><div id="sentinel" data-yx-action="/feed" data-yx-token="T1" data-yx-trigger="visible">more</div></div>`);
    expect(observed).toHaveLength(1);
    observed[0]!.fire();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect([...document.querySelectorAll("#feed li")].map((li) => li.textContent)).toEqual(["row 1", "row 2"]);
    expect(document.querySelector('#feed li[data-key="r2"]')!.hasAttribute("data-yx-new")).toBe(true);
    // The sentinel came back with a new token: armed again.
    expect(observed.map((o) => o.el.id)).toEqual(["sentinel"]);
    observed[0]!.fire();
    await flush();
    expect([...document.querySelectorAll("#feed li")].map((li) => li.textContent)).toEqual(["row 1", "row 2", "row 3"]);
  });

  it("prepend puts new children first and updates ones already there", async () => {
    stubFetch(() => html('<ul id="chat" data-yx-region data-yx-prepend><li id="m3">three</li><li id="m1">one (edited)</li></ul>'));
    show(`<ul id="chat" data-yx-region><li id="m2">two</li><li id="m1">one</li></ul>
      <button id="go" data-yx-action="/c" data-yx-token="T" data-yx-trigger="click">go</button>`);
    document.getElementById("go")!.click();
    await flush();
    expect([...document.querySelectorAll("#chat li")].map((li) => li.textContent)).toEqual(["three", "two", "one (edited)"]);
  });

  it("load fires right away, once per token", async () => {
    const fetch = stubFetch(() => new Response(null, { status: 204 }));
    show(`<div id="l" data-yx-action="/l" data-yx-token="T" data-yx-trigger="load"></div>`);
    await flush();
    document.dispatchEvent(new CustomEvent("yx:applied", { detail: { regions: 0 } }));
    await flush();
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/l"))).toHaveLength(1);
  });
});
