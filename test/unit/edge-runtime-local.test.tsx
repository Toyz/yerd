// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Local, eq, not, renderToString } from "@toyz/yerd";
import { runtimeSource } from "../../src/client/runtime.js";
import type { YerdClient as Yerd } from "../../src/attributes/attribute.js";

let yerd: Yerd;

beforeAll(() => {
  new Function(runtimeSource())();
  yerd = (window as unknown as { yerd: Yerd }).yerd;
});

afterEach(async () => {
  // Let a test's last save land before its storage is cleared.
  await frame();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  localStorage.clear();
  sessionStorage.clear();
});

const flush = () => new Promise((r) => setTimeout(r, 0));
/** Persisted state is saved once per frame: wait for it. */
const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

async function mount(markup: string): Promise<void> {
  document.body.innerHTML = markup;
  document.dispatchEvent(new CustomEvent("yx:applied", { detail: { regions: 0 } }));
  await flush();
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const texts = (sel: string) => Array.from(document.querySelectorAll(sel), (e) => e.textContent);

/** A scope written by hand, as the server renders one. */
function scope(state: object, inner: string, attrs = "", as = "s"): string {
  return `<yerd-local data-yx-local='${JSON.stringify(state)}' data-yx-as="${as}"${attrs ? " " + attrs : ""}>${inner}</yerd-local>`;
}

describe("handlers", () => {
  it("one handler that doesn't compile is logged; the others still work", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await mount(scope({ n: 0 }, `<button id="bad" data-yx-on-click="() => {{">x</button><button id="ok" data-yx-on-click="() => s.n++">y</button><b data-yx-text="n">0</b>`));
    $("#bad").click();
    $("#ok").click();
    expect(texts("b")).toEqual(["1"]);
    expect(log).toHaveBeenCalledWith("[yerd] a <Local> handler didn't compile:", "() => {{", expect.anything());
  });

  it("a handler that throws still has its changes applied", async () => {
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => {
      errors.push(e.message);
      e.preventDefault();
    };
    window.addEventListener("error", onError);
    await mount(scope({ n: 0 }, `<button id="b" data-yx-on-click="() => { s.n = 5; throw new Error('late') }">x</button><b data-yx-text="n">0</b>`));
    try {
      $("#b").click();
    } catch {
      // happy-dom may rethrow listener errors
    }
    window.removeEventListener("error", onError);
    expect(texts("b")).toEqual(["5"]);
  });

  it("an async handler's later changes are applied when it settles, resolved or rejected", async () => {
    await mount(scope({ n: 0, m: 0 }, `<button id="ok" data-yx-on-click="async () => { await null; s.n = 2 }">x</button><button id="no" data-yx-on-click="async () => { await null; s.m = 3; throw new Error('x') }">y</button><b id="n" data-yx-text="n">0</b><b id="m" data-yx-text="m">0</b>`));
    $("#ok").click();
    $("#no").click();
    expect([$("#n").textContent, $("#m").textContent]).toEqual(["0", "0"]);
    await flush();
    expect([$("#n").textContent, $("#m").textContent]).toEqual(["2", "3"]);
  });

  it("handlers get the event, under the scope's own name", async () => {
    await mount(scope({ last: "" }, `<button id="b" data-k="7" data-yx-on-click="(e) => (state.last = e.currentTarget.dataset.k)">x</button><b data-yx-text="last"></b>`, "", "state"));
    $("#b").click();
    expect(texts("b")).toEqual(["7"]);
  });

  it("handlers run in strict mode and can't see the page's globals by accident through `this`", async () => {
    await mount(scope({ t: "" }, `<button id="b" data-yx-on-click="function () { s.t = String(this) }">x</button><b data-yx-text="t"></b>`));
    $("#b").click();
    // Called as fn(event): `this` is undefined, not window.
    expect(texts("b")).toEqual(["undefined"]);
  });

  it("an event bubbling from a child runs the parent's handler", async () => {
    await mount(scope({ n: 0 }, `<div data-yx-on-click="() => s.n++"><span id="c">c</span></div><b data-yx-text="n">0</b>`));
    $("#c").click();
    expect(texts("b")).toEqual(["1"]);
  });

  it("a handler on the scope element itself works", async () => {
    await mount(`<yerd-local data-yx-local='{"n":0}' data-yx-as="s" data-yx-on-click="() => s.n++"><b data-yx-text="n">0</b></yerd-local>`);
    $("b").click();
    expect(texts("b")).toEqual(["1"]);
  });

  it("a scope with state that isn't JSON is skipped, not fatal", async () => {
    await mount(`<yerd-local data-yx-local="{oops" data-yx-as="s"><button id="x" data-yx-on-click="() => s.n++">x</button></yerd-local>${scope({ n: 0 }, `<button id="ok" data-yx-on-click="() => s.n++">y</button><b data-yx-text="n">0</b>`)}`);
    $("#ok").click();
    expect(texts("b")).toEqual(["1"]);
  });

  it("re-wiring after another morph doesn't add a second listener", async () => {
    await mount(scope({ n: 0 }, `<button id="b" data-yx-on-click="() => s.n++">x</button><b data-yx-text="n">0</b>`));
    document.dispatchEvent(new CustomEvent("yx:applied", { detail: { regions: 0 } }));
    document.dispatchEvent(new CustomEvent("yx:applied", { detail: { regions: 0 } }));
    $("#b").click();
    expect(texts("b")).toEqual(["1"]);
  });

  it("a handler a morph adds to an already wired element is wired", async () => {
    await mount(`<div id="r" data-yx-region>${scope({ n: 0, h: 0 }, `<button id="b" data-yx-on-click="() => s.n++">x</button><b id="n" data-yx-text="n">0</b><b id="h" data-yx-text="h">0</b>`)}</div>`);
    yerd.page.apply(`<div id="r" data-yx-region>${scope({ n: 0, h: 0 }, `<button id="b" data-yx-on-click="() => s.n++" data-yx-on-mouseover="() => s.h++">x</button><b id="n" data-yx-text="n">0</b><b id="h" data-yx-text="h">0</b>`)}</div>`);
    $("#b").dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect($("#h").textContent).toBe("1");
  });

  it("a handler a morph changed runs as it is now", async () => {
    await mount(`<div id="r" data-yx-region>${scope({ n: 0 }, `<button id="b" data-yx-on-click="() => (s.n = 1)">x</button><b data-yx-text="n">0</b>`)}</div>`);
    yerd.page.apply(`<div id="r" data-yx-region>${scope({ n: 0 }, `<button id="b" data-yx-on-click="() => (s.n = 2)">x</button><b data-yx-text="n">0</b>`)}</div>`);
    $("#b").click();
    expect(texts("b")).toEqual(["2"]);
  });

  it("a handler a morph removed stops running", async () => {
    await mount(`<div id="r" data-yx-region>${scope({ n: 0 }, `<button id="b" data-yx-on-click="() => s.n++">x</button><b data-yx-text="n">0</b>`)}</div>`);
    yerd.page.apply(`<div id="r" data-yx-region>${scope({ n: 0 }, `<button id="b">x</button><b data-yx-text="n">0</b>`)}</div>`);
    $("#b").click();
    expect(texts("b")).toEqual(["0"]);
  });
});

