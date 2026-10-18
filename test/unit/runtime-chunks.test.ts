// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runtimePieces } from "../../src/client/runtime.js";
import { yerdCues } from "../../src/client/runtime-cues.js";
import { yerdDnd } from "../../src/client/runtime-dnd.js";
import { yerdLocal } from "../../src/client/runtime-local.js";
import type { Chunk } from "../../src/client/hooks.js";
import type { YerdClient } from "../../src/attributes/attribute.js";

// The runtime as the server serves it: the core alone, loading each chunk
// when the page first needs it. The served module passes its own directory
// and import(); here the base is an app mounted under /app/, and the import
// is a stand-in each test resolves when it wants the chunk to arrive.
const BASE = "http://localhost:3000/app/_yerd/";
const CHUNKS: Record<string, Chunk> = { cues: yerdCues, dnd: yerdDnd, local: yerdLocal };
const pending = new Map<string, { resolve(): void; reject(error: Error): void }>();
const urls: string[] = [];
function importChunk(url: string): Promise<{ default: Chunk }> {
  urls.push(url);
  return new Promise((resolve, reject) => {
    const name = /runtime-(\w+)\.js$/.exec(url)![1]!;
    pending.set(name, { resolve: () => resolve({ default: CHUNKS[name]! }), reject });
  });
}
const requested = () => urls.slice();
let yerd: YerdClient;

beforeAll(() => {
  // Cue elements open one; nothing is sent on it here.
  (globalThis as Record<string, unknown>).EventSource = class {
    close() {}
  };
  // On the page before the runtime runs: a <Local> counter and a field whose handler keeps what it saw.
  document.body.innerHTML = `
    <yerd-local data-yx-local='{"n":0,"seen":[]}' data-yx-as="s">
      <button id="plus" data-yx-on-click="() => s.n++">+</button>
      <i id="n" data-yx-text="n">0</i>
      <input id="field" data-yx-on-input="(e) => s.seen.push(e.target.value + '@' + e.currentTarget.id)">
      <b id="seen" data-yx-text="seen"></b>
    </yerd-local>
    <div id="board" data-yx-region></div>`;
  new Function("importChunk", `(${runtimePieces().core})(${JSON.stringify(BASE)}, undefined, importChunk);`)(importChunk);
  yerd = (window as unknown as { yerd: YerdClient }).yerd;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function fire(type: string, target: Element): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("the split runtime", () => {
  it("loads only the chunk the page needs, from beside the runtime (under the app's base)", () => {
    expect(requested()).toEqual([`${BASE}runtime-local.js`]);
    // The public API is the same either way.
    expect(Object.keys(yerd).sort()).toEqual(["attribute", "clock", "net", "page"]);
  });

  it("holds <Local> input until the chunk is in, then replays it in order, with what the field held then", async () => {
    const field = document.getElementById("field") as HTMLInputElement;
    document.getElementById("plus")!.click();
    document.getElementById("plus")!.click();
    field.value = "a";
    fire("input", field);
    field.value = "ab";
    fire("input", field);
    // Nothing runs yet: the server's values stand.
    expect(document.getElementById("n")!.textContent).toBe("0");
    pending.get("local")!.resolve();
    await flush();
    expect(document.getElementById("n")!.textContent).toBe("2");
    expect(document.getElementById("seen")!.textContent).toBe("a@field,ab@field");
    // The live value is left as the user typed it.
    expect(field.value).toBe("ab");
    // From now on the chunk's own listeners answer, once.
    document.getElementById("plus")!.click();
    expect(document.getElementById("n")!.textContent).toBe("3");
    expect(requested().filter((url) => url.endsWith("runtime-local.js"))).toHaveLength(1);
  });

  it("a drag started and dropped before the dnd chunk arrives still posts the drop", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    // An apply brings the board in: the chunk is wanted now.
    yerd.page.apply(`<div id="board" data-yx-region>
      <ul id="col" data-yx-action="/board" data-yx-token="COL" data-yx-trigger="drop" data-yx-holes='[["drag","dataset","id"]]'></ul>
      <li id="card" data-id="c1" draggable="true">card</li></div>`);
    await flush();
    expect(requested()).toContain(`${BASE}runtime-dnd.js`);
    const card = document.getElementById("card")!;
    fire("dragstart", card);
    // Started synchronously by the core.
    expect(card.hasAttribute("data-yx-dragging")).toBe(true);
    // Let through over a target, so the browser will fire the drop at all.
    expect(fire("dragover", document.getElementById("col")!).defaultPrevented).toBe(true);
    expect(fire("drop", document.getElementById("col")!).defaultPrevented).toBe(true);
    fire("dragend", card);
    expect(fetch).not.toHaveBeenCalled();
    pending.get("dnd")!.resolve();
    await flush();
    const posts = (fetch.mock.calls as unknown as Array<[string, RequestInit]>)
      .filter(([, init]) => init.method === "POST")
      .map(([, init]) => Object.fromEntries(new URLSearchParams(String(init.body))));
    expect(posts).toEqual([{ _yx: "COL", _yxh0: "c1" }]);
    expect(card.hasAttribute("data-yx-dragging")).toBe(false);
  });

  it("loads the cues chunk for elements added outside an apply, and it connects them", async () => {
    const fetch = vi.fn(async () => Response.json({ now: Date.now() }));
    vi.stubGlobal("fetch", fetch);
    const spinner = document.createElement("div");
    spinner.setAttribute("data-yx-sync", "");
    document.body.appendChild(spinner);
    await flush();
    expect(requested()).toContain(`${BASE}runtime-cues.js`);
    expect(fetch).not.toHaveBeenCalled();
    pending.get("cues")!.resolve();
    await flush();
    // `sync` measures the server's clock as it connects.
    expect(fetch.mock.calls.map((call) => String((call as unknown[])[0]))).toContain("/_yerd/clock");
  });

  it("loads each chunk once, however often the page changes", async () => {
    yerd.page.apply('<div id="board" data-yx-region><yerd-local data-yx-local="{}"></yerd-local><i data-yx-cue="go"></i><b data-yx-drop-to="#f"></b></div>');
    document.dispatchEvent(new CustomEvent("yx:applied", { detail: { regions: 0 } }));
    await flush();
    expect(requested().sort()).toEqual([`${BASE}runtime-cues.js`, `${BASE}runtime-dnd.js`, `${BASE}runtime-local.js`]);
  });
});
