// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeSource } from "../../src/client/runtime.js";
import type { YerdClient as Yerd } from "../../src/attributes/attribute.js";


let yerd: Yerd;

beforeAll(() => {
  // What <Scripts auto /> renders; the runtime reads it on start.
  const script = document.createElement("script");
  script.setAttribute("data-yx-auto", "");
  document.head.appendChild(script);
  new Function(runtimeSource())();
  yerd = (window as unknown as { yerd: Yerd }).yerd;
});

beforeEach(() => {
  history.replaceState({ yx: true }, "", "/start");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

type Call = { url: string; method: string; headers: Record<string, string>; body: RequestInit["body"] };

function stubFetch(handler: (call: Call) => Response | Promise<Response> = () => page("")) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const call = { url: String(url), method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: init.body };
    calls.push(call);
    return handler(call);
  }));
  return calls;
}

function page(body: string, opts: { url?: string; title?: string; status?: number; type?: string } = {}): Response {
  const response = new Response(`<html><head><title>${opts.title ?? "t"}</title></head><body>${body}</body></html>`, {
    status: opts.status ?? 200,
    headers: { "content-type": opts.type ?? "text/html; charset=utf-8" },
  });
  if (opts.url) Object.defineProperty(response, "url", { value: opts.url });
  return response;
}

function click(el: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(event);
  return event;
}

/** Whether the runtime took a click (window listeners run after its document one; they also stop real navigation). */
function taken(el: Element, init: MouseEventInit = {}): boolean {
  let result: boolean | undefined;
  window.addEventListener("click", (e) => {
    result = e.defaultPrevented;
    e.preventDefault();
  }, { once: true });
  click(el, init);
  return result!;
}

const $ = (id: string) => document.getElementById(id)!;

