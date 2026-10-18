// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runtimeSource } from "../../src/client/runtime.js";
import { attribute, attributesSource } from "../../src/attributes/attribute.js";
import type { YerdClient as Yerd } from "../../src/attributes/attribute.js";


// Defined like an app would, then shipped as text with the runtime.
attribute("shout", {
  client(el, value) {
    el.textContent = value.toUpperCase();
    el.setAttribute("data-connected", "1");
    return {
      update(next) {
        el.textContent = next.toUpperCase();
      },
      disconnect() {
        (window as unknown as { disconnected: string[] }).disconnected.push(el.id);
      },
    };
  },
});

let yerd: Yerd;
const log = () => (window as unknown as { disconnected: string[] }).disconnected;

beforeAll(() => {
  (window as unknown as { disconnected: string[] }).disconnected = [];
  new Function(runtimeSource() + attributesSource())();
  yerd = (window as unknown as { yerd: Yerd }).yerd;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** Let mutation observers, fetches and their continuations settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function stubFetch(body = "<html><body><main>next</main></body></html>", type = "text/html") {
  const fn = vi.fn((_url: string | URL, _init: RequestInit = {}) =>
    Promise.resolve(new Response(body, { headers: { "content-type": type } })),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("custom attributes in the browser", () => {
  it("connect on insert, update on change, disconnect on removal", async () => {
    document.body.innerHTML = '<p id="a" shout="hello"></p>';
    await flush();
    const p = document.getElementById("a")!;
    expect(p.textContent).toBe("HELLO");
    p.setAttribute("shout", "again");
    await flush();
    expect(p.textContent).toBe("AGAIN");
    p.remove();
    await flush();
    expect(log()).toEqual(["a"]);
  });

  it("disconnect when the attribute goes but the element stays", async () => {
    log().length = 0;
    document.body.innerHTML = '<p id="b" shout="x"></p>';
    await flush();
    document.getElementById("b")!.removeAttribute("shout");
    await flush();
    expect(log()).toEqual(["b"]);
  });

  it("survive being moved (a keyed morph removes and re-adds in one batch)", async () => {
    log().length = 0;
    document.body.innerHTML = '<div id="one"><p id="c" shout="x"></p></div><div id="two"></div>';
    await flush();
    document.getElementById("two")!.appendChild(document.getElementById("c")!);
    await flush();
    expect(log()).toEqual([]);
  });
});

describe("prefetch", () => {
  it("warms a boosted link's page on hover, and the navigation uses it", async () => {
    const fetch = stubFetch();
    document.body.innerHTML = '<nav data-yx-boost><a id="l" href="/next" data-yx-prefetch="intent">next</a></nav>';
    await flush();
    document.getElementById("l")!.dispatchEvent(new Event("pointerenter"));
    await new Promise((r) => setTimeout(r, 80));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0]!;
    expect((init!.headers as Record<string, string>)["yx-prefetch"]).toBe("1");
    await yerd.page.load("/next", true);
    // The navigation was answered from the prefetch: still one request.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(document.querySelector("main")?.textContent).toBe("next");
  });

  it("leaves ordinary links to the browser's own <link rel=prefetch>", async () => {
    const fetch = stubFetch();
    document.body.innerHTML = '<a id="m" href="/plain" data-yx-prefetch="load">plain</a>';
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(document.head.querySelector('link[rel="prefetch"]')?.getAttribute("href")).toBe(new URL("/plain", location.href).href);
  });

  it("takes its <link rel=prefetch> out once fetched, and asks again on another page", async () => {
    const href = new URL("/again", location.href).href;
    const links = () => Array.from(document.head.querySelectorAll('link[rel="prefetch"]')).filter((link) => link.getAttribute("href") === href);
    stubFetch('<html><body><span data-yx-prefetch="load" data-yx-prefetch-url="/again">again</span></body></html>');
    document.body.innerHTML = '<a href="/again" data-yx-prefetch="load">again</a>';
    await flush();
    expect(links()).toHaveLength(1);
    links()[0]!.dispatchEvent(new Event("load"));
    expect(links()).toHaveLength(0);
    // Same page: already asked for, not again.
    document.body.insertAdjacentHTML("beforeend", '<a href="/again" data-yx-prefetch="load">again</a>');
    await flush();
    expect(links()).toHaveLength(0);
    await yerd.page.load("/elsewhere", true);
    await flush();
    expect(links()).toHaveLength(1);
    links()[0]!.dispatchEvent(new Event("error"));
    expect(links()).toHaveLength(0);
  });

  it("answers yerd.fetch from a fresh JSON prefetch", async () => {
    const fetch = stubFetch('{"n":1}', "application/json");
    yerd.net.prefetch("/api/stats", "json");
    await flush();
    const response = await yerd.net.fetch("/api/stats");
    expect(await response.json()).toEqual({ n: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
