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
  // happy-dom gap: requestSubmit() with no submitter reports the form itself (browsers: null).
  HTMLFormElement.prototype.requestSubmit = function (this: HTMLFormElement, submitter?: HTMLElement | null) {
    this.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: submitter ?? null }));
  };
  new Function(runtimeSource())();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.getElementById("yx-notice")?.remove();
  observed = [];
});

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Post = { url: string; body: Record<string, string>; signal?: AbortSignal | null };

/** Stub fetch: POSTs are recorded (with their decoded body) and answered by `respond`. */
function stubFetch(respond: (post: Post, n: number) => Response | Promise<Response> = () => new Response(null, { status: 204 }), get: () => Response = () => page("")) {
  const posts: Post[] = [];
  const gets: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    if (init.method !== "POST") {
      gets.push(String(url));
      return get();
    }
    const body = init.body instanceof FormData ? Object.fromEntries(Array.from(init.body, ([k, v]) => [k, typeof v === "string" ? v : `file:${v.name}`])) : Object.fromEntries(new URLSearchParams(String(init.body)));
    const post = { url: String(url), body, signal: init.signal };
    posts.push(post);
    return respond(post, posts.length);
  }));
  return { posts, gets };
}

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : body, { status, headers: { "content-type": "text/html", ...headers } });
}

function page(body: string): Response {
  return html(`<html><head><title>p</title></head><body>${body}</body></html>`);
}

/** Put markup on the page and let the runtime wire it, as after a morph. */
function show(markup: string): void {
  document.body.innerHTML = markup;
  applied();
}

function applied(): void {
  document.dispatchEvent(new CustomEvent("yx:applied", { detail: { regions: 0 } }));
}

const act = (trigger: string, extra = "", id = "a", token = "T") => `<button id="${id}" data-yx-action="/act" data-yx-token="${token}" data-yx-trigger="${trigger}" ${extra}>go</button>`;

