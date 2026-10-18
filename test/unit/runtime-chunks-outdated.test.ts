// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { OUTDATED_CHUNK, runtimePieces } from "../../src/client/runtime.js";
import type { Chunk } from "../../src/client/hooks.js";

// A page whose core is from before a deploy: every chunk it asks for comes
// back as the server's "out of date" chunk.
const urls: string[] = [];
const outdatedChunk = new Function(`return ${OUTDATED_CHUNK.replace(/^export default /, "").replace(/;\s*$/, "")}`)() as Chunk;
function importChunk(url: string): Promise<{ default: Chunk }> {
  urls.push(url);
  return Promise.resolve({ default: outdatedChunk });
}
// A plain count: the suite clears mocks between tests, and the reload happens in the first.
let reloads = 0;

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(() => {
  Object.defineProperty(window, "location", { value: { ...window.location, href: window.location.href, reload: () => reloads++ }, configurable: true });
  sessionStorage.clear();
  document.body.innerHTML = `<div data-yx-cue="horn"></div>`;
  (globalThis as Record<string, unknown>).EventSource = class {
    close() {}
  };
  const versions = { cues: "cues-v1", dnd: "dnd-v1", local: "local-v1" };
  new Function("importChunk", `(${runtimePieces().core})("http://localhost/_yerd/", undefined, importChunk, ${JSON.stringify(versions)});`)(importChunk);
});

describe("a chunk from another deploy", () => {
  it("is asked for by the version the core was built with", async () => {
    await flush();
    expect(urls).toEqual(["http://localhost/_yerd/runtime-cues.js?v=cues-v1"]);
  });

  it("reloads the page once", () => {
    expect(reloads).toBe(1);
    expect(Number(sessionStorage.getItem("yerd-outdated"))).toBeGreaterThan(0);
  });

  it("doesn't reload again within a minute; it says so instead", async () => {
    document.body.insertAdjacentHTML("beforeend", `<form><input type="file" id="f"><div data-yx-drop-to="#f"></div></form>`);
    await flush();
    expect(urls.at(-1)).toBe("http://localhost/_yerd/runtime-dnd.js?v=dnd-v1");
    expect(reloads).toBe(1);
    expect(document.getElementById("yx-notice")?.textContent).toBe("This page is out of date. Reload it to keep going.");
  });
});
