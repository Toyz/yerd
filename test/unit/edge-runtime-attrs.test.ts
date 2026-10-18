// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runtimeSource } from "../../src/client/runtime.js";
import { attribute, attributesSource, customAttribute, resetAttributeRegistry } from "../../src/attributes/attribute.js";
import type { YerdClient as Yerd } from "../../src/attributes/attribute.js";

type Handle = void | (() => void) | { update?(value: string): void; disconnect?(): void };

let yerd: Yerd;

beforeAll(() => {
  new Function(runtimeSource())();
  yerd = (window as unknown as { yerd: Yerd }).yerd;
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

let counter = 0;
/** Register a fresh attribute that logs what happens to it. */
function tracked(returns: "hooks" | "cleanup" | "nothing" = "hooks") {
  const name = `x-track${++counter}`;
  const events: string[] = [];
  yerd.attribute(name, (el, value, api) => {
    events.push(`connect ${el.id}=${value}`);
    if (api !== (window as unknown as { yerd: unknown }).yerd) events.push("wrong api");
    if (returns === "cleanup") return () => events.push(`cleanup ${el.id}`);
    if (returns === "nothing") return undefined;
    return { update: (next) => events.push(`update ${el.id}=${next}`), disconnect: () => events.push(`disconnect ${el.id}`) };
  });
  return { name, events };
}

const $ = (id: string) => document.getElementById(id)!;

function el(html: string): Element {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild!;
}

describe("client halves", () => {
  it("connect elements already on the page when registered, with the runtime API", () => {
    document.body.innerHTML = '<p id="a" x-track1="v"></p>';
    counter = 0;
    const { events } = tracked();
    expect(events).toEqual(["connect a=v"]);
  });

  it("connect a whole inserted subtree, the root included", async () => {
    const { name, events } = tracked();
    document.body.innerHTML = `<div id="root" ${name}="r"><span id="kid" ${name}="k"></span></div>`;
    await flush();
    expect(events.sort()).toEqual(["connect kid=k", "connect root=r"]);
  });

  it("an empty attribute connects with an empty value", async () => {
    const { name, events } = tracked();
    document.body.innerHTML = `<p id="e" ${name}></p>`;
    await flush();
    expect(events).toEqual(["connect e="]);
  });

  it("update only when the value really changes", async () => {
    const { name, events } = tracked();
    document.body.innerHTML = `<p id="u" ${name}="1"></p>`;
    await flush();
    $("u").setAttribute(name, "1");
    await flush();
    $("u").setAttribute(name, "2");
    await flush();
    expect(events).toEqual(["connect u=1", "update u=2"]);
  });

  it("removing the attribute disconnects; adding it back connects again", async () => {
    const { name, events } = tracked();
    document.body.innerHTML = `<p id="r" ${name}="1"></p>`;
    await flush();
    $("r").removeAttribute(name);
    await flush();
    $("r").setAttribute(name, "2");
    await flush();
    expect(events).toEqual(["connect r=1", "disconnect r", "connect r=2"]);
  });

  it("a returned function is the cleanup; returning nothing is fine", async () => {
    const cleanup = tracked("cleanup");
    const nothing = tracked("nothing");
    document.body.innerHTML = `<p id="c" ${cleanup.name}="1" ${nothing.name}="1"></p>`;
    await flush();
    $("c").setAttribute(nothing.name, "2");
    $("c").remove();
    await flush();
    expect(cleanup.events).toEqual(["connect c=1", "cleanup c"]);
    expect(nothing.events).toEqual(["connect c=1"]);
  });

  it("two attributes on one element come and go independently", async () => {
    const a = tracked();
    const b = tracked();
    document.body.innerHTML = `<p id="two" ${a.name}="1" ${b.name}="1"></p>`;
    await flush();
    $("two").removeAttribute(a.name);
    await flush();
    expect(a.events).toEqual(["connect two=1", "disconnect two"]);
    expect(b.events).toEqual(["connect two=1"]);
  });

  it("a setup that throws is logged and doesn't break the others", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    yerd.attribute("x-throws", () => {
      throw new Error("bad setup");
    });
    const ok = tracked();
    document.body.innerHTML = `<p id="t" x-throws="1" ${ok.name}="1"></p>`;
    await flush();
    expect(ok.events).toEqual(["connect t=1"]);
    expect(log).toHaveBeenCalledWith("[yerd] attribute x-throws failed to connect:", expect.any(Error));
    // Its removal doesn't throw either.
    $("t").remove();
    await flush();
    expect(ok.events).toEqual(["connect t=1", "disconnect t"]);
  });

  it("a disconnect that throws is logged", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    yerd.attribute("x-bad-disconnect", () => ({
      disconnect() {
        throw new Error("bad disconnect");
      },
    }));
    document.body.innerHTML = '<p id="d" x-bad-disconnect="1"></p>';
    await flush();
    $("d").remove();
    await flush();
    expect(log).toHaveBeenCalledWith("[yerd] attribute x-bad-disconnect failed to disconnect:", expect.any(Error));
  });

  it("an element moved within one batch stays connected; one out for a while reconnects", async () => {
    const { name, events } = tracked();
    document.body.innerHTML = `<div id="a"><p id="m" ${name}="1"></p></div><div id="b"></div>`;
    await flush();
    $("b").appendChild($("m"));
    await flush();
    expect(events).toEqual(["connect m=1"]);
    const p = $("m");
    p.remove();
    await flush();
    $("a").appendChild(p);
    await flush();
    expect(events).toEqual(["connect m=1", "disconnect m", "connect m=1"]);
  });

  it("a keyed morph that reorders elements doesn't reconnect them", async () => {
    const { name, events } = tracked();
    document.body.innerHTML = `<ul id="l"><li id="i1" data-key="1" ${name}="a"></li><li id="i2" data-key="2" ${name}="b"></li></ul>`;
    await flush();
    events.length = 0;
    yerd.page.morph($("l"), el(`<ul id="l"><li id="i2" data-key="2" ${name}="b"></li><li id="i1" data-key="1" ${name}="a2"></li></ul>`));
    await flush();
    expect(events).toEqual(["update i1=a2"]);
  });

  it("a morph that swaps the element's tag disconnects the old and connects the new", async () => {
    const { name, events } = tracked();
    document.body.innerHTML = `<div id="w"><p id="s" ${name}="1"></p></div>`;
    await flush();
    yerd.page.morph($("w"), el(`<div id="w"><section id="s" ${name}="1"></section></div>`));
    await flush();
    // The new one connects first: removals are swept after the batch's additions.
    expect(events).toEqual(["connect s=1", "connect s=1", "disconnect s"]);
  });

  it("registering another attribute keeps watching the first", async () => {
    const first = tracked();
    tracked();
    document.body.innerHTML = `<p id="k" ${first.name}="1"></p>`;
    await flush();
    $("k").setAttribute(first.name, "2");
    await flush();
    expect(first.events).toEqual(["connect k=1", "update k=2"]);
  });

  it("an element added and removed before the observer runs never connects", async () => {
    const { name, events } = tracked();
    const p = document.createElement("p");
    p.id = "flash";
    p.setAttribute(name, "1");
    document.body.appendChild(p);
    p.remove();
    await flush();
    expect(events).toEqual([]);
  });

  it("an attribute set on a detached element connects when it's inserted", async () => {
    const { name, events } = tracked();
    const p = document.createElement("p");
    p.id = "later";
    p.setAttribute(name, "1");
    await flush();
    expect(events).toEqual([]);
    document.body.appendChild(p);
    await flush();
    expect(events).toEqual(["connect later=1"]);
  });

  it("an apply() that brings in elements connects them", async () => {
    const { name, events } = tracked();
    document.body.innerHTML = '<div id="r" data-yx-region></div>';
    await flush();
    yerd.page.apply(`<div id="r" data-yx-region><b id="n" ${name}="new"></b></div>`);
    await flush();
    expect(events).toEqual(["connect n=new"]);
  });
});

