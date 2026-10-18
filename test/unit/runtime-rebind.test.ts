// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { runtimeSource } from "../../src/client/runtime.js";

// An action that started the visitor's session answers with yx-rebind: the
// page's other forms still carry unbound tokens, so the runtime fetches the
// page again and morphs it in, without a notice, a history entry or a scroll.
const calls: Array<{ url: string; headers: Record<string, string> }> = [];

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(() => {
  document.body.innerHTML = `
    <div id="cart" data-yx-region><p>0 items</p></div>
    <button id="add" data-yx-action="/shop" data-yx-token="old-add" data-yx-trigger="click">add</button>
    <form id="other" action="/shop" method="post" data-yx><input type="hidden" name="_yx" value="old-other"><input id="q" name="q"></form>`;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      calls.push({ url: String(url), headers });
      if (init.method === "POST") {
        return new Response(`<div id="cart" data-yx-region><p>1 item</p></div>`, { headers: { "content-type": "text/html", "yx-rebind": "1" } });
      }
      return new Response(
        `<html><body><div id="cart" data-yx-region><p>1 item</p></div>
        <button id="add" data-yx-action="/shop" data-yx-token="new-add" data-yx-trigger="click">add</button>
        <form id="other" action="/shop" method="post" data-yx><input type="hidden" name="_yx" value="new-other"><input id="q" name="q"></form></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }),
  );
  new Function(runtimeSource())();
});

describe("yx-rebind", () => {
  it("re-fetches the page once and morphs the new tokens in, keeping what's typed", async () => {
    (document.getElementById("q") as HTMLInputElement).value = "typed";
    const before = history.length;
    document.getElementById("add")!.click();
    await flush();
    expect(calls.map((c) => c.headers["yx-boost"] ?? "action")).toEqual(["action", "1"]);
    expect(document.getElementById("add")!.getAttribute("data-yx-token")).toBe("new-add");
    expect((document.querySelector('#other input[name="_yx"]') as HTMLInputElement).value).toBe("new-other");
    expect((document.getElementById("q") as HTMLInputElement).value).toBe("typed");
    expect(document.querySelector("#cart p")!.textContent).toBe("1 item");
    expect(history.length).toBe(before);
    expect(document.getElementById("yx-notice")?.textContent ?? "").toBe("");
  });
});