describe("bindings", () => {
  it.each([
    [0, "0"],
    [false, "false"],
    [null, ""],
    ["<b>x</b>", "<b>x</b>"],
    [[1, 2], "1,2"],
  ])("text of %j is %j", async (value, expected) => {
    await mount(scope({ v: "start" }, `<button id="b" data-yx-on-click='() => (s.v = ${JSON.stringify(value)})'>x</button><i data-yx-text="v">start</i>`));
    $("#b").click();
    expect($("i").textContent).toBe(expected);
    expect($("i").children).toHaveLength(0);
  });

  it("a missing path, or one through a non-object, reads as empty", async () => {
    await mount(scope({ a: 1 }, `<i id="x" data-yx-text="nope.deeper">?</i><i id="y" data-yx-text="a.b">?</i><button id="b" data-yx-on-click="() => 0">x</button>`));
    $("#b").click();
    expect([$("#x").textContent, $("#y").textContent]).toEqual(["", ""]);
  });

  it("attributes follow the value like the server renders them", async () => {
    await mount(scope({ on: false, label: "a" }, `<button id="t" data-yx-on-click="() => (s.on = !s.on)">t</button><button id="l" data-yx-on-click="() => (s.label = null)">l</button>
      <p id="p" hidden data-yx-bind="hidden:!on;aria-expanded:on;draggable:on;spellcheck:on;contenteditable:on;translate:on;title:label;data-x:on"></p>`));
    const attrs = () => Object.fromEntries(Array.from($("#p").attributes, (a) => [a.name, a.value]).filter(([n]) => n !== "id" && n !== "data-yx-bind"));
    $("#t").click();
    expect(attrs()).toEqual({ "aria-expanded": "true", draggable: "true", spellcheck: "true", contenteditable: "true", translate: "yes", title: "a", "data-x": "" });
    $("#t").click();
    $("#l").click();
    expect(attrs()).toEqual({ hidden: "", "aria-expanded": "false", draggable: "false", spellcheck: "false", contenteditable: "false", translate: "no" });
  });

  it("value and checked bindings set the properties, not just attributes", async () => {
    await mount(scope({ name: "a", ok: false }, `<button id="b" data-yx-on-click="() => { s.name = 'b'; s.ok = true }">x</button>
      <input id="v" data-yx-bind="value:name"><input id="c" type="checkbox" data-yx-bind="checked:ok">`));
    ($("#v") as HTMLInputElement).value = "typed";
    $("#b").click();
    expect(($("#v") as HTMLInputElement).value).toBe("b");
    expect(($("#c") as HTMLInputElement).checked).toBe(true);
  });

  it("class flags toggle without touching other classes", async () => {
    await mount(scope({ on: false }, `<button id="b" class="keep" data-yx-on-click="() => (s.on = !s.on)" data-yx-bind="class.on:on;class.off:!on">x</button>`));
    $("#b").click();
    expect($("#b").className).toBe("keep on");
    $("#b").click();
    expect($("#b").className).toBe("keep off");
  });

  it("a bind entry without a colon is skipped", async () => {
    await mount(scope({ on: true }, `<p id="p" data-yx-bind="garbage;title:on"></p>`));
    expect($("#p").getAttribute("title")).toBe("");
  });

  it("eq() compares strings with ; : = and quotes in them", async () => {
    const html = await renderToString(
      <Local state={{ tab: "a" }}>
        {(s) => (
          <div>
            <button id="go" onClick={() => (s.tab = 'x;y:z="q"')}>go</button>
            <p id="p" hidden={not(eq(s.tab, 'x;y:z="q"'))} class={{ on: eq(s.tab, 'x;y:z="q"') }}>p</p>
          </div>
        )}
      </Local>,
    );
    await mount(html);
    expect($("#p").hasAttribute("hidden")).toBe(true);
    $("#go").click();
    expect($("#p").hasAttribute("hidden")).toBe(false);
    expect($("#p").classList.contains("on")).toBe(true);
  });

  it("eq() against numbers, booleans and null", async () => {
    await mount(scope({ v: 1 }, `<button id="b" data-yx-on-click="() => (s.v = s.v === 1 ? null : s.v === null ? true : 1)">x</button>
      <i id="one" data-yx-bind="data-on:v=1"></i><i id="nul" data-yx-bind="data-on:v=null"></i><i id="tru" data-yx-bind="data-on:v=true"></i><i id="str" data-yx-bind="data-on:v=%221%22"></i>`));
    const on = () => ["one", "nul", "tru", "str"].filter((id) => $(`#${id}`).hasAttribute("data-on"));
    expect(on()).toEqual(["one"]);
    $("#b").click();
    expect(on()).toEqual(["nul"]);
    $("#b").click();
    expect(on()).toEqual(["tru"]);
  });

  it("a broken eq() value is never equal", async () => {
    await mount(scope({ v: 1 }, `<i id="x" data-yx-bind="data-on:v=%E0%A4%A"></i>`));
    expect($("#x").hasAttribute("data-on")).toBe(false);
  });
});

