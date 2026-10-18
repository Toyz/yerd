// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { runtimeSource } from "../../src/client/runtime.js";

// An action that started the visitor's session answers with yx-rebind: the
// page's other forms still carry unbound tokens, so the runtime fetches the
// page and takes just its tokens, matched by what each token is for. Nothing
// else on the page changes.
const token = (payload: object, sig: string) => `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
const add = (sig: string, e: number) => token({ c: "Shop", a: "add", p: { id: 1 }, e }, sig);
const other = (sig: string, e: number) => token({ c: "Shop", a: "search", p: {}, e }, sig);
const remove = (sig: string, e: number, id: number) => token({ c: "Shop", a: "remove", p: { id }, e }, sig);
const calls: string[] = [];

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(() => {
  document.body.innerHTML = `
    <div id="toast" data-yx-region></div>
    <button id="add" data-yx-action="/shop" data-yx-token="${add("old", 1)}" data-yx-trigger="click">add</button>
    <form id="search" action="/shop" method="post" data-yx><input type="hidden" name="_yx" value="${other("old", 1)}"><input id="q" name="q"></form>
    <form><button id="rm2" formaction="/shop" formmethod="post" name="_yx" value="${remove("old", 1, 2)}">x</button>
    <button id="rm3" formaction="/shop" formmethod="post" name="_yx" value="${remove("old", 1, 3)}">x</button></form>
    <button id="gone" data-yx-action="/shop" data-yx-token="${token({ c: "Shop", a: "gone", p: {}, e: 1 }, "old")}">gone</button>`;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit = {}) => {
      calls.push(init.method === "POST" ? "action" : "page");
      if (init.method === "POST") {
        return new Response(`<div id="toast" data-yx-region><p>Added to your cart</p></div>`, { headers: { "content-type": "text/html", "yx-rebind": "1" } });
      }
      // The fresh page: the same forms, bound to the new session, in another order, and an empty toast.
      return new Response(
        `<html><body><div id="toast" data-yx-region></div>
        <form><button formaction="/shop" name="_yx" value="${remove("new", 2, 3)}">x</button><button formaction="/shop" name="_yx" value="${remove("new", 2, 2)}">x</button></form>
        <form action="/shop" method="post" data-yx><input type="hidden" name="_yx" value="${other("new", 2)}"></form>
        <button data-yx-action="/shop" data-yx-token="${add("new", 2)}">add</button></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }),
  );
  new Function(runtimeSource())();
});

describe("yx-rebind", () => {
  it("swaps in the fresh tokens and changes nothing else", async () => {
    (document.getElementById("q") as HTMLInputElement).value = "typed";
    const before = history.length;
    document.getElementById("add")!.click();
    await flush();
    expect(calls).toEqual(["action", "page"]);
    expect(document.getElementById("add")!.getAttribute("data-yx-token")).toBe(add("new", 2));
    expect((document.querySelector('#search input[name="_yx"]') as HTMLInputElement).value).toBe(other("new", 2));
    // Matched by arguments, not by position.
    expect((document.getElementById("rm2") as HTMLButtonElement).value).toBe(remove("new", 2, 2));
    expect((document.getElementById("rm3") as HTMLButtonElement).value).toBe(remove("new", 2, 3));
    // No fresh counterpart: left as it was.
    expect(document.getElementById("gone")!.getAttribute("data-yx-token")).toContain(".old");
    // What the action showed stays; what was typed stays; no history, no notice.
    expect(document.querySelector("#toast p")?.textContent).toBe("Added to your cart");
    expect((document.getElementById("q") as HTMLInputElement).value).toBe("typed");
    expect(history.length).toBe(before);
    expect(document.getElementById("yx-notice")?.textContent ?? "").toBe("");
  });
});