describe("which links boost", () => {
  it.each([
    ['<a id="l" href="/page">x</a>', true],
    ['<a id="l" href="page">relative</a>', true],
    ['<a id="l" href="/page.html">html</a>', true],
    ['<a id="l" href="/page.HTM">htm</a>', true],
    ['<a id="l" href="/v1.2/page">dot in a directory</a>', true],
    ['<a id="l" href="/page?file=a.pdf">file-like query</a>', true],
    ['<a id="l" href="/report.pdf">pdf</a>', false],
    ['<a id="l" href="/data.json">json</a>', false],
    ['<a id="l" href="/archive.tar.gz">gz</a>', false],
    ['<a id="l" href="/page" target="_blank">blank</a>', false],
    ['<a id="l" href="/page" target="frame">named</a>', false],
    ['<a id="l" href="/page" target="_self">self</a>', true],
    ['<a id="l" href="/page" download>download</a>', false],
    ['<a id="l" href="/page" rel="noopener external">external</a>', false],
    ['<a id="l" href="/page" rel="EXTERNAL">EXTERNAL</a>', false],
    ['<a id="l" href="/page" rel="externally">externally</a>', true],
    ['<a id="l" href="https://other.test/page">other origin</a>', false],
    ['<a id="l" href="//other.test/page">protocol-relative</a>', false],
    ['<a id="l" href="mailto:a@b.test">mailto</a>', false],
    ['<a id="l" href="javascript:void(0)">javascript</a>', false],
    ['<div data-yx-boost="false"><a id="l" href="/page">opted out</a></div>', false],
    ['<div data-yx-boost="false"><div data-yx-boost><a id="l" href="/page">opted back in</a></div></div>', true],
    ['<a id="l" href="#frag">same-page fragment</a>', false],
  ])("%s: %s", (markup, boosts) => {
    stubFetch();
    document.body.innerHTML = markup;
    expect(taken($("l"))).toBe(boosts);
  });

  it.each([
    ["the middle button", { button: 1 }],
    ["ctrl", { ctrlKey: true }],
    ["meta", { metaKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
  ])("a click with %s is the browser's", (_name, init) => {
    stubFetch();
    document.body.innerHTML = '<a id="l" href="/page">x</a>';
    expect(taken($("l"), init)).toBe(false);
  });

  it("a click the app already prevented is left alone", async () => {
    const calls = stubFetch();
    document.body.innerHTML = '<a id="l" href="/page">x</a>';
    $("l").addEventListener("click", (e) => e.preventDefault());
    click($("l"));
    await flush();
    expect(calls).toEqual([]);
  });

  it("a click on something inside a link boosts the link", async () => {
    stubFetch(() => page("<main>inner</main>"));
    document.body.innerHTML = '<a href="/inner"><span id="s">x</span></a>';
    expect(taken($("s"))).toBe(true);
    await flush();
    expect(location.pathname).toBe("/inner");
  });

  it("a fragment link to another page boosts and keeps the fragment", async () => {
    stubFetch(() => page('<h2 id="sec">s</h2>'));
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    document.body.innerHTML = '<a id="l" href="/other#sec">x</a>';
    expect(taken($("l"))).toBe(true);
    await flush();
    expect(location.pathname + location.hash).toBe("/other#sec");
    expect(scroll.mock.instances[0]).toBe($("sec"));
  });

  it("a percent-encoded fragment finds its element", async () => {
    stubFetch(() => page('<h2 id="café menu">s</h2>'));
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    await yerd.page.load("/menu#caf%C3%A9%20menu", true);
    expect(scroll.mock.instances[0]).toBe(document.getElementById("café menu"));
  });

  it("a broken percent-encoding in the fragment doesn't throw", async () => {
    stubFetch(() => page("<p>x</p>"));
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    await yerd.page.load("/menu#100%", true);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });
});

describe("navigation", () => {
  it("pushes the landed URL (after redirects), with the asked-for fragment", async () => {
    stubFetch(() => page("<p>landed</p>", { url: `${location.origin}/final?x=1` }));
    await yerd.page.load("/start-here#frag", true);
    expect(location.pathname + location.search + location.hash).toBe("/final?x=1#frag");
  });

  it("a redirect to another origin is a real navigation", async () => {
    stubFetch(() => page("<p>evil</p>", { url: "https://other.test/landing" }));
    const assign = vi.spyOn(location, "assign").mockImplementation(() => {});
    document.body.innerHTML = '<p id="keep">k</p>';
    await yerd.page.load("/go", true);
    expect(assign).toHaveBeenCalledWith(`${location.origin}/go`);
    expect($("keep")).not.toBeNull();
  });

  it.each([
    ["JSON", page("{}", { type: "application/json" })],
    ["a PDF", new Response("%PDF", { headers: { "content-type": "application/pdf" } })],
    ["no content type", new Response("x")],
  ])("a response that isn't HTML (%s) is left to a real navigation", async (_name, response) => {
    stubFetch(() => response);
    const assign = vi.spyOn(location, "assign").mockImplementation(() => {});
    await yerd.page.load("/file", true);
    expect(assign).toHaveBeenCalledWith(`${location.origin}/file`);
  });

  it("an error page is still a page: it's shown", async () => {
    stubFetch(() => page('<h1 id="e">Not found</h1>', { status: 404 }));
    await yerd.page.load("/missing", true);
    expect($("e").textContent).toBe("Not found");
    expect(location.pathname).toBe("/missing");
  });

  it("a network failure falls back to a real navigation", async () => {
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const assign = vi.spyOn(location, "assign").mockImplementation(() => {});
    await yerd.page.load("/down", true);
    expect(assign).toHaveBeenCalledWith(`${location.origin}/down`);
    expect(document.documentElement.hasAttribute("aria-busy")).toBe(false);
  });

  it("marks the document busy while loading", async () => {
    let release!: () => void;
    stubFetch(() => new Promise<Response>((resolve) => (release = () => resolve(page("<p>x</p>")))));
    const loading = yerd.page.load("/slow", true);
    await flush();
    expect(document.documentElement.getAttribute("aria-busy")).toBe("true");
    release();
    await loading;
    expect(document.documentElement.hasAttribute("aria-busy")).toBe(false);
  });

  it("updates the title and focuses [autofocus]", async () => {
    stubFetch(() => page('<input id="f" autofocus>', { title: "Second &amp; more" }));
    await yerd.page.load("/second", true);
    expect(document.title).toBe("Second & more");
    expect(document.activeElement).toBe($("f"));
  });

  it("fires yx:applied with regions -1 for a whole page", async () => {
    stubFetch(() => page("<p>x</p>"));
    const seen: number[] = [];
    const listen = (e: Event) => seen.push((e as CustomEvent<{ regions: number }>).detail.regions);
    document.addEventListener("yx:applied", listen);
    await yerd.page.load("/x", true);
    document.removeEventListener("yx:applied", listen);
    expect(seen).toEqual([-1]);
  });

  it("remembers the scroll position for Back, and restores it", async () => {
    stubFetch(() => page("<p>x</p>"));
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    Object.defineProperty(window, "scrollY", { value: 420, configurable: true });
    await yerd.page.load("/next", true);
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
    // Back: the browser restores the entry and its state, then fires popstate.
    history.back();
    await flush();
    await flush();
    expect(location.pathname).toBe("/start");
    expect(scrollTo).toHaveBeenLastCalledWith(0, 420);
  });

  it("a popstate entry it didn't make is the browser's", async () => {
    const calls = stubFetch(() => page("<p>x</p>"));
    history.pushState(null, "", "/foreign");
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    await flush();
    expect(calls).toEqual([]);
  });

  it("a page restored from the back/forward cache is reloaded fresh; a normal pageshow isn't", async () => {
    const calls = stubFetch(() => page("<p id='fresh'>fresh</p>"));
    window.dispatchEvent(new Event("pageshow"));
    await flush();
    expect(calls).toEqual([]);
    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    window.dispatchEvent(restored);
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["yx-boost"]).toBe("1");
    expect($("fresh")).not.toBeNull();
  });
});

describe("prefetch cache", () => {
  it("a page prefetch is used once by the next navigation", async () => {
    const calls = stubFetch(() => page("<p>p</p>"));
    yerd.net.prefetch("/warm");
    expect(calls[0]!.headers).toEqual({ "yx-boost": "1", "yx-prefetch": "1", accept: "text/html" });
    await yerd.page.load("/warm", true);
    expect(calls).toHaveLength(1);
    await yerd.page.load("/warm", true);
    expect(calls).toHaveLength(2);
  });

  it("the fragment doesn't matter to the cache", async () => {
    const calls = stubFetch(() => page("<p>p</p>"));
    yerd.net.prefetch("/frag#a");
    await yerd.page.load("/frag#b", true);
    expect(calls).toHaveLength(1);
  });

  it("a second prefetch of a fresh entry doesn't fetch again", () => {
    const calls = stubFetch(() => page("<p>p</p>"));
    yerd.net.prefetch("/twice");
    yerd.net.prefetch("/twice");
    expect(calls).toHaveLength(1);
  });

  it("entries go stale after 15s", async () => {
    const calls = stubFetch(() => page("<p>p</p>"));
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    yerd.net.prefetch("/old");
    clock.mockReturnValue(now + 15_001);
    await yerd.page.load("/old", true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers["yx-prefetch"]).toBeUndefined();
  });

  it("a failed prefetch isn't used; the navigation fetches", async () => {
    let n = 0;
    const calls = stubFetch(() => (++n === 1 ? page("oops", { status: 500 }) : page('<p id="ok">ok</p>')));
    yerd.net.prefetch("/flaky");
    await flush();
    await yerd.page.load("/flaky", true);
    expect(calls).toHaveLength(2);
    expect($("ok")).not.toBeNull();
  });

  it("other origins aren't prefetched", () => {
    const calls = stubFetch();
    yerd.net.prefetch("https://other.test/x");
    expect(calls).toEqual([]);
  });

  it.each([
    ["saveData", { saveData: true }],
    ["2g", { effectiveType: "2g" }],
    ["slow-2g", { effectiveType: "slow-2g" }],
  ])("skipped on %s connections", (_name, connection) => {
    const calls = stubFetch();
    Object.defineProperty(navigator, "connection", { value: connection, configurable: true });
    try {
      yerd.net.prefetch("/x-conn");
    } finally {
      delete (navigator as { connection?: unknown }).connection;
    }
    expect(calls).toEqual([]);
  });

  it("an action empties the cache", async () => {
    const calls = stubFetch((call) => (call.method === "POST" ? new Response('<p id="r" data-yx-region>r</p>', { headers: { "content-type": "text/html" } }) : page("<p>p</p>")));
    yerd.net.prefetch("/after-action");
    document.body.innerHTML = '<p id="r" data-yx-region></p><form data-yx method="post" action="/act"><button>go</button></form>';
    $("r").nextElementSibling!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await flush();
    await yerd.page.load("/after-action", true);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
  });

  it("holds at most 30 entries, dropping the oldest", async () => {
    const calls = stubFetch(() => page("<p>p</p>"));
    for (let i = 0; i < 31; i++) yerd.net.prefetch(`/many/${i}`);
    expect(calls).toHaveLength(31);
    await yerd.page.load("/many/0", true);
    expect(calls).toHaveLength(32);
    await yerd.page.load("/many/30", true);
    expect(calls).toHaveLength(32);
  });

  it("yerd.fetch answers from a fresh JSON prefetch, for GETs only", async () => {
    const calls = stubFetch(() => new Response('{"n":1}', { headers: { "content-type": "application/json" } }));
    yerd.net.prefetch("/api/stats", "json");
    expect(calls[0]!.headers).toEqual({ "yx-prefetch": "1", accept: "application/json" });
    const hit = await yerd.net.fetch("/api/stats");
    expect(await hit.json()).toEqual({ n: 1 });
    expect(hit.headers.get("content-type")).toBe("application/json");
    expect(calls).toHaveLength(1);
    // JSON entries can be used again while fresh.
    await yerd.net.fetch("/api/stats", { method: "get" });
    expect(calls).toHaveLength(1);
    await yerd.net.fetch("/api/stats", { method: "POST" });
    expect(calls).toHaveLength(2);
  });

  it("a page prefetch doesn't answer yerd.fetch, and a JSON one doesn't feed navigation", async () => {
    const calls = stubFetch(() => page("<p>p</p>"));
    yerd.net.prefetch("/both");
    await yerd.net.fetch("/both");
    expect(calls).toHaveLength(2);
  });

  it("mousedown on a boosted link starts the fetch; on an ineligible one it doesn't", () => {
    const calls = stubFetch(() => page("<p>p</p>"));
    document.body.innerHTML = '<a id="ok" href="/press">ok</a><a id="no" href="/file.zip">no</a>';
    $("no").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(calls).toEqual([]);
    $("ok").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(calls).toHaveLength(1);
  });
});

describe("plain forms in auto mode", () => {
  function submit(form: HTMLFormElement, submitter: HTMLElement | null = null): SubmitEvent {
    const event = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter });
    form.dispatchEvent(event);
    return event;
  }

  it.each([
    ['<form method="post" action="/signup"></form>', true],
    ['<form method="post" action="https://other.test/x"></form>', false],
    ['<div data-yx-boost="false"><form method="post" action="/x"></form></div>', false],
    ['<form method="post" action="/x" target="_blank"></form>', false],
    ['<form method="dialog"></form>', false],
    ["<form></form>", true],
  ])("%s: intercepted %s", (markup, intercepted) => {
    stubFetch(() => page("<p>x</p>"));
    document.body.innerHTML = markup;
    const event = submit(document.querySelector("form")!);
    expect(event.defaultPrevented).toBe(intercepted);
  });

  it("a form with no method navigates with its fields as the query", async () => {
    const calls = stubFetch(() => page('<p id="r">results</p>'));
    document.body.innerHTML = '<form action="/search"><input name="q" value="cats & dogs"></form>';
    submit(document.querySelector("form")!);
    await flush();
    expect(calls[0]!.method).toBe("GET");
    expect(location.pathname + location.search).toBe("/search?q=cats+%26+dogs");
    expect($("r")).not.toBeNull();
  });

  it("a post that lands on the same URL replaces the page without a history entry", async () => {
    stubFetch(() => page('<p id="r">again</p>', { url: `${location.origin}/start` }));
    document.body.innerHTML = '<form method="post" action="/start"><input name="a" value="1"></form>';
    const length = history.length;
    submit(document.querySelector("form")!);
    await flush();
    expect(history.length).toBe(length);
    expect($("r").textContent).toBe("again");
  });

  it("a post that lands elsewhere pushes it and scrolls to the top", async () => {
    stubFetch(() => page('<p id="r">thanks</p>', { url: `${location.origin}/thanks` }));
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    document.body.innerHTML = '<form method="post" action="/signup"></form>';
    submit(document.querySelector("form")!);
    await flush();
    expect(location.pathname).toBe("/thanks");
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("a server error page from a plain post is shown, like the browser would", async () => {
    stubFetch(() => page('<h1 id="e">Something broke</h1>', { status: 500, url: `${location.origin}/signup` }));
    document.body.innerHTML = '<form method="post" action="/signup"><p data-yx-error></p></form>';
    submit(document.querySelector("form")!);
    await flush();
    expect($("e").textContent).toBe("Something broke");
  });

  it("plain posts carry no yx header (redirects are followed by fetch)", async () => {
    const calls = stubFetch(() => page("<p>x</p>"));
    document.body.innerHTML = '<form method="post" action="/plain"><input name="a" value="1"></form>';
    submit(document.querySelector("form")!);
    await flush();
    expect(calls[0]!.headers).toEqual({ accept: "text/html", "content-type": "application/x-www-form-urlencoded" });
  });

  it("an action form in auto mode still gets the action treatment", async () => {
    const calls = stubFetch(() => new Response('<p id="r" data-yx-region>new</p>', { headers: { "content-type": "text/html" } }));
    document.body.innerHTML = '<p id="r" data-yx-region>old</p><form data-yx method="post" action="/act"></form>';
    submit(document.querySelector("form")!);
    await flush();
    expect(calls[0]!.headers.yx).toBe("1");
    expect($("r").textContent).toBe("new");
    expect(location.pathname).toBe("/start");
  });
});
