// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runtimeSource } from "../../src/client/runtime.js";
import type { YerdClient as Yerd } from "../../src/attributes/attribute.js";


let yerd: Yerd;

beforeAll(() => {
  // Run the exact source the server ships.
  new Function(runtimeSource())();
  yerd = (window as unknown as { yerd: Yerd }).yerd;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Let pending fetches and their continuations settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Stub fetch; every call is recorded with its URL and init. */
function stubFetch(handler: Handler = () => html("")) {
  const fn = vi.fn((url: string | URL, init: RequestInit = {}) => Promise.resolve(handler(String(url), init)));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function html(body: string, status = 200): Response {
  return new Response(status === 204 ? null : body, { status, headers: { "content-type": "text/html" } });
}

function header(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

function submitForm(form: HTMLFormElement, submitter?: HTMLElement): SubmitEvent {
  const event = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: submitter ?? null });
  form.dispatchEvent(event);
  return event;
}

function el(html: string): Element {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild!;
}

describe("morph", () => {
  it("patches text and attributes in place", () => {
    document.body.innerHTML = '<div id="a" class="old" title="x"><span>one</span></div>';
    const span = document.querySelector("span")!;
    yerd.page.morph(document.getElementById("a")!, el('<div id="a" class="new"><span>two</span></div>'));
    const div = document.getElementById("a")!;
    expect(div.outerHTML).toBe('<div id="a" class="new"><span>two</span></div>');
    expect(document.querySelector("span")).toBe(span);
  });

  it("reorders keyed children without recreating them", () => {
    document.body.innerHTML = '<ul id="l"><li data-key="1">1</li><li data-key="2">2</li><li data-key="3">3</li></ul>';
    const [one, two, three] = Array.from(document.querySelectorAll("li"));
    yerd.page.morph(document.getElementById("l")!, el('<ul id="l"><li data-key="3">3</li><li data-key="1">1!</li></ul>'));
    const after = Array.from(document.querySelectorAll("li"));
    expect(after.map((li) => li.textContent)).toEqual(["3", "1!"]);
    expect(after[0]).toBe(three);
    expect(after[1]).toBe(one);
    expect(two!.isConnected).toBe(false);
  });

  it("inserts and removes unkeyed children", () => {
    document.body.innerHTML = '<div id="d"><p>a</p><p>b</p><p>c</p></div>';
    yerd.page.morph(document.getElementById("d")!, el('<div id="d"><p>a</p><em>new</em></div>'));
    expect(document.getElementById("d")!.innerHTML).toBe('<p>a</p><em data-yx-new="">new</em>');
  });

  it("marks only inserted elements with data-yx-new, and drops the mark on the next morph", () => {
    document.body.innerHTML = '<ul id="n"><li data-key="a">a</li></ul>';
    yerd.page.morph(document.getElementById("n")!, el('<ul id="n"><li data-key="a">a</li><li data-key="b">b</li></ul>'));
    const [a, b] = Array.from(document.querySelectorAll("li"));
    expect(a!.hasAttribute("data-yx-new")).toBe(false);
    expect(b!.hasAttribute("data-yx-new")).toBe(true);
    yerd.page.morph(document.getElementById("n")!, el('<ul id="n"><li data-key="a">a</li><li data-key="b">b!</li></ul>'));
    expect(b!.hasAttribute("data-yx-new")).toBe(false);
  });

  it("keeps a focused input's value and the input itself", () => {
    document.body.innerHTML = '<form id="f"><input name="t" value="server"></form>';
    const input = document.querySelector("input")!;
    input.focus();
    input.value = "typing...";
    yerd.page.morph(document.getElementById("f")!, el('<form id="f" class="busy"><input name="t" value="server"></form>'));
    expect(document.querySelector("input")).toBe(input);
    expect(input.value).toBe("typing...");
    expect(document.activeElement).toBe(input);
  });

  it("syncs checkboxes and unfocused values from the server", () => {
    document.body.innerHTML = '<div id="c"><input type="checkbox"><input name="n" value="1"></div>';
    yerd.page.morph(document.getElementById("c")!, el('<div id="c"><input type="checkbox" checked><input name="n" value="2"></div>'));
    const [box, text] = Array.from(document.querySelectorAll("input"));
    expect(box!.checked).toBe(true);
    expect(text!.value).toBe("2");
  });

  it("leaves an open <details> open", () => {
    document.body.innerHTML = '<div id="w"><details><summary>s</summary>x</details></div>';
    document.querySelector("details")!.open = true;
    yerd.page.morph(document.getElementById("w")!, el('<div id="w"><details><summary>s</summary>y</details></div>'));
    expect(document.querySelector("details")!.open).toBe(true);
  });
});

describe("apply", () => {
  it("morphs every region in a response into the page by id", () => {
    document.body.innerHTML = '<header><span id="count" data-yx-region>1 left</span></header><ul id="list" data-yx-region><li>a</li></ul><p id="other">untouched</p>';
    const n = yerd.page.apply('<ul id="list" data-yx-region><li>a</li><li>b</li></ul><span id="count" data-yx-region>2 left</span><p id="other">changed?</p>');
    expect(n).toBe(2);
    expect(document.getElementById("count")!.textContent).toBe("2 left");
    expect(document.querySelectorAll("#list li")).toHaveLength(2);
    expect(document.getElementById("other")!.textContent).toBe("untouched");
  });
});

describe("morph and user input", () => {
  it("keeps what the user typed into an unfocused field unless the server changed it", () => {
    document.body.innerHTML = '<div id="u"><input name="a" value="x"><input name="b" value="x"><textarea name="c">x</textarea></div>';
    const [a, b] = Array.from(document.querySelectorAll("input"));
    const c = document.querySelector("textarea")!;
    a!.value = "typed";
    b!.value = "typed";
    c.value = "typed";
    yerd.page.morph(document.getElementById("u")!, el('<div id="u"><input name="a" value="x"><input name="b" value="y"><textarea name="c">x</textarea></div>'));
    expect(a!.value).toBe("typed");
    expect(b!.value).toBe("y");
    expect(c.value).toBe("typed");
    yerd.page.morph(document.getElementById("u")!, el('<div id="u"><input name="a" value="x"><input name="b" value="y"><textarea name="c">z</textarea></div>'));
    expect(c.value).toBe("z");
    expect(c.defaultValue).toBe("z");
  });

  it("leaves file inputs alone", () => {
    document.body.innerHTML = '<div id="f"><input type="file" name="up"></div>';
    const input = document.querySelector("input")!;
    const file = new File(["hi"], "hi.txt");
    input.files = [file] as unknown as FileList;
    yerd.page.morph(document.getElementById("f")!, el('<div id="f" class="x"><input type="file" name="up"></div>'));
    expect(input.files[0]).toBe(file);
  });

  it("syncs a multiple select per option, after its options are patched", () => {
    document.body.innerHTML = '<div id="s"><select multiple name="m"><option value="1">1</option><option value="2">2</option></select></div>';
    yerd.page.morph(
      document.getElementById("s")!,
      el('<div id="s"><select multiple name="m"><option value="1" selected>1</option><option value="2">2</option><option value="3" selected>3</option></select></div>'),
    );
    const options = Array.from(document.querySelectorAll("option"));
    expect(options.map((o) => o.selected)).toEqual([true, false, true]);
  });
});

describe("init guard", () => {
  it("keys the double-init guard on a symbol, not window.yerd", () => {
    const win = window as unknown as Record<string | symbol, unknown>;
    expect(win[Symbol.for("yerd.runtime")]).toBe(true);
    const api = win.yerd;
    delete win.yerd;
    document.body.innerHTML = '<div id="yerd"></div>';
    new Function(runtimeSource())();
    // Guarded: the second run returned before installing anything.
    expect(win.yerd).toBeUndefined();
    win.yerd = api;
  });
});

describe("forms", () => {
  it("reads action and method from attributes, not shadowable properties", async () => {
    const fetch = stubFetch(() => html("", 204));
    document.body.innerHTML = '<form data-yx method="post" action="/act" data-yx-reset><input name="action" value="a"><input name="method" value="m"><input name="reset" value="r"><button>go</button></form>';
    const event = submitForm(document.querySelector("form")!);
    expect(event.defaultPrevented).toBe(true);
    await flush();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(new URL("/act", location.href).href);
    expect(init!.method).toBe("POST");
    expect(String(init!.body)).toBe("action=a&method=m&reset=r");
  });

  it("posts to the current page when the action is empty", async () => {
    const fetch = stubFetch(() => html("", 204));
    document.body.innerHTML = '<form data-yx method="post" action=""><input name="x" value="1"></form>';
    submitForm(document.querySelector("form")!);
    await flush();
    expect(fetch.mock.calls[0]![0]).toBe(location.href);
  });

  it("honors the submitter's formaction and formenctype", async () => {
    const fetch = stubFetch(() => html("", 204));
    document.body.innerHTML = '<form data-yx method="post" action="/a"><input name="x" value="1"><button formaction="/b" formenctype="multipart/form-data">go</button></form>';
    submitForm(document.querySelector("form")!, document.querySelector("button")!);
    await flush();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(new URL("/b", location.href).href);
    expect(init!.body).toBeInstanceOf(FormData);
    expect(header(init!, "content-type")).toBeUndefined();
  });

  it("sends files as multipart instead of dropping them", async () => {
    const fetch = stubFetch(() => html("", 204));
    document.body.innerHTML = '<form data-yx method="post" action="/up"><input name="t" value="1"><input type="file" name="f"></form>';
    const file = new File(["data"], "a.txt");
    document.querySelector<HTMLInputElement>("input[type=file]")!.files = [file] as unknown as FileList;
    submitForm(document.querySelector("form")!);
    await flush();
    const body = fetch.mock.calls[0]![1]!.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect((body.get("f") as File).name).toBe("a.txt");
  });

  it("leaves forms that target another window to the browser", () => {
    const fetch = stubFetch();
    document.body.innerHTML = '<form data-yx method="post" action="/x" target="_blank"><button>go</button></form>';
    const form = document.querySelector("form")!;
    let prevented: boolean | undefined;
    const spy = (event: Event) => {
      prevented = event.defaultPrevented;
      event.preventDefault();
    };
    window.addEventListener("submit", spy);
    submitForm(form);
    window.removeEventListener("submit", spy);
    expect(prevented).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("re-enables only the buttons it disabled", async () => {
    let release!: () => void;
    const pending = new Promise<Response>((resolve) => (release = () => resolve(html("", 204))));
    stubFetch((_url, init) => (init.method === "POST" ? pending : html("")));
    document.body.innerHTML = '<form data-yx method="post" action="/x"><button id="on">a</button><button id="off" disabled>b</button></form>';
    const on = document.getElementById("on") as HTMLButtonElement;
    const off = document.getElementById("off") as HTMLButtonElement;
    submitForm(document.querySelector("form")!);
    expect(on.disabled).toBe(true);
    release();
    await flush();
    expect(on.disabled).toBe(false);
    expect(off.disabled).toBe(true);
  });
});

describe("boosted navigation", () => {
  it("lets the browser handle same-page fragment links", () => {
    const fetch = stubFetch();
    document.body.innerHTML = '<nav data-yx-boost><a href="#sec">a</a><a id="same" href="">b</a></nav>';
    document.querySelector<HTMLAnchorElement>("#same")!.href = `${location.pathname}${location.search}#other`;
    const prevented: boolean[] = [];
    const spy = (event: Event) => {
      prevented.push(event.defaultPrevented);
      event.preventDefault();
    };
    window.addEventListener("click", spy);
    for (const a of Array.from(document.querySelectorAll("a"))) a.click();
    window.removeEventListener("click", spy);
    expect(prevented).toEqual([false, false]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("scrolls to the fragment after loading /page#frag", async () => {
    stubFetch(() => html('<html><body><p>top</p><h2 id="frag">here</h2></body></html>'));
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    await yerd.page.load("/page#frag", true);
    expect(location.pathname).toBe("/page");
    expect(location.hash).toBe("#frag");
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.instances[0]).toBe(document.getElementById("frag"));
  });

  it("ends on the last navigation when an earlier one is slower", async () => {
    let releaseA!: () => void;
    stubFetch((url, init) => {
      if (url.endsWith("/a")) {
        return new Promise<Response>((resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          releaseA = () => resolve(html("<body><p>A</p></body>"));
        });
      }
      return html("<body><p>B</p></body>");
    });
    const assign = vi.spyOn(location, "assign").mockImplementation(() => {});
    const a = yerd.page.load("/a", true);
    const b = yerd.page.load("/b", true);
    await b;
    releaseA();
    await a;
    expect(document.body.textContent).toBe("B");
    expect(location.pathname).toBe("/b");
    expect(assign).not.toHaveBeenCalled();
  });

  it("drops a refresh that was in flight when a navigation started", async () => {
    let releaseRefresh!: () => void;
    let calls = 0;
    stubFetch(() => {
      calls++;
      if (calls === 1) return new Promise<Response>((resolve) => (releaseRefresh = () => resolve(html('<div id="r" data-yx-region>stale</div>'))));
      return html('<body><div id="r" data-yx-region>fresh</div></body>');
    });
    document.body.innerHTML = '<div id="r" data-yx-region>old</div>';
    const refresh = yerd.page.refresh();
    await yerd.page.load("/next", true);
    releaseRefresh();
    await refresh;
    expect(document.getElementById("r")!.textContent).toBe("fresh");
  });

  it("ignores popstate entries it didn't make, and fragment-only moves", async () => {
    const fetch = stubFetch(() => html("<body></body>"));
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    window.dispatchEvent(new PopStateEvent("popstate", { state: { other: 1 } }));
    history.replaceState({ yx: true }, "", `${location.pathname}#elsewhere`);
    window.dispatchEvent(new PopStateEvent("popstate", { state: { yx: true } }));
    expect(fetch).not.toHaveBeenCalled();
    history.replaceState({ yx: true }, "", "/back-here");
    window.dispatchEvent(new PopStateEvent("popstate", { state: { yx: true } }));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses to morph in a cross-origin page", async () => {
    const fetch = stubFetch();
    const assign = vi.spyOn(location, "assign").mockImplementation(() => {});
    await yerd.page.load("https://elsewhere.example/x", true);
    expect(fetch).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith("https://elsewhere.example/x");
  });
});

describe("dynamic parts", () => {
  it("refills skeletons whenever a morph brings them back, without looping", async () => {
    let real = true;
    const fetch = stubFetch((_url, init) => {
      if (header(init, "yx-dynamic")) return html(real ? '<div id="d" data-yx-region>real</div>' : '<div id="d" data-yx-region data-yx-defer>loading</div>');
      return html("");
    });
    const skeleton = '<div id="d" data-yx-region data-yx-defer>loading</div>';
    document.body.innerHTML = '<div id="d" data-yx-region>x</div>';
    yerd.page.apply(skeleton);
    await flush();
    expect(document.getElementById("d")!.textContent).toBe("real");
    expect(document.getElementById("d")!.hasAttribute("data-yx-defer")).toBe(false);

    // A refresh (or Back) morphs the skeleton back in: fill it again.
    yerd.page.apply(skeleton);
    await flush();
    expect(document.getElementById("d")!.textContent).toBe("real");
    expect(fetch).toHaveBeenCalledTimes(2);

    // The server answers with the skeleton: one request, then no more.
    real = false;
    yerd.page.apply(skeleton);
    await flush();
    yerd.page.apply(skeleton);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("live", () => {
  class FakeSource {
    static all: FakeSource[] = [];
    readyState = 0;
    closed = false;
    onmessage: (() => void) | null = null;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      FakeSource.all.push(this);
    }
    close(): void {
      this.closed = true;
      this.readyState = 2;
    }
  }

  it("closes sources whose element is gone", () => {
    FakeSource.all = [];
    vi.stubGlobal("EventSource", FakeSource);
    stubFetch();
    document.body.innerHTML = '<div id="l" data-yx-region><span data-yx-live="/live/a"></span></div>';
    yerd.page.apply("");
    expect(FakeSource.all.map((s) => s.url)).toEqual(["/live/a"]);
    yerd.page.apply('<div id="l" data-yx-region></div>');
    expect(FakeSource.all[0]!.closed).toBe(true);
    // Back on the page: a new source.
    yerd.page.apply('<div id="l" data-yx-region><span data-yx-live="/live/a"></span></div>');
    expect(FakeSource.all).toHaveLength(2);
    yerd.page.apply('<div id="l" data-yx-region></div>');
  });

  it("refreshes after a reconnect and reopens a source the browser gave up on", async () => {
    FakeSource.all = [];
    vi.stubGlobal("EventSource", FakeSource);
    const fetch = stubFetch();
    document.body.innerHTML = '<div id="l" data-yx-region><span data-yx-live="/live/b"></span></div>';
    yerd.page.apply("");
    const source = FakeSource.all[0]!;
    source.onopen!();
    expect(fetch).not.toHaveBeenCalled();
    source.onerror!();
    source.onopen!();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    source.readyState = 2;
    source.onerror!();
    expect(FakeSource.all).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(FakeSource.all).toHaveLength(2);
    vi.useRealTimers();
    yerd.page.apply('<div id="l" data-yx-region></div>');
    expect(FakeSource.all[1]!.closed).toBe(true);
  });

  it("starts its backoff over once a reopened source connects", async () => {
    FakeSource.all = [];
    vi.stubGlobal("EventSource", FakeSource);
    stubFetch();
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="l" data-yx-region><span data-yx-live="/live/c"></span></div>';
    yerd.page.apply("");
    const giveUp = () => {
      const source = FakeSource.all.at(-1)!;
      source.readyState = 2;
      source.onerror!();
    };
    giveUp();
    vi.advanceTimersByTime(1000);
    expect(FakeSource.all).toHaveLength(2);
    giveUp();
    vi.advanceTimersByTime(1999);
    expect(FakeSource.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSource.all).toHaveLength(3);
    // This one connects (and refreshes, having missed messages): the next
    // outage waits 1s again, not 4s, however many restarts came before.
    FakeSource.all.at(-1)!.onopen!();
    giveUp();
    vi.advanceTimersByTime(1000);
    expect(FakeSource.all).toHaveLength(4);
    vi.useRealTimers();
    yerd.page.apply('<div id="l" data-yx-region></div>');
    expect(FakeSource.all[3]!.closed).toBe(true);
    await flush();
  });

  it("logs a refresh the server can't be reached for, instead of rejecting unhandled", async () => {
    FakeSource.all = [];
    vi.stubGlobal("EventSource", FakeSource);
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    document.body.innerHTML = '<div id="l" data-yx-region><span data-yx-live="/live/d"></span></div>';
    yerd.page.apply("");
    const source = FakeSource.all[0]!;
    source.onmessage!();
    source.onerror!();
    source.onopen!();
    await flush();
    expect(log).toHaveBeenCalledWith("[yerd] couldn't refresh the page", expect.any(TypeError));
    yerd.page.apply('<div id="l" data-yx-region></div>');
  });
});