describe("nesting and morphs", () => {
  it("an inner scope's bindings and handlers are its own", async () => {
    await mount(scope({ n: 1 }, `<b id="outer" data-yx-text="n">1</b><button id="ob" data-yx-on-click="() => s.n++">o</button>${scope({ n: 100 }, `<b id="inner" data-yx-text="n">100</b><button id="ib" data-yx-on-click="() => s.n++">i</button>`)}`));
    $("#ob").click();
    expect([$("#outer").textContent, $("#inner").textContent]).toEqual(["2", "100"]);
    $("#ib").click();
    expect([$("#outer").textContent, $("#inner").textContent]).toEqual(["2", "101"]);
  });

  it("an inner click bubbling to an outer handler runs both, each on its own state", async () => {
    await mount(scope({ n: 0 }, `<div data-yx-on-click="() => s.n++"><b id="o" data-yx-text="n">0</b>${scope({ n: 0 }, `<button id="ib" data-yx-on-click="() => s.n++">i</button><b id="i" data-yx-text="n">0</b>`)}</div>`));
    $("#ib").click();
    expect([$("#o").textContent, $("#i").textContent]).toEqual(["1", "1"]);
  });

  it("a scope a morph brings in is started", async () => {
    await mount('<div id="r" data-yx-region></div>');
    yerd.page.apply(`<div id="r" data-yx-region>${scope({ n: 3 }, `<button id="b" data-yx-on-click="() => s.n++">x</button><b data-yx-text="n">3</b>`)}</div>`);
    $("#b").click();
    expect(texts("b")).toEqual(["4"]);
  });

  it("a region refresh keeps the browser's state and re-applies it over the server's initial values", async () => {
    await mount(`<div id="r" data-yx-region>${scope({ n: 0 }, `<button id="b" data-yx-on-click="() => s.n++">x</button><b data-yx-text="n">0</b>`)}</div>`);
    $("#b").click();
    $("#b").click();
    yerd.page.apply(`<div id="r" data-yx-region>${scope({ n: 0 }, `<button id="b" data-yx-on-click="() => s.n++">x</button><b data-yx-text="n">0</b><i data-yx-text="n">0</i>`)}</div>`);
    expect([$("b").textContent, $("i").textContent]).toEqual(["2", "2"]);
  });

  it("elements a morph adds inside a scope are wired", async () => {
    await mount(`<div id="r" data-yx-region>${scope({ n: 0 }, `<b data-yx-text="n">0</b>`)}</div>`);
    yerd.page.apply(`<div id="r" data-yx-region>${scope({ n: 0 }, `<b data-yx-text="n">0</b><button id="b" data-yx-on-click="() => s.n++">x</button>`)}</div>`);
    $("#b").click();
    expect(texts("b")).toEqual(["1"]);
  });

  it("a change to the page doesn't walk every scope's elements again looking for handlers", async () => {
    await mount(scope({ n: 0 }, `<button id="b" data-yx-on-click="() => s.n++">x</button><b data-yx-text="n">0</b>${scope({ m: 0 }, `<i data-yx-text="m">0</i>`)}`));
    const all = vi.spyOn(Element.prototype, "querySelectorAll");
    document.dispatchEvent(new CustomEvent("yx:applied", { detail: { regions: 0 } }));
    expect(all.mock.calls.filter(([selector]) => selector === "*")).toEqual([]);
    $("#b").click();
    expect(texts("b")).toEqual(["1"]);
  });

  it("an element put into a scope by other code is wired too", async () => {
    await mount(scope({ n: 0 }, `<b data-yx-text="n">0</b>`));
    $("yerd-local").insertAdjacentHTML("beforeend", `<p><button id="b" data-yx-on-click="() => s.n++">x</button></p>`);
    await flush();
    $("#b").click();
    expect(texts("b")).toEqual(["1"]);
  });
});

