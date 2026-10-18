// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { runtimePieces, runtimeSource } from "../../src/client/runtime.js";
import { yerdDnd } from "../../src/client/runtime-dnd.js";
import type { Chunk } from "../../src/client/hooks.js";
import { chunkVersion } from "../../src/client/runtime.js";

// Files dropped on the page before the dnd chunk has arrived: their
// DataTransfer can only be read while the drop is dispatched, so the core
// reads the files then and the chunk judges them (accept, staging) later.
let arrive!: () => void;
const urls: string[] = [];

beforeAll(() => {
  document.body.innerHTML = `
    <div id="zone" data-yx-action="/up" data-yx-token="UP" data-yx-trigger="drop:files" accept="image/*"></div>
    <p id="elsewhere">not a target</p>`;
  const importChunk = (url: string) => {
    urls.push(url);
    return new Promise<{ default: Chunk }>((resolve) => (arrive = () => resolve({ default: yerdDnd })));
  };
  new Function("importChunk", `(${runtimePieces().core})("http://localhost:3000/_yerd/", undefined, importChunk);`)(importChunk);
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

describe("a file drop before the dnd chunk", () => {
  it("is held with its files and posted, filtered by accept, once the chunk is in", async () => {
    expect(urls).toEqual(["http://localhost:3000/_yerd/runtime-dnd.js"]);
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const png = new File(["x"], "cat.png", { type: "image/png" });
    const pdf = new File(["z"], "doc.pdf", { type: "application/pdf" });
    const item = (file: File, directory = false) => ({ kind: "file", type: file.type, getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: directory }) });
    let readable = true;
    const transfer = {
      types: ["Files"],
      // Like a browser's: empty once the drop's dispatch is over.
      get items() {
        return readable ? [item(png), item(pdf), item(new File([], "folder"), true)] : [];
      },
      files: [],
    };
    expect(fire("dragover", document.getElementById("zone")!, transfer).defaultPrevented).toBe(true);
    // Let go off target: kept from opening in the tab, as the chunk would.
    expect(fire("drop", document.getElementById("elsewhere")!, transfer).defaultPrevented).toBe(true);
    expect(fire("drop", document.getElementById("zone")!, transfer).defaultPrevented).toBe(true);
    readable = false;
    arrive();
    await flush();
    const posts = (fetch.mock.calls as unknown as Array<[string, RequestInit]>).filter(([, init]) => init.method === "POST");
    expect(posts).toHaveLength(1);
    const body = posts[0]![1].body as FormData;
    expect(body.get("_yx")).toBe("UP");
    expect((body.getAll("files") as File[]).map((f) => f.name)).toEqual(["cat.png"]);
    expect(document.getElementById("yx-notice")?.textContent).toMatch(/1 file skipped/);
  });
});

describe("runtimeSource()", () => {
  it("defaults to one script with every chunk inline, for running without a server", () => {
    const script = runtimeSource();
    expect(script).not.toContain("import.meta");
    expect(script).toContain("yerdLocal");
    expect(() => new Function(script)).not.toThrow();
  });

  it("serves a module that finds its chunks beside itself", () => {
    const module = runtimeSource({ chunks: "split" });
    expect(module.startsWith("(function yerdRuntime")).toBe(true);
    expect(module).toContain('(new URL(".", import.meta.url).href, undefined, (url) => import(url), {');
    // Each chunk's version goes in, for the URL the core asks for.
    expect(module).toContain(`"local":"${chunkVersion("local")}"`);
    // The chunks aren't in it.
    expect(module).not.toContain("function yerdLocal");
    expect(module).not.toContain("yerd-local:");
  });
});
