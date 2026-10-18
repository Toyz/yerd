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

  it("a stale page refreshes itself and says so; the action can then be retried", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push(`${init.method ?? "GET"} ${new URL(String(url), location.href).pathname}`);
      if (init.method === "POST") return new Response("Invalid action signature", { status: 400, headers: { "yx-stale": "1" } });
      return html(`<html><head><title>t</title></head><body><button id="go" data-yx-action="/x" data-yx-token="FRESH" data-yx-trigger="click">go</button></body></html>`);
    }));
    show(`<button id="go" data-yx-action="/x" data-yx-token="OLD" data-yx-trigger="click">go</button>`);
    document.getElementById("go")!.click();
    await flush();
    expect(calls).toEqual(["POST /x", `GET ${location.pathname}`]);
    expect(document.getElementById("go")!.getAttribute("data-yx-token")).toBe("FRESH");
    expect(document.getElementById("yx-notice")?.textContent).toMatch(/out of date/);
  });

  it("says so when the server can't be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    show(`<button id="go" data-yx-action="/x" data-yx-token="T" data-yx-trigger="click">go</button>`);
    document.getElementById("go")!.click();
    await flush();
    expect(document.getElementById("yx-notice")?.textContent).toMatch(/Couldn't reach the server/);
  });

  it("lets the app show notices its own way", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: "Nope" }), { status: 403, headers: { "content-type": "application/json" } }));
    const seen: string[] = [];
    const listener = (e: Event) => {
      e.preventDefault();
      seen.push((e as CustomEvent<{ message: string }>).detail.message);
    };
    document.addEventListener("yx:notice", listener);
    show(`<button id="go" data-yx-action="/x" data-yx-token="T" data-yx-trigger="click">go</button>`);
    document.getElementById("go")!.click();
    await flush();
    document.removeEventListener("yx:notice", listener);
    expect(seen).toEqual(["Nope"]);
    expect(document.getElementById("yx-notice")).toBeNull();
  });

  it("drag and drop: a drop target's action reads the dropped element; the innermost target wins", async () => {
    const fetch = stubFetch(() => new Response(null, { status: 204 }));
    show(`
      <ul id="doing" data-yx-action="/board" data-yx-token="COL" data-yx-trigger="drop" data-yx-holes='[["drag","dataset","id"]]'>
        <li id="c2" data-id="c2" draggable="true" data-yx-action="/board" data-yx-token="CARD" data-yx-trigger="drop" data-yx-holes='[["drag","dataset","id"]]'>two</li>
      </ul>
      <ul id="todo"><li id="c1" data-id="c1" draggable="true">one</li></ul>`);
    const fire = (type: string, target: Element) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    };
    const card = document.getElementById("c1")!;
    fire("dragstart", card);
    expect(card.hasAttribute("data-yx-dragging")).toBe(true);
    const over = fire("dragover", document.getElementById("doing")!);
    expect(over.defaultPrevented).toBe(true);
    expect(document.getElementById("doing")!.hasAttribute("data-yx-over")).toBe(true);
    // Dropped on the card inside the column: only the card's action runs.
    fire("drop", document.getElementById("c2")!);
    fire("dragend", card);
    await flush();
    const posts = fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => Object.fromEntries(new URLSearchParams(String(init!.body))));
    expect(posts).toEqual([{ _yx: "CARD", _yxh0: "c1" }]);
    expect(card.hasAttribute("data-yx-dragging")).toBe(false);
    expect(document.querySelector("[data-yx-over]")).toBeNull();
  });

  it("ignores drops that aren't one of the page's draggables", async () => {
    const fetch = stubFetch(() => new Response(null, { status: 204 }));
    show(`<ul id="doing" data-yx-action="/board" data-yx-token="COL" data-yx-trigger="drop" data-yx-holes='[["drag","dataset","id"]]'></ul>`);
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    document.getElementById("doing")!.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);
    document.getElementById("doing")!.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await flush();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  describe("drag and drop edge cases", () => {
    const drag = (type: string, target: Element, transfer?: object) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      if (transfer) Object.defineProperty(event, "dataTransfer", { value: transfer });
      target.dispatchEvent(event);
      return event;
    };
    const posts = (fetch: ReturnType<typeof stubFetch>) =>
      fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => init!.body);

    it("never drops a card on itself: the drop goes to the column around it", async () => {
      const fetch = stubFetch(() => new Response(null, { status: 204 }));
      show(`<ul id="col" data-yx-action="/b" data-yx-token="COL" data-yx-trigger="drop">
        <li id="c1" draggable="true" data-yx-action="/b" data-yx-token="C1" data-yx-trigger="drop">one</li></ul>`);
      const card = document.getElementById("c1")!;
      drag("dragstart", card);
      drag("dragover", card);
      expect(card.hasAttribute("data-yx-over")).toBe(false);
      expect(document.getElementById("col")!.hasAttribute("data-yx-over")).toBe(true);
      drag("drop", card);
      await flush();
      expect(posts(fetch).map((b) => new URLSearchParams(String(b)).get("_yx"))).toEqual(["COL"]);
    });

    it("drop:<selector> takes only matching draggables", async () => {
      const fetch = stubFetch(() => new Response(null, { status: 204 }));
      show(`<div id="tasks" data-yx-action="/b" data-yx-token="T" data-yx-trigger="drop:.task"></div>
        <i id="note" class="note" draggable="true">n</i><i id="task" class="task" draggable="true">t</i>`);
      drag("dragstart", document.getElementById("note")!);
      expect(drag("dragover", document.getElementById("tasks")!).defaultPrevented).toBe(false);
      drag("drop", document.getElementById("tasks")!);
      drag("dragstart", document.getElementById("task")!);
      expect(drag("dragover", document.getElementById("tasks")!).defaultPrevented).toBe(true);
      drag("drop", document.getElementById("tasks")!);
      await flush();
      expect(posts(fetch)).toHaveLength(1);
    });

    it("files: posts accepted files as multipart, skips folders, says what it refused", async () => {
      const fetch = stubFetch(() => new Response(null, { status: 204 }));
      show(`<div id="zone" data-yx-action="/up" data-yx-token="UP" data-yx-trigger="drop:files" accept="image/*,.txt"></div>`);
      const png = new File(["x"], "cat.png", { type: "image/png" });
      const txt = new File(["y"], "notes.txt", { type: "" });
      const pdf = new File(["z"], "doc.pdf", { type: "application/pdf" });
      const item = (file: File | null, directory = false) => ({
        kind: "file",
        type: file?.type ?? "",
        getAsFile: () => file,
        webkitGetAsEntry: () => ({ isDirectory: directory }),
      });
      const transfer = { types: ["Files"], items: [item(png), item(txt), item(pdf), item(new File([], "folder"), true)], files: [] };
      expect(drag("dragover", document.getElementById("zone")!, transfer).defaultPrevented).toBe(true);
      drag("drop", document.getElementById("zone")!, transfer);
      await flush();
      const [body] = posts(fetch) as FormData[];
      expect(body).toBeInstanceOf(FormData);
      expect(body!.get("_yx")).toBe("UP");
      expect((body!.getAll("files") as File[]).map((f) => f.name)).toEqual(["cat.png", "notes.txt"]);
      expect(document.getElementById("yx-notice")?.textContent).toMatch(/1 file skipped/);
      expect((fetch.mock.calls[0]![1]!.headers as Record<string, string>)["content-type"]).toBeUndefined();
    });

    it("files: nothing acceptable is refused outright", async () => {
      const fetch = stubFetch(() => new Response(null, { status: 204 }));
      show(`<div id="zone" data-yx-action="/up" data-yx-token="UP" data-yx-trigger="drop:files" accept="image/*"></div>`);
      const pdf = new File(["z"], "doc.pdf", { type: "application/pdf" });
      drag("drop", document.getElementById("zone")!, { types: ["Files"], items: [], files: [pdf] });
      await flush();
      expect(posts(fetch)).toHaveLength(0);
      expect(document.getElementById("yx-notice")?.textContent).toMatch(/can't be dropped here/);
    });

    it("a missed file drop doesn't open the file while the page takes files; otherwise it's the browser's", () => {
      const transfer = { types: ["Files"], items: [], files: [] };
      show(`<p id="text">x</p>`);
      expect(drag("drop", document.getElementById("text")!, transfer).defaultPrevented).toBe(false);
      show(`<p id="text">x</p><div data-yx-action="/up" data-yx-token="UP" data-yx-trigger="drop:files"></div>`);
      expect(drag("dragover", document.getElementById("text")!, transfer).defaultPrevented).toBe(true);
      expect(drag("drop", document.getElementById("text")!, transfer).defaultPrevented).toBe(true);
    });

    it("page drops don't accept files, file zones don't accept cards", () => {
      show(`<ul id="col" data-yx-action="/b" data-yx-token="C" data-yx-trigger="drop"></ul>
        <div id="zone" data-yx-action="/up" data-yx-token="UP" data-yx-trigger="drop:files"></div><i id="card" draggable="true">c</i>`);
      drag("dragover", document.getElementById("col")!, { types: ["Files"], items: [], files: [] });
      expect(document.getElementById("col")!.hasAttribute("data-yx-over")).toBe(false);
      drag("dragstart", document.getElementById("card")!);
      expect(drag("dragover", document.getElementById("zone")!).defaultPrevented).toBe(false);
      drag("dragend", document.getElementById("card")!);
    });

    it("a dragged element morphed away mid-drag drops nothing and leaves no marks", async () => {
      const fetch = stubFetch(() => new Response(null, { status: 204 }));
      show(`<ul id="col" data-yx-action="/b" data-yx-token="C" data-yx-trigger="drop" data-yx-holes='[["drag","dataset","id"]]'></ul><i id="card" data-id="c" draggable="true">c</i>`);
      drag("dragstart", document.getElementById("card")!);
      drag("dragover", document.getElementById("col")!);
      document.getElementById("card")!.remove();
      drag("drop", document.getElementById("col")!);
      await flush();
      expect(posts(fetch)).toHaveLength(0);
      expect(document.querySelector("[data-yx-over]")).toBeNull();
    });

    it("dropTo stages files in a form's file input, adding to what's there, for the form to upload", async () => {
      const fetch = stubFetch(() => new Response(null, { status: 204 }));
      show(`<form><input id="photos" type="file" name="photos" multiple accept="image/*"><div id="zone" data-yx-drop-to="#photos">Drop</div></form>`);
      const input = document.getElementById("photos") as HTMLInputElement;
      const changes: number[] = [];
      input.addEventListener("change", () => changes.push(input.files!.length));
      const files = (...names: string[]) => names.map((n) => new File([n], n, { type: n.endsWith(".png") ? "image/png" : "text/plain" }));
      const [a, b] = files("a.png", "b.png");
      drag("drop", document.getElementById("zone")!, { types: ["Files"], items: [], files: [a, b] });
      drag("drop", document.getElementById("zone")!, { types: ["Files"], items: [], files: [b, ...files("c.png", "notes.txt")] });
      expect([...input.files!].map((f) => f.name)).toEqual(["a.png", "b.png", "c.png"]);
      expect(changes).toEqual([2, 3]);
      expect(document.getElementById("zone")!.getAttribute("data-yx-files")).toBe("3");
      expect(document.getElementById("yx-notice")?.textContent).toMatch(/1 file skipped/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("dropTo a single-file input keeps one", () => {
      show(`<form><input id="avatar" type="file" name="avatar"><div id="zone" data-yx-drop-to="#avatar">Drop</div></form>`);
      const two = [new File(["1"], "1.png"), new File(["2"], "2.png")];
      drag("drop", document.getElementById("zone")!, { types: ["Files"], items: [], files: two });
      expect([...(document.getElementById("avatar") as HTMLInputElement).files!].map((f) => f.name)).toEqual(["1.png"]);
      expect(document.getElementById("yx-notice")?.textContent).toMatch(/Only one file/);
    });

  });

  describe("validation errors", () => {
    function issuesResponse(issues: Array<{ path: string; message: string }>) {
      return new Response(JSON.stringify({ error: "Validation failed", issues }), { status: 400, headers: { "content-type": "application/json" } });
    }

    it("go to their field's box, mark the field, focus the first, and label the rest", async () => {
      stubFetch(() => issuesResponse([
        { path: "title", message: "Can't be empty" },
        { path: "price", message: "Must be from 1 to 100 (got 0)" },
        { path: "tags", message: "Must be at most 3 items (got 5)" },
        { path: "(root)", message: "Something about the whole thing" },
      ]));
      show(`<form id="f" action="/p" method="post" data-yx>
        <label for="title">Title *</label><input id="title" name="title"><span data-yx-error="title"></span>
        <label>Price <input name="price"></label>
        <input name="tags">
        <p data-yx-error role="alert"></p><button>Save</button></form>`);
      document.querySelector<HTMLButtonElement>("#f button")!.click();
      await flush();
      expect(document.querySelector('[data-yx-error="title"]')!.textContent).toBe("Can't be empty");
      expect(document.querySelector("[data-yx-error=''], p[data-yx-error]")!.textContent).toBe(
        "Price: Must be from 1 to 100 (got 0). tags: Must be at most 3 items (got 5). Something about the whole thing",
      );
      for (const name of ["title", "price", "tags"]) expect(document.querySelector(`[name=${name}]`)!.getAttribute("aria-invalid")).toBe("true");
      expect(document.activeElement).toBe(document.getElementById("title"));
    });

    it("are cleared on the next submit", async () => {
      let fail = true;
      stubFetch(() => (fail ? issuesResponse([{ path: "title", message: "Can't be empty" }]) : new Response(null, { status: 204 })));
      show(`<form id="f" action="/p" method="post" data-yx><input name="title"><span data-yx-error="title"></span><p data-yx-error></p><button>Save</button></form>`);
      const button = document.querySelector<HTMLButtonElement>("#f button")!;
      button.click();
      await flush();
      fail = false;
      button.click();
      await flush();
      expect(document.querySelector('[data-yx-error="title"]')!.textContent).toBe("");
      expect(document.querySelector("[name=title]")!.hasAttribute("aria-invalid")).toBe(false);
    });

  });

  describe("staleness", () => {
    it("an action's redirect never lands on a page prefetched before it (signing in)", async () => {
      const gets: string[] = [];
      let signedIn = false;
      vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init: RequestInit = {}) => {
        if (init.method === "POST") {
          signedIn = true;
          return new Response(null, { status: 200, headers: { "yx-location": "/home" } });
        }
        gets.push(String(url));
        return html(`<html><head><title>t</title></head><body><nav id="who">${signedIn ? "ada" : "guest"}</nav></body></html>`);
      }));
      show(`<nav id="who">guest</nav><form id="f" action="/login" method="post" data-yx><button>Sign in</button></form>`);
      (window as unknown as { yerd: { prefetch(url: string): void } }).yerd.prefetch("/home");
      await flush();
      document.querySelector<HTMLButtonElement>("#f button")!.click();
      await flush();
      expect(gets).toHaveLength(2);
      expect(document.getElementById("who")!.textContent).toBe("ada");
    });

    it("a page restored by Back/Forward from the browser's memory is fetched fresh", async () => {
      const fetch = stubFetch(() => html(`<html><head><title>t</title></head><body><nav id="who">fresh</nav></body></html>`));
      show(`<nav id="who">stale</nav>`);
      const event = new Event("pageshow");
      Object.defineProperty(event, "persisted", { value: true });
      window.dispatchEvent(event);
      await flush();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(document.getElementById("who")!.textContent).toBe("fresh");
    });
  });
});