describe("server half and shipping", () => {
  it.each(["Tooltip", "my_attr", "-x", "x-", "x--y", "9x", "", "data yx"])("refuses the name %j", (name) => {
    expect(() => attribute(name, {})).toThrow("lowercase words joined by dashes");
  });

  it("refuses the built-in prefetch and a second definition", () => {
    expect(() => attribute("prefetch", {})).toThrow("built-in");
    attribute("dupe-check", {});
    expect(() => attribute("dupe-check", {})).toThrow("defined twice");
  });

  it("ships method shorthand, arrows and functions as expressions that run", () => {
    resetAttributeRegistry();
    attribute("ship-method", {
      client(el, value) {
        el.setAttribute("data-m", value);
      },
    });
    attribute("ship-arrow", { client: (el, value) => void el.setAttribute("data-a", value) });
    attribute("ship-function", {
      client: function named(el, value) {
        el.setAttribute("data-f", value);
      },
    });
    attribute("server-only", { render: (v: string) => ({ title: v }) });
    const source = attributesSource();
    expect(source).not.toContain("server-only");
    document.body.innerHTML = '<p id="p" ship-method="1" ship-arrow="2" ship-function="4"></p>';
    new Function(source)();
    expect([$("p").getAttribute("data-m"), $("p").getAttribute("data-a"), $("p").getAttribute("data-f")]).toEqual(["1", "2", "4"]);
  });

  it("caches the source until the registry changes", () => {
    resetAttributeRegistry();
    attribute("cache-a", { client: () => {} });
    const first = attributesSource();
    expect(attributesSource()).toBe(first);
    attribute("cache-b", { client: () => {} });
    expect(attributesSource()).not.toBe(first);
    expect(attributesSource()).toContain('"cache-b"');
  });

  it("an empty registry ships nothing", () => {
    resetAttributeRegistry();
    attribute("no-client", { render: () => null });
    expect(attributesSource()).toBe("");
  });

  it("a client half using a compiler helper is refused", () => {
    resetAttributeRegistry();
    const helper = { client: new Function("el", "return __awaiter(this, void 0, void 0, function* () {})") as never };
    attribute("helper-user", helper);
    expect(() => attributesSource()).toThrow("compiler helper");
    resetAttributeRegistry();
  });

  it("reset keeps the built-ins", () => {
    resetAttributeRegistry();
    expect(customAttribute("prefetch")).toBeDefined();
  });

  it.each([
    ["true on a link", true, "a", { href: "/x" }, { "data-yx-prefetch": "intent" }],
    ["a mode", "visible", "a", { href: "/x" }, { "data-yx-prefetch": "visible" }],
    ["json with a url on any element", { url: "/api", as: "json", on: "load" }, "section", {}, { "data-yx-prefetch": "load", "data-yx-prefetch-url": "/api", "data-yx-prefetch-as": "json" }],
    ["false", false, "a", { href: "/x" }, null],
  ])("prefetch renders %s", (_name, value, tag, props, expected) => {
    const out = customAttribute("prefetch")!.render!(value, { tag, props });
    const defined = out ? Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) : out;
    expect(defined).toEqual(expected);
  });

  it.each([
    ["an unknown mode", "hover", "a", { href: "/x" }, "isn't a mode"],
    ["no href and no url", true, "div", {}, "needs an href"],
    ["a link without an href", true, "a", {}, "needs an href"],
  ])("prefetch refuses %s", (_name, value, tag, props, message) => {
    expect(() => customAttribute("prefetch")!.render!(value, { tag, props })).toThrow(message);
  });
});