function fire(target: Element, type: string, init: EventInit & { key?: string } = {}): Event {
  const event = init.key !== undefined
    ? new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
    : new Event(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

const $ = (id: string) => document.getElementById(id)!;

describe("event triggers", () => {
  it.each([
    ["click", "click"],
    ["dblclick", "dblclick"],
    ["change", "change"],
    ["focusout", "focusout"],
    ["keyup", "keyup"],
    ["a custom event", "my-event"],
    ["an event name with dashes and dots", "x.y-z"],
  ])("%s fires on that event only", async (_name, event) => {
    const { posts } = stubFetch();
    show(act(event));
    fire($("a"), event === "click" ? "dblclick" : "click");
    await flush();
    expect(posts).toHaveLength(0);
    fire($("a"), event);
    await flush();
    expect(posts.map((p) => p.body)).toEqual([{ _yx: "T" }]);
  });

  it("an event from inside the element fires it", async () => {
    const { posts } = stubFetch();
    show(`<div id="a" data-yx-action="/act" data-yx-token="T" data-yx-trigger="click"><span id="inner">x</span></div>`);
    $("inner").click();
    await flush();
    expect(posts).toHaveLength(1);
  });

  it("extra whitespace in the trigger is fine", async () => {
    const { posts } = stubFetch();
    show(act("  click   "));
    $("a").click();
    await flush();
    expect(posts).toHaveLength(1);
  });

  it("prevents a click's default (no navigation or native submit) but not other events'", () => {
    stubFetch();
    show(`<a id="link" href="/elsewhere" data-yx-action="/act" data-yx-token="T" data-yx-trigger="click">l</a>${act("my-event", "", "b")}`);
    expect(fire($("link"), "click").defaultPrevented).toBe(true);
    expect(fire($("b"), "my-event").defaultPrevented).toBe(false);
  });

  it("the innermost action wins: a click on the inner action doesn't fire the outer one", async () => {
    const { posts } = stubFetch();
    show(`<div id="card" data-yx-action="/act" data-yx-token="CARD" data-yx-trigger="click">${act("click", "", "btn", "BTN")}</div>`);
    $("btn").click();
    await flush();
    expect(posts.map((p) => p.body._yx)).toEqual(["BTN"]);
    $("card").click();
    await flush();
    expect(posts.map((p) => p.body._yx)).toEqual(["BTN", "CARD"]);
  });

  it("an action click inside a boosted area doesn't also navigate", async () => {
    const { posts, gets } = stubFetch(() => html('<p id="r" data-yx-region>done</p>'));
    show(`<nav data-yx-boost><a id="l" href="/x" data-yx-action="/act" data-yx-token="T" data-yx-trigger="click">x</a></nav><p id="r" data-yx-region></p>`);
    const path = location.pathname;
    $("l").click();
    await flush();
    expect(posts).toHaveLength(1);
    expect(gets).toEqual([]);
    expect(location.pathname).toBe(path);
  });

  it("a named field sends itself; an unchecked checkbox doesn't", async () => {
    const { posts } = stubFetch();
    show(`<input id="q" name="q" value="v" data-yx-action="/act" data-yx-token="T" data-yx-trigger="change">
      <input id="c" type="checkbox" name="c" value="yes" data-yx-action="/act" data-yx-token="T" data-yx-trigger="change">
      <select id="s" name="s" data-yx-action="/act" data-yx-token="T" data-yx-trigger="change"><option>o1</option><option selected>o2</option></select>
      <div id="d" name="nope" data-yx-action="/act" data-yx-token="T" data-yx-trigger="click"></div>`);
    fire($("q"), "change");
    fire($("c"), "change");
    ($("c") as HTMLInputElement).checked = true;
    fire($("c"), "change");
    fire($("s"), "change");
    $("d").click();
    await flush();
    expect(posts.map((p) => p.body)).toEqual([{ _yx: "T", q: "v" }, { _yx: "T" }, { _yx: "T", c: "yes" }, { _yx: "T", s: "o2" }, { _yx: "T" }]);
  });

  it("an element with no token or no URL posts nothing", async () => {
    const { posts } = stubFetch();
    show(`<button id="a" data-yx-action="/act" data-yx-trigger="click">x</button><button id="b" data-yx-token="T" data-yx-trigger="click">y</button>`);
    $("a").click();
    $("b").click();
    await flush();
    expect(posts).toEqual([]);
  });

  it("posts to the element's URL relative to the page", async () => {
    const { posts } = stubFetch();
    show(`<button id="a" data-yx-action="items/5?x=1" data-yx-token="T" data-yx-trigger="click">x</button>`);
    $("a").click();
    await flush();
    expect(posts[0]!.url).toBe(new URL("items/5?x=1", location.href).href);
  });

  it("asks data-yx-confirm first", async () => {
    const ask = vi.fn(() => false);
    vi.stubGlobal("confirm", ask);
    const { posts } = stubFetch();
    show(act("click", 'data-yx-confirm="Sure?"'));
    $("a").click();
    await flush();
    expect(ask).toHaveBeenCalledWith("Sure?");
    expect(posts).toEqual([]);
  });
});

describe("keys and debounce", () => {
  it.each([
    ["keydown:Enter", "keydown", "Enter", true],
    ["keydown:Enter", "keydown", "a", false],
    ["keydown:Enter", "keyup", "Enter", false],
    ["keyup:Escape", "keyup", "Escape", true],
    ["keydown:a", "keydown", "A", false],
  ])("%s on %s %j fires %s", async (trigger, type, key, fires) => {
    const { posts } = stubFetch();
    show(`<input id="a" data-yx-action="/act" data-yx-token="T" data-yx-trigger="${trigger}">`);
    const event = fire($("a"), type, { key });
    await flush();
    expect(posts.length).toBe(fires ? 1 : 0);
    expect(event.defaultPrevented).toBe(fires);
  });

  it("a key filter with a debounce", async () => {
    const { posts } = stubFetch();
    show(`<input id="a" data-yx-action="/act" data-yx-token="T" data-yx-trigger="keyup:Enter 20ms">`);
    fire($("a"), "keyup", { key: "Enter" });
    fire($("a"), "keyup", { key: "Enter" });
    await wait(5);
    expect(posts).toHaveLength(0);
    await wait(40);
    expect(posts).toHaveLength(1);
  });

  it.each([
    ["input 30ms", 30],
    ["input 0.03s", 30],
  ])("%s debounces to one post after the events stop", async (trigger) => {
    const { posts } = stubFetch();
    show(`<input id="a" name="q" data-yx-action="/act" data-yx-token="T" data-yx-trigger="${trigger}">`);
    const input = $("a") as HTMLInputElement;
    for (const v of ["a", "ab", "abc"]) {
      input.value = v;
      fire(input, "input");
      await wait(5);
    }
    expect(posts).toHaveLength(0);
    await wait(60);
    expect(posts.map((p) => p.body.q)).toEqual(["abc"]);
  });

  it("a duration it can't read means no debounce", async () => {
    const { posts } = stubFetch();
    show(`<input id="a" data-yx-action="/act" data-yx-token="T" data-yx-trigger="input soon">`);
    fire($("a"), "input");
    await flush();
    expect(posts).toHaveLength(1);
  });

  it("a debounce that outlives its element posts nothing", async () => {
    const { posts } = stubFetch();
    show(`<input id="a" data-yx-action="/act" data-yx-token="T" data-yx-trigger="input 20ms">`);
    fire($("a"), "input");
    $("a").remove();
    await wait(50);
    expect(posts).toEqual([]);
  });

  it("the token is read when the action fires, not when the trigger was wired", async () => {
    const { posts } = stubFetch();
    show(`<input id="a" data-yx-action="/act" data-yx-token="OLD" data-yx-trigger="input 20ms">`);
    fire($("a"), "input");
    $("a").setAttribute("data-yx-token", "NEW");
    await wait(50);
    expect(posts.map((p) => p.body._yx)).toEqual(["NEW"]);
  });
});

describe("runs", () => {
  it("a newer run aborts the older one; the older response is never applied", async () => {
    const { posts } = stubFetch(async (_post, n) => {
      if (n === 1) await wait(40);
      return html(`<div id="out" data-yx-region>${n === 1 ? "old" : "new"}</div>`);
    });
    show(`${act("click")}<div id="out" data-yx-region>-</div>`);
    $("a").click();
    await flush();
    $("a").click();
    await wait(60);
    expect(posts[0]!.signal!.aborted).toBe(true);
    expect(posts[1]!.signal!.aborted).toBe(false);
    expect($("out").textContent).toBe("new");
  });

  it("aria-busy lasts until the latest run finishes", async () => {
    const releases: Array<() => void> = [];
    stubFetch(() => new Promise<Response>((resolve) => releases.push(() => resolve(new Response(null, { status: 204 })))));
    show(act("click"));
    $("a").click();
    await flush();
    $("a").click();
    await flush();
    expect($("a").getAttribute("aria-busy")).toBe("true");
    releases[0]!();
    await flush();
    expect($("a").getAttribute("aria-busy")).toBe("true");
    releases[1]!();
    await flush();
    expect($("a").hasAttribute("aria-busy")).toBe(false);
  });

  it("runs on different elements don't cancel each other", async () => {
    const { posts } = stubFetch(async () => {
      await wait(10);
      return new Response(null, { status: 204 });
    });
    show(act("click", "", "a", "A") + act("click", "", "b", "B"));
    $("a").click();
    $("b").click();
    await wait(30);
    expect(posts.map((p) => p.signal!.aborted)).toEqual([false, false]);
  });

  it.each([
    ["a redirect navigates", () => html("", 200, { "yx-location": "/next" }), "nav"],
    ["a stale token reloads and says so", () => new Response("x", { status: 400, headers: { "yx-stale": "1" } }), "stale"],
    ["an error becomes a notice", () => new Response(JSON.stringify({ error: "Nope" }), { status: 403, headers: { "content-type": "application/json" } }), "Nope"],
    ["a 204 refreshes the page's regions", () => new Response(null, { status: 204 }), "refresh"],
    ["HTML with no matching region refreshes", () => html('<p id="zz" data-yx-region>x</p>'), "refresh"],
  ])("%s", async (_name, respond, outcome) => {
    const { gets } = stubFetch(respond, () => page('<div id="r" data-yx-region>fresh</div><button id="a">reloaded</button>'));
    show(`${act("click")}<div id="r" data-yx-region>old</div>`);
    $("a").click();
    await flush();
    if (outcome === "nav") expect(location.pathname).toBe("/next");
    else if (outcome === "stale") expect(document.getElementById("yx-notice")!.textContent).toMatch(/out of date/);
    else if (outcome === "refresh") {
      expect(gets).toEqual([location.href]);
      expect($("r").textContent).toBe("fresh");
    } else expect(document.getElementById("yx-notice")!.textContent).toBe(outcome);
  });

  it("a network error is a notice, not an unhandled rejection", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    show(act("click"));
    $("a").click();
    await flush();
    expect(document.getElementById("yx-notice")!.textContent).toMatch(/Couldn't reach/);
    expect($("a").hasAttribute("aria-busy")).toBe(false);
  });
});

describe("load, visible and every", () => {
  it("load fires on show, again only for a new token", async () => {
    const { posts } = stubFetch();
    show(act("load", "", "a", "T1"));
    await flush();
    applied();
    await flush();
    expect(posts.map((p) => p.body._yx)).toEqual(["T1"]);
    $("a").setAttribute("data-yx-token", "T2");
    applied();
    await flush();
    expect(posts.map((p) => p.body._yx)).toEqual(["T1", "T2"]);
  });

  it("a load action that answers with itself (same token) doesn't loop", async () => {
    const { posts } = stubFetch(() => html(`<div id="w" data-yx-region>${act("load", "", "a", "T1")}</div>`));
    show(`<div id="w" data-yx-region>${act("load", "", "a", "T1")}</div>`);
    await wait(30);
    expect(posts).toHaveLength(1);
  });

  it("visible fires once when it scrolls into view, again for a new token", async () => {
    const { posts } = stubFetch();
    show(act("visible", "", "a", "V1"));
    expect(observed.map((o) => o.el.id)).toEqual(["a"]);
    observed[0]!.fire();
    await flush();
    expect(posts.map((p) => p.body._yx)).toEqual(["V1"]);
    expect(observed).toEqual([]);
    applied();
    expect(observed).toEqual([]);
    $("a").setAttribute("data-yx-token", "V2");
    applied();
    observed[0]!.fire();
    await flush();
    expect(posts.map((p) => p.body._yx)).toEqual(["V1", "V2"]);
  });

  it("a visible form submits itself", async () => {
    const { posts } = stubFetch();
    show(`<form id="f" data-yx method="post" action="/more" data-yx-trigger="visible"><input type="hidden" name="_yx" value="F1"><button>More</button></form>`);
    observed[0]!.fire();
    await flush();
    expect(posts.map((p) => [p.url, p.body])).toEqual([[new URL("/more", location.href).href, { _yx: "F1" }]]);
  });

  it("a form trigger submits the form like its button would, holes and all", async () => {
    const { posts } = stubFetch();
    show(`<form id="f" data-yx method="post" action="/s" data-yx-trigger="input 10ms" data-yx-holes='[["el","id"]]'><input type="hidden" name="_yx" value="S"><input id="q" name="q" value="x"></form>`);
    fire($("q"), "input");
    await wait(30);
    expect(posts.map((p) => p.body)).toEqual([{ _yx: "S", q: "x", _yxh0: "f" }]);
  });

  it("every Ns polls while the element is on the page and the tab is visible", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { posts } = stubFetch();
    show(act("every 1s"));
    vi.advanceTimersByTime(999);
    await flush();
    expect(posts).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await flush();
    expect(posts).toHaveLength(1);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    vi.advanceTimersByTime(3000);
    await flush();
    expect(posts).toHaveLength(1);
    visibility.mockReturnValue("visible");
    vi.advanceTimersByTime(1000);
    await flush();
    expect(posts).toHaveLength(2);
    $("a").remove();
    vi.advanceTimersByTime(5000);
    await flush();
    expect(posts).toHaveLength(2);
  });

  it("every polls no faster than every 250ms", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { posts } = stubFetch();
    show(act("every 10ms"));
    vi.advanceTimersByTime(240);
    await flush();
    expect(posts).toHaveLength(0);
    vi.advanceTimersByTime(10);
    await flush();
    expect(posts).toHaveLength(1);
  });

  it("re-wiring after a morph doesn't add a second poller", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { posts } = stubFetch();
    show(act("every 1s"));
    applied();
    applied();
    vi.advanceTimersByTime(1000);
    await flush();
    expect(posts).toHaveLength(1);
  });
});

