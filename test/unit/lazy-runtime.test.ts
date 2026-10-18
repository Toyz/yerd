// @vitest-environment happy-dom
// @vitest-environment-options { "settings": { "handleDisabledFileLoadingAsSuccess": true } }
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runtimePieces } from "../../src/client/runtime.js";
import type { LazyRegistry } from "../../src/client/hooks.js";
import type { YerdClient } from "../../src/attributes/attribute.js";

// The runtime with the lazy chunk started inline, a registry like the server
// sends, and a stand-in for import(): each URL maps to a module factory, run
// when the chunk imports it. A URL can be held to watch the loading state.
const registry: LazyRegistry = {
  elements: {
    "lazy-clock": { url: "/m/clock.js", when: "load" },
    "lazy-later": { url: "/m/later.js", when: "interaction" },
    "lazy-nodefine": { url: "/m/nodefine.js", when: "load" },
  },
  attributes: {
    confetti: { url: "/m/confetti.js", when: "interaction" },
    glow: { url: "/m/glow.js", when: "load", css: ["/m/glow.css"] },
  },
};

type Module = { default?: unknown };
const modules = new Map<string, () => Module>();
const imported: string[] = [];
const held = new Map<string, () => void>();
const holding = new Set<string>();

function importStub(url: string): Promise<Module> {
  imported.push(url);
  const factory = modules.get(url);
  const result = new Promise<void>((resolve) => {
    if (holding.has(url)) held.set(url, resolve);
    else resolve();
  }).then(() => {
    if (!factory) throw new Error(`no module at ${url}`);
    return factory();
  });
  return result;
}

const log: string[] = [];
let yerd: YerdClient;

// Stand-ins for the browser APIs the triggers use.
let seen: { callback: IntersectionObserverCallback; options?: IntersectionObserverInit; observed: Set<Element> } | undefined;
class FakeIntersectionObserver {
  observed = new Set<Element>();
  constructor(
    public callback: IntersectionObserverCallback,
    public options?: IntersectionObserverInit,
  ) {
    seen = this;
  }
  observe(el: Element) {
    this.observed.add(el);
  }
  unobserve(el: Element) {
    this.observed.delete(el);
  }
  disconnect() {}
}
function scrollIntoView(el: Element): void {
  seen!.callback([{ target: el, isIntersecting: true } as unknown as IntersectionObserverEntry], seen as unknown as IntersectionObserver);
}

beforeAll(() => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  const { core, chunks } = runtimePieces();
  new Function("importChunk", `(${core})("", { lazy: ${chunks.lazy} }, importChunk, undefined, ${JSON.stringify(registry)});`)(importStub);
  yerd = (window as unknown as { yerd: YerdClient }).yerd;
});

