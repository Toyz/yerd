// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runtimePieces } from "../../src/client/runtime.js";
import { yerdDnd } from "../../src/client/runtime-dnd.js";
import type { Chunk } from "../../src/client/hooks.js";
import type { YerdClient } from "../../src/attributes/attribute.js";

// The split runtime on a page with none of the chunked features: it loads
// nothing until a boosted navigation brings some in.
const BASE = "http://localhost:3000/_yerd/";
const urls: string[] = [];
let answer: (url: string) => Promise<{ default: Chunk }> = () => new Promise(() => {});
let yerd: YerdClient;

beforeAll(() => {
  document.body.innerHTML = '<main><a id="go" href="/board" data-yx-boost>Board</a></main>';
  const importChunk = (url: string) => {
    urls.push(url);
    return answer(url);
  };
  new Function("importChunk", `(${runtimePieces().core})(${JSON.stringify(BASE)}, undefined, importChunk);`)(importChunk);
  yerd = (window as unknown as { yerd: YerdClient }).yerd;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function fire(type: string, target: Element, transfer?: object): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  if (transfer) Object.defineProperty(event, "dataTransfer", { value: transfer });
  target.dispatchEvent(event);
  return event;
}

const BOARD = `<!doctype html><html><head><title>Board</title></head><body>
  <ul id="col" data-yx-action="/board" data-yx-token="COL" data-yx-trigger="drop" data-yx-holes='[["drag","dataset","id"]]'></ul>
  <li id="card" data-id="c1" draggable="true">card</li>
  <div id="zone" data-yx-action="/up" data-yx-token="UP" data-yx-trigger="drop:files" accept="image/*"></div>
</body></html>`;

describe("the split runtime, after navigation", () => {
  it("a page without the features downloads no chunk", async () => {
    await flush();
    expect(urls).toEqual([]);
  });

  it("a boosted navigation to a page with a drop target loads the dnd chunk; a failed load is tried again on the next change", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(BOARD, { headers: { "content-type": "text/html" } })));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    answer = () => Promise.reject(new Error("offline"));
    document.getElementById("go")!.click();
    await flush();
    expect(document.getElementById("col")).not.toBeNull();
    expect(urls).toEqual([`${BASE}runtime-dnd.js`]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("couldn't load the runtime's dnd chunk"), expect.any(Error));
    let arrive!: () => void;
    answer = () => new Promise((resolve) => (arrive = () => resolve({ default: yerdDnd })));
    document.dispatchEvent(new CustomEvent("yx:applied", { detail: { regions: 0 } }));
    expect(urls).toEqual([`${BASE}runtime-dnd.js`, `${BASE}runtime-dnd.js`]);

    // A drag that starts now, before the chunk is in, and drops after it arrives.
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const card = document.getElementById("card")!;
    fire("dragstart", card);
    expect(card.hasAttribute("data-yx-dragging")).toBe(true);
    arrive();
    await flush();
    const over = fire("dragover", document.getElementById("col")!);
    expect(over.defaultPrevented).toBe(true);
    // The chunk's own handling now: it marks the target.
    expect(document.getElementById("col")!.hasAttribute("data-yx-over")).toBe(true);
    fire("drop", document.getElementById("col")!);
    fire("dragend", card);
    await flush();
    const posts = (fetch.mock.calls as unknown as Array<[string, RequestInit]>).filter(([, init]) => init.method === "POST");
    expect(posts.map(([, init]) => Object.fromEntries(new URLSearchParams(String(init.body))))).toEqual([{ _yx: "COL", _yxh0: "c1" }]);
    expect(document.querySelector("[data-yx-over], [data-yx-dragging]")).toBeNull();
  });
});