describe("triggers changed by a morph", () => {
  it("a trigger removed by a morph stops firing", async () => {
    const { posts } = stubFetch();
    show(act("click"));
    $("a").removeAttribute("data-yx-trigger");
    applied();
    $("a").click();
    await flush();
    expect(posts).toEqual([]);
  });

  it("a trigger changed to another event fires on the new one, not the old", async () => {
    const { posts } = stubFetch();
    show(act("click"));
    $("a").setAttribute("data-yx-trigger", "dblclick");
    applied();
    $("a").click();
    fire($("a"), "dblclick");
    await flush();
    expect(posts).toHaveLength(1);
  });

  it("a debounce changed by a morph uses the new delay", async () => {
    const { posts } = stubFetch();
    show(`<input id="a" data-yx-action="/act" data-yx-token="T" data-yx-trigger="input 200ms">`);
    $("a").setAttribute("data-yx-trigger", "input 10ms");
    applied();
    fire($("a"), "input");
    await wait(40);
    expect(posts).toHaveLength(1);
  });

  it("a poller changed into a click trigger stops polling", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { posts } = stubFetch();
    show(act("every 1s"));
    $("a").setAttribute("data-yx-trigger", "click");
    applied();
    vi.advanceTimersByTime(3000);
    await flush();
    expect(posts).toHaveLength(0);
    $("a").click();
    await flush();
    expect(posts).toHaveLength(1);
  });

  it("a poller whose period changes polls at the new period only", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { posts } = stubFetch();
    show(act("every 1s"));
    $("a").setAttribute("data-yx-trigger", "every 5s");
    applied();
    vi.advanceTimersByTime(4999);
    await flush();
    expect(posts).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await flush();
    expect(posts).toHaveLength(1);
  });

  it("changed back again, the original trigger works once more", async () => {
    const { posts } = stubFetch();
    show(act("click"));
    $("a").setAttribute("data-yx-trigger", "dblclick");
    applied();
    $("a").setAttribute("data-yx-trigger", "click");
    applied();
    $("a").click();
    await flush();
    expect(posts).toHaveLength(1);
  });
});

