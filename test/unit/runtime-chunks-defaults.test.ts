// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { runtimePieces } from "../../src/client/runtime.js";
import { yerdLocal } from "../../src/client/runtime-local.js";
import type { Chunk } from "../../src/client/hooks.js";

// Clicks and submits inside <Local> before its chunk has arrived: the core
// holds the browser's default (follow, submit) and the replay decides.
let arrive: () => void = () => {};
function importChunk(): Promise<{ default: Chunk }> {
  return new Promise((resolve) => (arrive = () => resolve({ default: yerdLocal })));
}
// Plain records: the suite clears mocks between tests.
const assigned: string[] = [];
const submitted: string[] = [];

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function click(el: Element): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
}

beforeAll(() => {
  Object.defineProperty(window, "location", {
    value: { ...window.location, href: "http://localhost/", origin: "http://localhost", assign: (url: string) => assigned.push(url) },
    configurable: true,
  });
  document.body.innerHTML = `
    <yerd-local data-yx-local='{"n":0,"sent":0}' data-yx-as="s">
      <a id="stay" href="/elsewhere" data-yx-on-click="(e) => { s.n++; e.preventDefault(); }">stay</a>
      <a id="go" href="/next" data-yx-on-click="() => s.n++">go</a>
      <a id="plain" href="/plain">plain</a>
      <form id="form" data-yx-on-submit="() => s.sent++"><button id="send">send</button></form>
      <i id="n" data-yx-text="n">0</i><i id="sent" data-yx-text="sent">0</i>
    </yerd-local>`;
  // What the browser would do with a submit nobody cancelled: count it.
  document.addEventListener("submit", (event) => {
    if (!event.defaultPrevented) {
      submitted.push((event.target as HTMLFormElement).id);
      event.preventDefault();
    }
  });
  new Function("importChunk", `(${runtimePieces().core})("http://localhost/_yerd/", undefined, importChunk);`)(importChunk);
});

describe("defaults inside <Local> before its chunk", () => {
  it("are held when a handler on the way could cancel them", async () => {
    await flush();
    expect(click(document.getElementById("stay")!).defaultPrevented).toBe(true);
    expect(click(document.getElementById("go")!).defaultPrevented).toBe(true);
    document.getElementById("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    expect(submitted).toEqual([]);
  });

  it("are left alone with no handler on the way", () => {
    expect(click(document.getElementById("plain")!).defaultPrevented).toBe(false);
  });

  it("happen after the replay unless a handler cancelled them, and handlers run once", async () => {
    arrive();
    await flush();
    expect(document.getElementById("n")!.textContent).toBe("2");
    // The cancelled link stays; the other is followed.
    expect(assigned).toEqual([new URL("/next", document.baseURI).href]);
    // The submit handler ran in the replay, not again when the form went.
    expect(document.getElementById("sent")!.textContent).toBe("1");
    expect(submitted).toEqual(["form"]);
  });

  it("once the chunk is in, handlers run live", async () => {
    document.getElementById("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(document.getElementById("sent")!.textContent).toBe("2");
  });
});
