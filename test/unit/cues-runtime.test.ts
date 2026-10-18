// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeSource } from "../../src/client/runtime.js";
import type { YerdClient as Yerd } from "../../src/attributes/attribute.js";


/** This page's clock (performance.timeOrigin + performance.now()), moved by hand. */
let local = 0;
/** How far ahead the server's clock is. */
const AHEAD = 5000;
const server = () => local + AHEAD;

class FakeEventSource {
  static all: FakeEventSource[] = [];
  readyState = 1;
  closed = false;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  send(cue: object) {
    this.onmessage?.({ data: JSON.stringify(cue) });
  }
}
// Closed by the page, or given up on by the browser (readyState 2): not open.
const open = () => FakeEventSource.all.filter((s) => !s.closed && s.readyState !== 2);
const rooms = (source: FakeEventSource) => new URL(source.url, "http://x").searchParams.getAll("room");

let clockCalls = 0;
let yerd: Yerd;
let ids = 0;
const cue = (fields: Record<string, unknown>) => ({ id: `t-${++ids}`, room: "main", ...fields });

/** Move both clocks on, running whatever comes due. */
async function tick(ms: number): Promise<void> {
  local += ms;
  await vi.advanceTimersByTimeAsync(ms);
}
/** Let mutation observers, microtasks and fetches settle without moving the clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame"] });
  local = performance.timeOrigin + 1_000_000;
  vi.spyOn(performance, "now").mockImplementation(() => local - performance.timeOrigin);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url) !== "/_yerd/clock") return new Response("nope", { status: 404 });
      clockCalls++;
      return new Response(JSON.stringify({ now: server() }), { headers: { "content-type": "application/json" } });
    }),
  );
  new Function(runtimeSource())();
  yerd = (window as unknown as { yerd: Yerd }).yerd;
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  document.body.innerHTML = "";
  await settle();
});

describe("the server clock", () => {
  it("doesn't measure anything until something needs it", () => {
    expect(clockCalls).toBe(0);
    expect(open()).toEqual([]);
  });

  it("measures the offset with a few round trips, once", async () => {
    const [a, b] = await Promise.all([yerd.clock.sync(), yerd.clock.sync()]);
    expect(clockCalls).toBe(4);
    expect(a.offset).toBe(AHEAD);
    expect(a.rtt).toBe(0);
    expect(b).toEqual(a);
    expect(yerd.clock.now()).toBe(server());
    await yerd.clock.sync();
    expect(clockCalls).toBe(4);
  });

  it("re-measures when the tab comes back", async () => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(clockCalls).toBe(8);
  });
});

describe("cue", () => {
  it("opens one cue stream for the rooms on the page, and closes it when they go", async () => {
    document.body.innerHTML = `<div id="a" data-yx-cue="horn"></div><div id="b" data-yx-cue="horn drum" data-yx-cue-room="vip"></div><div id="c" data-yx-cue="x"></div>`;
    await settle();
    expect(open().length).toBe(1);
    expect(open()[0]!.url.startsWith("/_yerd/cues?")).toBe(true);
    expect(rooms(open()[0]!)).toEqual(["main", "vip"]);
    const first = open()[0]!;

    document.getElementById("b")!.remove();
    await settle();
    expect(first.closed).toBe(true);
    expect(open().map(rooms)).toEqual([["main"]]);

    // Same rooms: the stream is kept.
    const kept = open()[0]!;
    document.getElementById("c")!.remove();
    await settle();
    expect(kept.closed).toBe(false);

    document.body.innerHTML = "";
    await settle();
    expect(open()).toEqual([]);
  });

  it("follows a room that changes on its own", async () => {
    document.body.innerHTML = `<div id="a" data-yx-cue="horn" data-yx-cue-room="one"></div>`;
    await settle();
    expect(open().map(rooms)).toEqual([["one"]]);
    document.getElementById("a")!.setAttribute("data-yx-cue-room", "two");
    await settle();
    expect(open().map(rooms)).toEqual([["two"]]);
  });

  it("encodes room names", async () => {
    document.body.innerHTML = `<div data-yx-cue="horn" data-yx-cue-room="team:7 &amp; co"></div>`;
    await settle();
    expect(open()[0]!.url).toContain("room=team%3A7%20%26%20co");
    expect(rooms(open()[0]!)).toEqual(["team:7 & co"]);
  });

  it("plays at the server's moment, not when the message arrives", async () => {
    document.body.innerHTML = `<div id="a" data-yx-cue="horn"></div><div id="other" data-yx-cue="drum"></div>`;
    await settle();
    const events: CustomEvent[] = [];
    document.addEventListener("yx:cue", (e) => events.push(e as CustomEvent), { once: true });
    open()[0]!.send(cue({ name: "horn", at: server() + 300, data: { n: 1 } }));
    await settle();
    await tick(299);
    expect(document.getElementById("a")!.hasAttribute("data-yx-cued")).toBe(false);
    await tick(1);
    expect(document.getElementById("a")!.getAttribute("data-yx-cued")).toBe("horn");
    expect(document.getElementById("other")!.hasAttribute("data-yx-cued")).toBe(false);
    expect(events.length).toBe(1);
    expect(events[0]!.target).toBe(document.getElementById("a"));
    expect(events[0]!.detail).toMatchObject({ name: "horn", room: "main", data: { n: 1 }, late: 0 });
  });

  it("only plays cues for the element's room", async () => {
    document.body.innerHTML = `<div id="main" data-yx-cue="horn"></div><div id="vip" data-yx-cue="horn" data-yx-cue-room="vip"></div>`;
    await settle();
    open()[0]!.send(cue({ name: "horn", room: "vip", at: server() }));
    await settle();
    expect(document.getElementById("vip")!.hasAttribute("data-yx-cued")).toBe(true);
    expect(document.getElementById("main")!.hasAttribute("data-yx-cued")).toBe(false);
  });

  it("starts a late cue partway, and takes data-yx-cued off when it ends", async () => {
    document.body.innerHTML = `<div id="a" data-yx-cue="horn"></div>`;
    const el = document.getElementById("a")!;
    const old = { currentTime: 0 };
    const fresh = { currentTime: 0 as number | null };
    // Before the cue: its old animation; after: a new one, which is the one moved on.
    (el as unknown as { getAnimations: () => object[] }).getAnimations = () => (el.hasAttribute("data-yx-cued") ? [old, fresh] : [old]);
    await settle();
    let late = -1;
    el.addEventListener("yx:cue", (e) => (late = (e as CustomEvent).detail.late), { once: true });
    open()[0]!.send(cue({ name: "horn", at: server() - 500, lasts: 2000 }));
    await settle();
    expect(late).toBe(500);
    expect(el.getAttribute("data-yx-cued")).toBe("horn");
    expect(fresh.currentTime).toBe(500);
    expect(old.currentTime).toBe(0);
    await tick(1499);
    expect(el.hasAttribute("data-yx-cued")).toBe(true);
    await tick(1);
    expect(el.hasAttribute("data-yx-cued")).toBe(false);
  });

  it("counts a cue under a frame behind as on time", async () => {
    document.body.innerHTML = `<div id="a" data-yx-cue="horn"></div>`;
    const el = document.getElementById("a")!;
    const fresh = { currentTime: 0 };
    (el as unknown as { getAnimations: () => object[] }).getAnimations = () => (el.hasAttribute("data-yx-cued") ? [fresh] : []);
    await settle();
    let late = -1;
    el.addEventListener("yx:cue", (e) => (late = (e as CustomEvent).detail.late), { once: true });
    open()[0]!.send(cue({ name: "horn", at: server() - 10 }));
    await settle();
    expect(late).toBe(0);
    expect(fresh.currentTime).toBe(0);
  });

  it("skips a cue that's already over", async () => {
    document.body.innerHTML = `<div id="a" data-yx-cue="horn"></div>`;
    await settle();
    const seen = vi.fn();
    document.addEventListener("yx:cue", seen);
    open()[0]!.send(cue({ name: "horn", at: server() - 3000, lasts: 2000 }));
    open()[0]!.send(cue({ name: "horn", at: server() - 2000, lasts: 2000 }));
    await settle();
    expect(seen).not.toHaveBeenCalled();
    expect(document.getElementById("a")!.hasAttribute("data-yx-cued")).toBe(false);
    document.removeEventListener("yx:cue", seen);
  });

  it("plays a cue heard twice (a reconnect) once", async () => {
    document.body.innerHTML = `<div id="a" data-yx-cue="horn"></div>`;
    await settle();
    const seen = vi.fn();
    document.addEventListener("yx:cue", seen);
    const twice = cue({ name: "horn", at: server() + 100, lasts: 1000 });
    open()[0]!.send(twice);
    open()[0]!.send(twice);
    await tick(100);
    await settle();
    expect(seen).toHaveBeenCalledTimes(1);
    document.removeEventListener("yx:cue", seen);
  });

  it("ignores messages that aren't cues", async () => {
    document.body.innerHTML = `<div id="a" data-yx-cue="horn"></div>`;
    await settle();
    const source = open()[0]!;
    source.onmessage?.({ data: "not json" });
    source.onmessage?.({ data: "null" });
    source.send({ name: "horn" });
    source.send({ id: "z", name: "horn", room: "main", at: "soon" });
    await settle();
    expect(document.getElementById("a")!.hasAttribute("data-yx-cued")).toBe(false);
  });

  it("lets a listener play it its own way with preventDefault()", async () => {
    document.body.innerHTML = `<div id="a" data-yx-cue="horn"></div>`;
    await settle();
    const el = document.getElementById("a")!;
    el.addEventListener("yx:cue", (e) => e.preventDefault(), { once: true });
    open()[0]!.send(cue({ name: "horn", at: server() }));
    await settle();
    expect(el.hasAttribute("data-yx-cued")).toBe(false);
  });

  it("a newer cue isn't cut short by an older one ending", async () => {
    document.body.innerHTML = `<div id="a" data-yx-cue="horn drum"></div>`;
    await settle();
    const el = document.getElementById("a")!;
    open()[0]!.send(cue({ name: "horn", at: server(), lasts: 1000 }));
    await settle();
    await tick(500);
    open()[0]!.send(cue({ name: "drum", at: server(), lasts: 1000 }));
    await settle();
    expect(el.getAttribute("data-yx-cued")).toBe("drum");
    await tick(600); // horn would have ended here
    expect(el.getAttribute("data-yx-cued")).toBe("drum");
    await tick(400);
    expect(el.hasAttribute("data-yx-cued")).toBe(false);
  });

  it("plays <audio> from where everyone else is", async () => {
    document.body.innerHTML = `<audio id="a" data-yx-cue="horn"></audio>`;
    await settle();
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.reject(new Error("autoplay blocked")));
    open()[0]!.send(cue({ name: "horn", at: server() - 250, lasts: 3000 }));
    await settle();
    expect(play).toHaveBeenCalledTimes(1);
    expect((document.getElementById("a") as HTMLAudioElement).currentTime).toBe(0.25);
    play.mockRestore();
  });

  it("reopens a stream the browser gave up on, backing off", async () => {
    document.body.innerHTML = `<div data-yx-cue="horn"></div>`;
    await settle();
    const first = open()[0]!;
    first.readyState = 2;
    first.onerror?.();
    await tick(999);
    expect(FakeEventSource.all.at(-1)).toBe(first);
    await tick(1);
    const second = FakeEventSource.all.at(-1)!;
    expect(second).not.toBe(first);
    expect(rooms(second)).toEqual(["main"]);
    // A transient error the browser retries itself: left alone.
    second.readyState = 0;
    second.onerror?.();
    await tick(5000);
    expect(FakeEventSource.all.at(-1)).toBe(second);
  });

  it("doesn't reopen one for a page that no longer has cue elements", async () => {
    document.body.innerHTML = `<div data-yx-cue="horn"></div>`;
    await settle();
    const source = open()[0]!;
    source.readyState = 2;
    source.onerror?.();
    document.body.innerHTML = "";
    await settle();
    const count = FakeEventSource.all.length;
    await tick(5000);
    expect(FakeEventSource.all.length).toBe(count);
  });
});

describe("cueFrom", () => {
  it("opens the app's own stream next to the public one, and closes each when its elements go", async () => {
    document.body.innerHTML = `<div id="pub" data-yx-cue="horn"></div><div id="team" data-yx-cue="goal" data-yx-cue-from="/teams/7/cues"></div><div id="team2" data-yx-cue="goal" data-yx-cue-from="/teams/7/cues"></div>`;
    await settle();
    expect(open().map((s) => s.url).sort()).toEqual(["/_yerd/cues?room=main", "/teams/7/cues"]);
    document.getElementById("pub")!.remove();
    await settle();
    expect(open().map((s) => s.url)).toEqual(["/teams/7/cues"]);
    document.getElementById("team")!.remove();
    await settle();
    expect(open().map((s) => s.url)).toEqual(["/teams/7/cues"]);
    document.getElementById("team2")!.remove();
    await settle();
    expect(open()).toEqual([]);
  });

  it("a cue from a route plays on that route's elements only, whatever its room", async () => {
    document.body.innerHTML = `<div id="pub" data-yx-cue="goal"></div><div id="team" data-yx-cue="goal" data-yx-cue-from="/teams/7/cues"></div><div id="other" data-yx-cue="goal" data-yx-cue-from="/teams/8/cues"></div>`;
    await settle();
    const team = open().find((s) => s.url === "/teams/7/cues")!;
    team.send(cue({ name: "goal", room: "team:7", at: server() }));
    await settle();
    expect(document.getElementById("team")!.getAttribute("data-yx-cued")).toBe("goal");
    expect(document.getElementById("pub")!.hasAttribute("data-yx-cued")).toBe(false);
    expect(document.getElementById("other")!.hasAttribute("data-yx-cued")).toBe(false);
  });

  it("a public cue doesn't reach elements listening on a route", async () => {
    document.body.innerHTML = `<div id="pub" data-yx-cue="goal"></div><div id="team" data-yx-cue="goal" data-yx-cue-from="/teams/7/cues"></div>`;
    await settle();
    open().find((s) => s.url.startsWith("/_yerd/cues"))!.send(cue({ name: "goal", room: "main", at: server() }));
    await settle();
    expect(document.getElementById("pub")!.hasAttribute("data-yx-cued")).toBe(true);
    expect(document.getElementById("team")!.hasAttribute("data-yx-cued")).toBe(false);
  });

  it("cueRoom narrows what a route sends", async () => {
    document.body.innerHTML = `<div id="red" data-yx-cue="goal" data-yx-cue-from="/match/cues" data-yx-cue-room="red"></div><div id="blue" data-yx-cue="goal" data-yx-cue-from="/match/cues" data-yx-cue-room="blue"></div>`;
    await settle();
    expect(open().map((s) => s.url)).toEqual(["/match/cues"]);
    open()[0]!.send(cue({ name: "goal", room: "blue", at: server() }));
    await settle();
    expect(document.getElementById("blue")!.hasAttribute("data-yx-cued")).toBe(true);
    expect(document.getElementById("red")!.hasAttribute("data-yx-cued")).toBe(false);
  });

  it("the same cue from two sources plays on each source's elements", async () => {
    document.body.innerHTML = `<div id="pub" data-yx-cue="goal"></div><div id="team" data-yx-cue="goal" data-yx-cue-from="/teams/7/cues"></div>`;
    await settle();
    const both = cue({ name: "goal", room: "main", at: server() });
    for (const source of open()) source.send(both);
    await settle();
    expect(document.getElementById("pub")!.hasAttribute("data-yx-cued")).toBe(true);
    expect(document.getElementById("team")!.hasAttribute("data-yx-cued")).toBe(true);
  });

  it("follows a cueFrom that changes", async () => {
    document.body.innerHTML = `<div id="a" data-yx-cue="goal" data-yx-cue-from="/teams/7/cues"></div>`;
    await settle();
    document.getElementById("a")!.setAttribute("data-yx-cue-from", "/teams/8/cues");
    await settle();
    expect(open().map((s) => s.url)).toEqual(["/teams/8/cues"]);
  });

  it("reopens a route's stream the browser gave up on", async () => {
    document.body.innerHTML = `<div data-yx-cue="goal" data-yx-cue-from="/teams/7/cues"></div>`;
    await settle();
    const first = open()[0]!;
    first.readyState = 2;
    first.onerror?.();
    await tick(1000);
    expect(FakeEventSource.all.at(-1)!.url).toBe("/teams/7/cues");
    expect(FakeEventSource.all.at(-1)).not.toBe(first);
  });
});

describe("sync", () => {
  function animated(el: Element, animations: object[]) {
    (el as unknown as { getAnimations: () => object[] }).getAnimations = () => animations;
  }
  const looping = (duration: number, delay = 0) => ({
    currentTime: 0 as number | null,
    effect: { getComputedTiming: () => ({ duration, delay, iterations: Infinity }) },
  });

  it("lines infinite animations up with the server's time zero", async () => {
    const el = document.createElement("div");
    const spin = looping(1000);
    const offset = looping(600, 150);
    const once = { currentTime: 40, effect: { getComputedTiming: () => ({ duration: 1000, delay: 0, iterations: 1 }) } };
    const auto = { currentTime: 7, effect: { getComputedTiming: () => ({ duration: "auto", delay: 0, iterations: Infinity }) } };
    animated(el, [spin, offset, once, auto]);
    el.setAttribute("data-yx-sync", "");
    document.body.appendChild(el);
    await settle();
    const now = server();
    expect(spin.currentTime).toBe(now % 2000);
    expect(offset.currentTime).toBe(150 + ((now - 150) % 1200));
    expect(once.currentTime).toBe(40);
    expect(auto.currentTime).toBe(7);
  });

  it("re-aligns when an animation starts inside it", async () => {
    document.body.innerHTML = `<div id="s" data-yx-sync><span id="child"></span></div>`;
    await settle();
    const el = document.getElementById("s")!;
    const spin = looping(1000);
    animated(el, [spin]);
    await tick(333);
    document.getElementById("child")!.dispatchEvent(new Event("animationstart", { bubbles: true }));
    await tick(16);
    expect(spin.currentTime).toBe(server() % 2000);
  });

  it("leaves elements without the attribute alone", async () => {
    document.body.innerHTML = `<div id="s"><span id="child"></span></div>`;
    await settle();
    const spin = looping(1000);
    animated(document.getElementById("s")!, [spin]);
    document.getElementById("child")!.dispatchEvent(new Event("animationstart", { bubbles: true }));
    await tick(16);
    expect(spin.currentTime).toBe(0);
  });

  it("does nothing in a browser without getAnimations", async () => {
    document.body.innerHTML = `<div data-yx-sync></div>`;
    await settle();
    expect(document.querySelector("[data-yx-sync]")).not.toBeNull();
  });
});