describe("drag and drop", () => {
  const drag = (type: string, target: Element, transfer?: object, init: Record<string, unknown> = {}) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    if (transfer) Object.defineProperty(event, "dataTransfer", { value: transfer });
    for (const [k, v] of Object.entries(init)) Object.defineProperty(event, k, { value: v });
    target.dispatchEvent(event);
    return event;
  };
  const files = (list: File[]) => ({ types: ["Files"], items: [], files: list });

  it("an invalid drop selector accepts nothing instead of throwing", async () => {
    const { posts } = stubFetch();
    show(`<div id="t" data-yx-action="/b" data-yx-token="T" data-yx-trigger="drop:[[bad"></div><i id="c" draggable="true">c</i>`);
    drag("dragstart", $("c"));
    expect(drag("dragover", $("t")).defaultPrevented).toBe(false);
    drag("drop", $("t"));
    await flush();
    expect(posts).toEqual([]);
  });

  it("a draggable without draggable=true isn't a drag source", async () => {
    const { posts } = stubFetch();
    show(`<div id="t" data-yx-action="/b" data-yx-token="T" data-yx-trigger="drop"></div><i id="c" draggable="false">c</i>`);
    drag("dragstart", $("c"));
    expect($("c").hasAttribute("data-yx-dragging")).toBe(false);
    drag("drop", $("t"));
    await flush();
    expect(posts).toEqual([]);
  });

  it("a drag that starts on a child of a draggable drags the draggable", async () => {
    const { posts } = stubFetch();
    show(`<div id="t" data-yx-action="/b" data-yx-token="T" data-yx-trigger="drop" data-yx-holes='[["drag","id"]]'></div><li id="card" draggable="true"><b id="handle">h</b></li>`);
    drag("dragstart", $("handle"));
    expect($("card").hasAttribute("data-yx-dragging")).toBe(true);
    drag("drop", $("t"));
    await flush();
    expect(posts.map((p) => p.body)).toEqual([{ _yx: "T", _yxh0: "card" }]);
  });

  it("no target accepts a draggable onto something inside itself", async () => {
    const { posts } = stubFetch();
    show(`<li id="card" draggable="true"><div id="inner" data-yx-action="/b" data-yx-token="T" data-yx-trigger="drop"></div></li>`);
    drag("dragstart", $("card"));
    expect(drag("dragover", $("inner")).defaultPrevented).toBe(false);
    drag("drop", $("inner"));
    await flush();
    expect(posts).toEqual([]);
  });

  it("over marks move with the drag and clear when it leaves the window", () => {
    stubFetch();
    show(`<div id="t1" data-yx-action="/b" data-yx-token="T" data-yx-trigger="drop"></div><div id="t2" data-yx-action="/b" data-yx-token="T" data-yx-trigger="drop"></div><i id="c" draggable="true">c</i>`);
    drag("dragstart", $("c"));
    drag("dragover", $("t1"));
    drag("dragover", $("t2"));
    expect([$("t1").hasAttribute("data-yx-over"), $("t2").hasAttribute("data-yx-over")]).toEqual([false, true]);
    drag("dragleave", document.body, undefined, { relatedTarget: null, clientX: -1, clientY: 10 });
    expect(document.querySelector("[data-yx-over]")).toBeNull();
    drag("dragover", $("t1"));
    drag("dragleave", $("t1"), undefined, { relatedTarget: $("t2"), clientX: 50, clientY: 50 });
    expect($("t1").hasAttribute("data-yx-over")).toBe(true);
    drag("dragend", $("c"));
    expect(document.querySelector("[data-yx-over], [data-yx-dragging]")).toBeNull();
  });

  it("a drag looks the page up once, not on every dragover, and touches [data-yx-over] only when the target changes", () => {
    stubFetch();
    show(`<div id="z" data-yx-drop-to="#in"></div><input id="in" type="file" accept="image/*"><p id="p">p</p>`);
    const query = vi.spyOn(document, "querySelector");
    const queryAll = vi.spyOn(document, "querySelectorAll");
    const set = vi.spyOn(Element.prototype, "setAttribute");
    const transfer = files([]);
    drag("dragenter", $("p"), transfer, { relatedTarget: null });
    for (let i = 0; i < 5; i++) drag("dragover", $("z"), transfer);
    expect($("z").hasAttribute("data-yx-over")).toBe(true);
    for (let i = 0; i < 5; i++) drag("dragover", $("p"), transfer);
    expect($("z").hasAttribute("data-yx-over")).toBe(false);
    // The zone's input (for its accept list) and whether the page takes files anywhere: once each.
    expect(query).toHaveBeenCalledTimes(2);
    expect(queryAll).not.toHaveBeenCalled();
    expect(set.mock.calls.filter(([name]) => name === "data-yx-over")).toHaveLength(1);
    drag("drop", $("p"), transfer);
  });

  it("a mark a morph took off mid-drag is put back", () => {
    stubFetch();
    show(`<div id="t" data-yx-action="/b" data-yx-token="T" data-yx-trigger="drop"></div><i id="c" draggable="true">c</i>`);
    drag("dragstart", $("c"));
    drag("dragover", $("t"));
    $("t").removeAttribute("data-yx-over");
    drag("dragover", $("t"));
    expect($("t").hasAttribute("data-yx-over")).toBe(true);
    drag("dragend", $("c"));
    expect($("t").hasAttribute("data-yx-over")).toBe(false);
  });

  it.each([
    ["image/*", "a.png", "image/png", true],
    ["image/*", "a.pdf", "application/pdf", false],
    [".PDF", "report.pdf", "application/pdf", true],
    [".pdf", "REPORT.PDF", "", true],
    [" image/png , .txt ", "n.txt", "text/plain", true],
    ["image/png", "a.PNG", "IMAGE/PNG", true],
    ["", "anything.bin", "application/octet-stream", true],
    [",,", "a.png", "image/png", false],
  ])("accept=%j takes %s (%s): %s", async (accept, name, type, taken) => {
    const { posts } = stubFetch();
    show(`<div id="z" data-yx-action="/up" data-yx-token="UP" data-yx-trigger="drop:files" accept="${accept}"></div>`);
    drag("drop", $("z"), files([new File(["x"], name, { type })]));
    await flush();
    expect(posts.map((p) => p.body.files ?? null)).toEqual(taken ? [`file:${name}`] : []);
  });

  it("a file drop's holes are read from the zone too", async () => {
    const { posts } = stubFetch();
    show(`<div id="z" data-folder="7" data-yx-action="/up" data-yx-token="UP" data-yx-trigger="drop:files" data-yx-holes='[["el","dataset","folder"]]'></div>`);
    drag("drop", $("z"), files([new File(["x"], "a.txt")]));
    await flush();
    expect(posts.map((p) => p.body)).toEqual([{ _yx: "UP", _yxh0: "7", files: "file:a.txt" }]);
  });

  it("a page drop whose action reads drag.* with nothing dragged posts nothing", async () => {
    const { posts } = stubFetch();
    show(`<div id="t" data-yx-action="/b" data-yx-token="T" data-yx-trigger="click" data-yx-holes='[["drag","dataset","id"]]'></div>`);
    $("t").click();
    await flush();
    expect(posts).toEqual([]);
  });

  it("dropTo with a selector that isn't a file input says so and stages nothing", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    show(`<input id="text" name="t"><div id="z" data-yx-drop-to="#text">Drop</div><div id="z2" data-yx-drop-to="[[bad">Drop</div>`);
    drag("drop", $("z"), files([new File(["x"], "a.txt")]));
    drag("drop", $("z2"), files([new File(["x"], "a.txt")]));
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("a dropTo zone counts files staged into an input that has its own change trigger", () => {
    stubFetch();
    show(`<form><input id="p" type="file" name="p" multiple data-yx-action="/up" data-yx-token="T" data-yx-trigger="change"><div id="z" data-yx-drop-to="#p">Drop</div></form>`);
    drag("drop", $("z"), files([new File(["x"], "a.txt"), new File(["y"], "b.txt")]));
    expect($("z").getAttribute("data-yx-files")).toBe("2");
  });

  it("the innermost trigger answers, and the event still bubbles to the page's own listeners", async () => {
    const { posts } = stubFetch();
    show(`<div id="card" data-yx-action="/card" data-yx-token="CARD" data-yx-trigger="click"><button id="b" data-yx-action="/btn" data-yx-token="BTN" data-yx-trigger="click">x</button></div>`);
    let heard = 0;
    const listener = () => heard++;
    document.addEventListener("click", listener);
    $("b").click();
    document.removeEventListener("click", listener);
    await flush();
    expect(posts.map((p) => p.url)).toEqual([expect.stringMatching(/\/btn$/)]);
    expect(heard).toBe(1);
  });

  it("a form reset clears the zone's file count", async () => {
    show(`<form id="f"><input id="p" type="file" name="p" multiple><div id="z" data-yx-drop-to="#p">Drop</div></form>`);
    drag("drop", $("z"), files([new File(["x"], "a.txt"), new File(["y"], "b.txt")]));
    expect($("z").getAttribute("data-yx-files")).toBe("2");
    // happy-dom gap: reset() doesn't empty a file input; do what the browser would.
    $("f").addEventListener("reset", () => (($("p") as HTMLInputElement).files = new DataTransfer().files), { capture: true });
    ($("f") as HTMLFormElement).reset();
    await flush();
    expect(($("p") as HTMLInputElement).files!.length).toBe(0);
    expect($("z").hasAttribute("data-yx-files")).toBe(false);
  });
});