describe("persist", () => {
  const counter = (attrs: string) => scope({ n: 0, theme: "light" }, `<button class="inc" data-yx-on-click="() => s.n++">+</button><b class="n" data-yx-text="n">0</b><i class="theme" data-yx-text="theme">light</i>`, attrs);

  it.each([
    ["corrupt JSON", "{oops"],
    ["JSON null", "null"],
    ["a number", "5"],
    ["a string", '"str"'],
  ])("%s in storage keeps the defaults", async (_name, saved) => {
    localStorage.setItem("yerd-local:c", saved);
    await mount(counter('data-yx-persist="c"'));
    expect([$(".n").textContent, $(".theme").textContent]).toEqual(["0", "light"]);
    $(".inc").click();
    await frame();
    expect(JSON.parse(localStorage.getItem("yerd-local:c")!)).toEqual({ n: 1, theme: "light" });
  });

  it("saved fields merge over the defaults; unknown saved fields ride along", async () => {
    localStorage.setItem("yerd-local:c", JSON.stringify({ n: 9, extra: true }));
    await mount(counter('data-yx-persist="c"'));
    expect([$(".n").textContent, $(".theme").textContent]).toEqual(["9", "light"]);
    $(".inc").click();
    await frame();
    expect(JSON.parse(localStorage.getItem("yerd-local:c")!)).toEqual({ n: 10, theme: "light", extra: true });
  });

  it("a saved __proto__ key doesn't reach Object.prototype", async () => {
    localStorage.setItem("yerd-local:c", '{"__proto__": {"polluted": 1}, "n": 2}');
    await mount(counter('data-yx-persist="c"'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect($(".n").textContent).toBe("2");
  });

  it("storage that throws on read or write: the page still works", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    await mount(counter('data-yx-persist="c"'));
    $(".inc").click();
    expect($(".n").textContent).toBe("1");
  });

  it("storage that can't even be reached: the page still works", async () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => {
      throw new DOMException("blocked", "SecurityError");
    } });
    try {
      await mount(counter('data-yx-persist="blocked"'));
      $(".inc").click();
      expect($(".n").textContent).toBe("1");
    } finally {
      Object.defineProperty(window, "localStorage", original);
    }
  });

  it("scopes with the same key stay in step; other keys and the other storage don't", async () => {
    await mount(counter('data-yx-persist="a"') + counter('data-yx-persist="a"') + counter('data-yx-persist="b"') + counter('data-yx-persist="a" data-yx-storage="session"'));
    (document.querySelectorAll(".inc")[0] as HTMLElement).click();
    await frame();
    expect(texts(".n")).toEqual(["1", "1", "0", "0"]);
  });

  it("another tab's save is followed; a removal, a foreign key, the other storage or corrupt JSON aren't", async () => {
    await mount(counter('data-yx-persist="t"'));
    const send = (init: StorageEventInit) => window.dispatchEvent(new StorageEvent("storage", init));
    send({ key: "yerd-local:t", newValue: "{oops", storageArea: localStorage });
    send({ key: "yerd-local:t", newValue: null, storageArea: localStorage });
    send({ key: "yerd-local:other", newValue: '{"n":5}', storageArea: localStorage });
    send({ key: "yerd-local:t", newValue: '{"n":6}', storageArea: sessionStorage });
    send({ key: "t", newValue: '{"n":7}', storageArea: localStorage });
    send({ key: null, newValue: null, storageArea: localStorage });
    expect($(".n").textContent).toBe("0");
    send({ key: "yerd-local:t", newValue: '{"n":8}', storageArea: localStorage });
    expect($(".n").textContent).toBe("8");
  });

  it("a scope that left the page is dropped from its key's group on the next save", async () => {
    await mount(`<div id="gone">${counter('data-yx-persist="g"')}</div>${counter('data-yx-persist="g"')}`);
    const goneN = $("#gone .n");
    $("#gone").remove();
    $(".inc").click();
    expect($(".n").textContent).toBe("1");
    expect(goneN.textContent).toBe("0");
  });

  it("a scope that left the page no longer follows another tab's saves", async () => {
    await mount(`<div id="gone">${counter('data-yx-persist="p"')}</div>${counter('data-yx-persist="p"')}`);
    const goneN = $("#gone .n");
    $("#gone").remove();
    window.dispatchEvent(new StorageEvent("storage", { key: "yerd-local:p", newValue: '{"n":3}', storageArea: localStorage }));
    expect($(".n").textContent).toBe("3");
    expect(goneN.textContent).toBe("0");
  });

  it("a burst of handlers shows each change at once and saves once, with the last state", async () => {
    await mount(counter('data-yx-persist="burst"') + counter('data-yx-persist="burst"'));
    const set = vi.spyOn(localStorage, "setItem");
    const inc = document.querySelector(".inc") as HTMLElement;
    inc.click();
    inc.click();
    inc.click();
    expect($(".n").textContent).toBe("3");
    await frame();
    expect(set).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem("yerd-local:burst")!)).toEqual({ n: 3, theme: "light" });
    expect(texts(".n")).toEqual(["3", "3"]);
  });

  it("a save still waiting is written when the page goes away", async () => {
    await mount(counter('data-yx-persist="bye"'));
    $(".inc").click();
    window.dispatchEvent(new Event("pagehide"));
    expect(JSON.parse(localStorage.getItem("yerd-local:bye")!).n).toBe(1);
  });

  it("persisted from the server's render: key and storage attributes", async () => {
    const html = await renderToString(
      <Local state={{ x: 1 }} persist={{ key: 'k"<>', storage: "session" }}>
        {(s) => <b>{s.x}</b>}
      </Local>,
    );
    expect(html).toContain('data-yx-persist="k&quot;&lt;&gt;" data-yx-storage="session"');
    sessionStorage.setItem('yerd-local:k"<>', '{"x":4}');
    await mount(html);
    expect($("b").textContent).toBe("4");
  });
});