afterEach(async () => {
  document.body.innerHTML = "";
  // Let the removals disconnect before the next test's log starts.
  await flush();
  log.length = 0;
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Every yx:lazy-* event that bubbles to the document while `run` goes. */
async function events(run: () => Promise<void> | void): Promise<Array<{ type: string; target: string; detail: Record<string, unknown> }>> {
  const out: Array<{ type: string; target: string; detail: Record<string, unknown> }> = [];
  const listen = (e: Event) => out.push({ type: e.type, target: (e.target as Element).id, detail: (e as CustomEvent).detail });
  document.addEventListener("yx:lazy-start", listen);
  document.addEventListener("yx:lazy-end", listen);
  try {
    await run();
  } finally {
    document.removeEventListener("yx:lazy-start", listen);
    document.removeEventListener("yx:lazy-end", listen);
  }
  return out;
}

function islandHtml(id: string, src: string, attrs = ""): string {
  return `<yerd-island id="${id}" data-yx-island="${src}" data-yx-keep ${attrs}><p>fallback</p></yerd-island>`;
}

describe("islands", () => {
  it("mount with their props and the runtime API, with the loading state and events around it, and clean up on removal", async () => {
    modules.set("/m/counter.js", () => ({
      default: (el: HTMLElement, props: { start: number }, api: YerdClient) => {
        log.push(`mount ${el.id} ${props.start} ${api === yerd}`);
        el.textContent = `count ${props.start}`;
        return () => log.push(`cleanup ${el.id}`);
      },
    }));
    holding.add("/m/counter.js");
    const seenEvents = await events(async () => {
      document.body.innerHTML = islandHtml("a", "/m/counter.js", `data-yx-props='{"start":3}'`);
      await flush();
      const el = document.getElementById("a")!;
      expect(el.hasAttribute("data-yx-loading")).toBe(true);
      expect(el.textContent).toBe("fallback");
      held.get("/m/counter.js")!();
      await flush();
      expect(el.hasAttribute("data-yx-loading")).toBe(false);
      expect(el.textContent).toBe("count 3");
    });
    expect(seenEvents).toEqual([
      { type: "yx:lazy-start", target: "a", detail: { src: "/m/counter.js" } },
      { type: "yx:lazy-end", target: "a", detail: { src: "/m/counter.js", ok: true } },
    ]);
    expect(log).toEqual(["mount a 3 true"]);
    document.getElementById("a")!.remove();
    await flush();
    expect(log).toEqual(["mount a 3 true", "cleanup a"]);
    holding.clear();
  });

  it("import each module once per page, however many islands use it, including ones added later", async () => {
    let runs = 0;
    modules.set("/m/once.js", () => {
      runs++;
      return { default: (el: HTMLElement, props: unknown) => void log.push(`${el.id}:${JSON.stringify(props)}`) };
    });
    document.body.innerHTML = islandHtml("one", "/m/once.js") + islandHtml("two", "/m/once.js", `data-yx-props='[1]'`);
    await flush();
    // As a boosted page or a morph would bring one in.
    document.body.insertAdjacentHTML("beforeend", islandHtml("three", "/m/once.js"));
    await flush();
    expect(log.sort()).toEqual(["one:undefined", "three:undefined", "two:[1]"]);
    expect(runs).toBe(1);
    expect(imported.filter((url) => url === "/m/once.js")).toHaveLength(1);
  });

  it("wait for their own trigger: visible, 200px ahead of the viewport", async () => {
    modules.set("/m/seen.js", () => ({ default: (el: HTMLElement) => void log.push(`seen ${el.id}`) }));
    document.body.innerHTML = islandHtml("v1", "/m/seen.js", 'data-yx-when="visible"') + islandHtml("v2", "/m/seen.js", 'data-yx-when="visible"');
    await flush();
    expect(imported).not.toContain("/m/seen.js");
    expect(seen!.options).toEqual({ rootMargin: "200px" });
    scrollIntoView(document.getElementById("v2")!);
    await flush();
    expect(log).toEqual(["seen v2"]);
    // Imported already, but v1 still waits for its own turn.
    expect(seen!.observed.has(document.getElementById("v1")!)).toBe(true);
    expect(seen!.observed.has(document.getElementById("v2")!)).toBe(false);
    scrollIntoView(document.getElementById("v1")!);
    await flush();
    expect(log).toEqual(["seen v2", "seen v1"]);
  });

  it("idle: requestIdleCallback with a two-second cap, or a timer without it", async () => {
    modules.set("/m/idle.js", () => ({ default: (el: HTMLElement) => void log.push(`idle ${el.id}`) }));
    let idle: (() => void) | undefined;
    const ric = vi.fn((cb: () => void, _options?: { timeout: number }) => {
      idle = cb;
      return 1;
    });
    vi.stubGlobal("requestIdleCallback", ric);
    vi.stubGlobal("cancelIdleCallback", () => {});
    document.body.innerHTML = islandHtml("i1", "/m/idle.js", 'data-yx-when="idle"');
    await flush();
    expect(ric).toHaveBeenCalledWith(expect.any(Function), { timeout: 2000 });
    expect(log).toEqual([]);
    idle!();
    await flush();
    expect(log).toEqual(["idle i1"]);
    vi.stubGlobal("requestIdleCallback", undefined);
    document.body.insertAdjacentHTML("beforeend", islandHtml("i2", "/m/idle.js", 'data-yx-when="idle"'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    await flush();
    expect(log).toEqual(["idle i1", "idle i2"]);
    vi.unstubAllGlobals();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  });

  it("interaction: the first pointerenter, pointerdown, focusin or touchstart", async () => {
    modules.set("/m/touch.js", () => ({ default: (el: HTMLElement) => void log.push(`touched ${el.id}`) }));
    document.body.innerHTML = ["pointerenter", "pointerdown", "focusin", "touchstart"].map((type) => islandHtml(type, "/m/touch.js", 'data-yx-when="interaction"')).join("");
    await flush();
    expect(log).toEqual([]);
    for (const type of ["pointerenter", "pointerdown", "focusin", "touchstart"]) {
      document.getElementById(type)!.dispatchEvent(new Event(type));
      document.getElementById(type)!.dispatchEvent(new Event(type));
    }
    await flush();
    expect(log).toEqual(["touched pointerenter", "touched pointerdown", "touched focusin", "touched touchstart"]);
  });

  it("media:<query>: once the query matches", async () => {
    modules.set("/m/wide.js", () => ({ default: (el: HTMLElement) => void log.push(`wide ${el.id}`) }));
    const listeners: Array<() => void> = [];
    const query = { matches: false, addEventListener: (_: string, fn: () => void) => listeners.push(fn), removeEventListener: vi.fn() };
    const matchMedia = vi.fn(() => query);
    vi.stubGlobal("matchMedia", matchMedia);
    document.body.innerHTML = islandHtml("m", "/m/wide.js", 'data-yx-when="media:(min-width: 800px)"');
    await flush();
    expect(matchMedia).toHaveBeenCalledWith("(min-width: 800px)");
    listeners.forEach((fn) => fn());
    await flush();
    expect(log).toEqual([]);
    query.matches = true;
    listeners.forEach((fn) => fn());
    await flush();
    expect(log).toEqual(["wide m"]);
    expect(query.removeEventListener).toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  });

  it("mark a failed import or mount with data-yx-failed, log it, and say so in yx:lazy-end", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    modules.set("/m/throws.js", () => ({
      default: () => {
        throw new Error("boom");
      },
    }));
    modules.set("/m/nodefault.js", () => ({}));
    const seenEvents = await events(async () => {
      document.body.innerHTML = islandHtml("x", "/m/missing.js") + islandHtml("y", "/m/throws.js") + islandHtml("z", "/m/nodefault.js");
      await flush();
    });
    for (const id of ["x", "y", "z"]) {
      const el = document.getElementById(id)!;
      expect(el.hasAttribute("data-yx-failed"), id).toBe(true);
      expect(el.hasAttribute("data-yx-loading"), id).toBe(false);
    }
    const ends = seenEvents.filter((e) => e.type === "yx:lazy-end");
    expect(ends.map((e) => [e.target, e.detail.ok, String(e.detail.error)])).toEqual([
      ["x", false, "Error: no module at /m/missing.js"],
      ["y", false, "Error: boom"],
      ["z", false, "TypeError: /m/nodefault.js has no default export to mount"],
    ]);
    expect(error).toHaveBeenCalledWith("[yerd] couldn't load /m/throws.js:", expect.any(Error));
  });

  it("an island removed while its module loads never mounts; one removed during an async mount is cleaned up after it", async () => {
    modules.set("/m/slow.js", () => ({
      default: async (el: HTMLElement) => {
        log.push(`mount ${el.id}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return () => log.push(`cleanup ${el.id}`);
      },
    }));
    holding.add("/m/slow.js");
    document.body.innerHTML = islandHtml("gone", "/m/slow.js");
    await flush();
    document.getElementById("gone")!.remove();
    await flush();
    held.get("/m/slow.js")!();
    await flush();
    expect(log).toEqual([]);
    holding.clear();
    document.body.innerHTML = islandHtml("mid", "/m/slow.js");
    await flush();
    expect(log).toEqual(["mount mid"]);
    document.getElementById("mid")!.remove();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flush();
    expect(log).toEqual(["mount mid", "cleanup mid"]);
  });

  it("link the module's stylesheets before mounting, once each", async () => {
    let linked: string[] = [];
    modules.set("/m/styled.js", () => ({
      default: () => {
        linked = Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'), (link) => link.getAttribute("href")!);
      },
    }));
    document.body.innerHTML = islandHtml("s1", "/m/styled.js", 'data-yx-styles="/m/a.css /m/b.css"') + islandHtml("s2", "/m/styled.js", 'data-yx-styles="/m/a.css /m/b.css"');
    await flush();
    for (const link of Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))) link.dispatchEvent(new Event("load"));
    await flush();
    expect(linked.map((href) => new URL(href, document.baseURI).pathname)).toEqual(["/m/a.css", "/m/b.css"]);
    expect(document.head.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(2);
  });

  it("a morph leaves a mounted island alone (data-yx-keep)", async () => {
    modules.set("/m/kept.js", () => ({ default: (el: HTMLElement) => void (el.innerHTML = "<canvas></canvas>") }));
    document.body.innerHTML = `<div id="r" data-yx-region>${islandHtml("k", "/m/kept.js")}</div>`;
    await flush();
    expect(document.querySelector("#k canvas")).not.toBeNull();
    yerd.page.apply(`<div id="r" data-yx-region>${islandHtml("k", "/m/kept.js")}</div>`);
    await flush();
    expect(document.querySelector("#k canvas")).not.toBeNull();
  });
});

describe("module-backed attributes", () => {
  it("load on the first element's trigger, then connect, update and disconnect like inline halves, everywhere", async () => {
    modules.set("/m/confetti.js", () => ({
      default: (el: HTMLElement, value: string) => {
        log.push(`connect ${el.id} ${value}`);
        return { update: (next: string) => log.push(`update ${el.id} ${next}`), disconnect: () => log.push(`disconnect ${el.id}`) };
      },
    }));
    const seenEvents = await events(async () => {
      document.body.innerHTML = '<button id="b1" confetti="red">1</button><button id="b2" confetti="blue">2</button>';
      await flush();
      expect(imported).not.toContain("/m/confetti.js");
      document.getElementById("b2")!.dispatchEvent(new Event("pointerenter"));
      await flush();
    });
    expect(log.sort()).toEqual(["connect b1 red", "connect b2 blue"]);
    expect(seenEvents.map((e) => `${e.type} ${e.target}`)).toEqual(["yx:lazy-start b2", "yx:lazy-end b2"]);
    document.getElementById("b1")!.setAttribute("confetti", "green");
    await flush();
    document.getElementById("b2")!.remove();
    await flush();
    // Added after the module is in: connects at once, no trigger needed.
    document.body.insertAdjacentHTML("beforeend", '<button id="b3" confetti="gold">3</button>');
    await flush();
    expect(log.slice(2)).toEqual(["update b1 green", "disconnect b2", "connect b3 gold"]);
    expect(imported.filter((url) => url === "/m/confetti.js")).toHaveLength(1);
  });

  it("with their stylesheets linked first; a cleanup function works as the handle", async () => {
    modules.set("/m/glow.js", () => ({
      default: (el: HTMLElement) => {
        log.push(`glow ${el.id} ${document.head.querySelectorAll('link[href$="/m/glow.css"]').length}`);
        return () => log.push(`unglow ${el.id}`);
      },
    }));
    document.body.innerHTML = '<p id="g" glow></p>';
    await flush();
    document.head.querySelector<HTMLLinkElement>('link[href$="/m/glow.css"]')?.dispatchEvent(new Event("load"));
    await flush();
    expect(log).toEqual(["glow g 1"]);
    document.getElementById("g")!.removeAttribute("glow");
    await flush();
    expect(log).toEqual(["glow g 1", "unglow g"]);
  });
});

describe("lazy elements", () => {
  it("import the module that defines the tag, and the browser upgrades every instance", async () => {
    modules.set("/m/clock.js", () => {
      customElements.define(
        "lazy-clock",
        class extends HTMLElement {
          connectedCallback() {
            this.textContent = "ticking";
          }
        },
      );
      return {};
    });
    const seenEvents = await events(async () => {
      document.body.innerHTML = '<lazy-clock id="c1">12:00</lazy-clock><lazy-clock id="c2">12:00</lazy-clock>';
      await flush();
    });
    expect(document.getElementById("c1")!.textContent).toBe("ticking");
    expect(document.getElementById("c2")!.textContent).toBe("ticking");
    expect(seenEvents.filter((e) => e.type === "yx:lazy-end").map((e) => e.detail.ok)).toEqual([true, true]);
    expect(imported.filter((url) => url === "/m/clock.js")).toHaveLength(1);
    // Added later by app code: already defined, nothing to load.
    const more = document.createElement("lazy-clock");
    document.body.appendChild(more);
    await flush();
    expect(more.textContent).toBe("ticking");
  });

  it("once upgraded, keep their own children through a morph; only their attributes are patched", async () => {
    // lazy-clock was defined by the previous test.
    document.body.innerHTML = '<div id="r" data-yx-region><lazy-clock id="c3" data-zone="utc">12:00</lazy-clock></div>';
    await flush();
    // What the element drew for itself.
    document.getElementById("c3")!.textContent = "ticking";
    yerd.page.apply('<div id="r" data-yx-region><lazy-clock id="c3" data-zone="cet">12:00</lazy-clock></div>');
    await flush();
    const clock = document.getElementById("c3")!;
    expect(clock.textContent).toBe("ticking");
    expect(clock.getAttribute("data-zone")).toBe("cet");
  });

  it("show the server's children until their trigger fires, then disarm the rest", async () => {
    modules.set("/m/later.js", () => {
      customElements.define("lazy-later", class extends HTMLElement {});
      return {};
    });
    document.body.innerHTML = '<lazy-later id="l1">server text</lazy-later><lazy-later id="l2">server text</lazy-later>';
    await flush();
    expect(imported).not.toContain("/m/later.js");
    expect(document.getElementById("l1")!.textContent).toBe("server text");
    const l2 = document.getElementById("l2")!;
    document.getElementById("l1")!.dispatchEvent(new Event("focusin"));
    await flush();
    expect(customElements.get("lazy-later")).toBeDefined();
    const startsOnL2 = await events(() => {
      l2.dispatchEvent(new Event("pointerenter"));
    });
    expect(startsOnL2).toEqual([]);
  });

  it("fail when the module doesn't define the tag", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    modules.set("/m/nodefine.js", () => ({}));
    document.body.innerHTML = '<lazy-nodefine id="n"></lazy-nodefine>';
    await flush();
    expect(document.getElementById("n")!.hasAttribute("data-yx-failed")).toBe(true);
  });
});

describe("morphs and runtime state", () => {
  it("leave the state the runtime put on an element (loading, failed, cued, drag) and patch the rest", () => {
    document.body.innerHTML = '<b id="x" class="a">go</b>';
    const el = document.getElementById("x")!;
    for (const name of ["data-yx-loading", "data-yx-failed", "data-yx-cued", "data-yx-dragging", "data-yx-over"]) el.setAttribute(name, "");
    el.setAttribute("data-stale", "1");
    const next = document.createElement("b");
    next.id = "x";
    next.className = "b";
    next.textContent = "go";
    yerd.page.morph(el, next);
    expect(el.className).toBe("b");
    expect(el.hasAttribute("data-stale")).toBe(false);
    for (const name of ["data-yx-loading", "data-yx-failed", "data-yx-cued", "data-yx-dragging", "data-yx-over"]) expect(el.hasAttribute(name)).toBe(true);
  });
});

describe("the core", () => {
  it("brings in the lazy chunk for islands, lazy tags and module-backed attributes", async () => {
    const urls: string[] = [];
    const { core } = runtimePieces();
    // A second window: the runtime guards against running twice in one.
    const { Window } = await import("happy-dom");
    for (const html of [islandHtml("i", "/m/x.js"), "<lazy-clock></lazy-clock>", "<b confetti></b>", "<p>none</p>"]) {
      const win = new Window({ url: "http://localhost:3000/" });
      win.document.body.innerHTML = html;
      const run = new win.Function("importChunk", `(${core})("http://localhost:3000/_yerd/", undefined, importChunk, { lazy: "v1" }, ${JSON.stringify(registry)});`) as (fn: unknown) => void;
      run((url: string) => {
        urls.push(`${html}=>${url}`);
        return new Promise(() => {});
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await win.happyDOM.close();
    }
    expect(urls).toEqual([
      `${islandHtml("i", "/m/x.js")}=>http://localhost:3000/_yerd/runtime-lazy.js?v=v1`,
      "<lazy-clock></lazy-clock>=>http://localhost:3000/_yerd/runtime-lazy.js?v=v1",
      "<b confetti></b>=>http://localhost:3000/_yerd/runtime-lazy.js?v=v1",
    ]);
  });
});
