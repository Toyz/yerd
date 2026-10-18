import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelBackend, Cues, HttpError, MemoryBackend, action, attribute, createGuard, get, inject, param, renderToString, route, signal, sse, yerd, type Cue, type CuesOptions } from "@toyz/yerd";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => vi.restoreAllMocks());

/** A started app's Cues (and the app, to close). */
async function hub(backend?: ChannelBackend) {
  const app = yerd({ routes: [], services: [], handleSignals: false });
  if (backend) app.services((s) => s.value(ChannelBackend, backend));
  await app.boot();
  return { app, cues: app.container.get(Cues) };
}

/** Read SSE messages off a response until `count` have arrived. */
async function messages(res: Response, count: number, timeout = 2000): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const out: string[] = [];
  const deadline = Date.now() + timeout;
  while (out.length < count && Date.now() < deadline) {
    const next = await Promise.race([reader.read(), sleep(deadline - Date.now()).then(() => ({ done: true, value: undefined }))]);
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
    let end: number;
    while ((end = text.indexOf("\n\n")) !== -1) {
      const block = text.slice(0, end);
      text = text.slice(end + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      if (data) out.push(data);
    }
  }
  reader.releaseLock();
  return out;
}

describe("Cues.play", () => {
  it("schedules the cue 250ms ahead by default, or `in` ms", async () => {
    const { cues } = await hub();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const a = (await cues.play("airhorn"))!;
    expect(a).toMatchObject({ name: "airhorn", room: "main", at: 1_000_250 });
    expect(a.id).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    expect("lasts" in a).toBe(false);
    expect("data" in a).toBe(false);
    const b = (await cues.play("wave", { in: 3000, room: "stage", lasts: 2000, data: { from: "ada" } }))!;
    expect(b).toMatchObject({ name: "wave", room: "stage", at: 1_003_000, lasts: 2000, data: { from: "ada" } });
    expect(b.id).not.toBe(a.id);
    expect((await cues.play("now", { in: 0 }))!.at).toBe(1_000_000);
  });

  it("copies data the way pages will see it", async () => {
    const { cues } = await hub();
    const data = { when: new Date(0), skip: undefined, list: [1, 2] };
    const cue = (await cues.play("x", { data }))!;
    expect(cue.data).toEqual({ when: "1970-01-01T00:00:00.000Z", list: [1, 2] });
    data.list.push(3);
    expect(cue.data).toEqual({ when: "1970-01-01T00:00:00.000Z", list: [1, 2] });
  });

  it("refuses bad names, rooms, times and data", async () => {
    const { cues } = await hub();
    for (const name of ["", "has space", "x".repeat(65), "a<b", 5 as unknown as string]) {
      await expect(cues.play(name)).rejects.toThrow(/cue name/);
    }
    for (const room of ["", "x".repeat(129), "a\nb", 7 as unknown as string]) {
      await expect(cues.play("ok", { room })).rejects.toThrow(/room must be/);
    }
    for (const bad of [-1, NaN, Infinity, "5" as unknown as number]) {
      await expect(cues.play("ok", { in: bad })).rejects.toThrow(/in must be a number/);
      await expect(cues.play("ok", { lasts: bad })).rejects.toThrow(/lasts must be a number/);
      await expect(cues.play("ok", { cooldown: bad })).rejects.toThrow(/cooldown must be a number/);
    }
    await expect(cues.play("ok", { key: 1 as unknown as string })).rejects.toThrow(/key must be a string/);
    await expect(cues.play("ok", { data: { big: 1n } })).rejects.toThrow(/JSON-serializable/);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    await expect(cues.play("ok", { data: loop })).rejects.toThrow(/JSON-serializable/);
    // Nothing refused was kept for late arrivals.
    expect(cues.pending(["main"])).toEqual([]);
  });

  it("accepts the names the attribute can hold", async () => {
    const { cues } = await hub();
    for (const name of ["a", "air-horn", "team:goal", "v1.2", "x_y", "x".repeat(64)]) {
      expect((await cues.play(name))!.name).toBe(name);
    }
  });

  it("swallows plays inside the cooldown, per room and key", async () => {
    const { cues } = await hub();
    const now = vi.spyOn(Date, "now").mockReturnValue(5_000);
    expect(await cues.play("horn", { cooldown: 1000 })).toBeDefined();
    expect(await cues.play("horn", { cooldown: 1000 })).toBeUndefined();
    // Another room, another name, another key: their own windows.
    expect(await cues.play("horn", { cooldown: 1000, room: "b" })).toBeDefined();
    expect(await cues.play("drum", { cooldown: 1000 })).toBeDefined();
    expect(await cues.play("horn", { cooldown: 1000, key: "ada" })).toBeDefined();
    expect(await cues.play("horn", { cooldown: 1000, key: "ada" })).toBeUndefined();
    // Without a cooldown it isn't held back, and doesn't start a window.
    expect(await cues.play("horn")).toBeDefined();
    now.mockReturnValue(5_999);
    expect(await cues.play("horn", { cooldown: 1000 })).toBeUndefined();
    now.mockReturnValue(6_000);
    expect(await cues.play("horn", { cooldown: 1000 })).toBeDefined();
  });

  it("a swallowed play doesn't reach anyone", async () => {
    const { cues } = await hub();
    const stop = new AbortController();
    const feed = cues.listen(["main"], stop.signal);
    const first = feed.next();
    await cues.play("horn", { cooldown: 10_000 });
    await cues.play("horn", { cooldown: 10_000 });
    expect((await first).value!.name).toBe("horn");
    const second = feed.next();
    await cues.play("other");
    expect((await second).value!.name).toBe("other");
    stop.abort();
  });
});

describe("Cues.pending", () => {
  it("keeps cues that are due or still running, oldest first, per room", async () => {
    const { cues } = await hub();
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    await cues.play("later", { in: 500 });
    await cues.play("brief", { in: 0 });
    await cues.play("long", { in: 0, lasts: 3000 });
    await cues.play("elsewhere", { room: "b", in: 100 });
    // "brief" had no `lasts` and is due now: it's over for anyone arriving.
    expect(cues.pending(["main"]).map((c) => c.name)).toEqual(["long", "later"]);
    expect(cues.pending(["main", "b", "main"]).map((c) => c.name)).toEqual(["long", "elsewhere", "later"]);
    now.mockReturnValue(10_600);
    expect(cues.pending(["main"]).map((c) => c.name)).toEqual(["long"]);
    now.mockReturnValue(13_000);
    expect(cues.pending(["main", "b"])).toEqual([]);
    expect(cues.pending(["nobody"])).toEqual([]);
  });

  it("keeps a bounded number per room", async () => {
    const { cues } = await hub();
    for (let i = 0; i < 100; i++) await cues.play(`c${i}`, { in: 60_000 });
    const kept = cues.pending(["main"]);
    expect(kept.length).toBe(64);
    expect(kept[0]!.name).toBe("c36");
    expect(kept.at(-1)!.name).toBe("c99");
  });
});

describe("Cues.listen", () => {
  it("yields what's pending, then each cue as it's played, once", async () => {
    const { cues } = await hub();
    await cues.play("early", { in: 5000 });
    const stop = new AbortController();
    const feed = cues.listen(["main", "b"], stop.signal);
    expect((await feed.next()).value!.name).toBe("early");
    const next = feed.next();
    await cues.play("ignored", { room: "c" });
    await cues.play("bee", { room: "b" });
    expect((await next).value).toMatchObject({ name: "bee", room: "b" });
    stop.abort();
    expect((await feed.next()).done).toBe(true);
  });

  it("doesn't repeat a cue played between subscribing and reading what's pending", async () => {
    const { cues } = await hub();
    const stop = new AbortController();
    const feed = cues.listen(["main"], stop.signal);
    const got: string[] = [];
    const reading = (async () => {
      for await (const cue of feed) got.push(cue.name);
    })();
    await sleep(5);
    await cues.play("one");
    await cues.play("two");
    await sleep(5);
    stop.abort();
    await reading;
    expect(got).toEqual(["one", "two"]);
  });

  it("counts who's watching each room, and stops counting when they go", async () => {
    const { cues } = await hub();
    expect(cues.watching()).toBe(0);
    const a = new AbortController();
    const b = new AbortController();
    const feedA = cues.listen(["main", "vip"], a.signal);
    const feedB = cues.listen(["main"], b.signal);
    const pa = feedA.next();
    const pb = feedB.next();
    await sleep(0);
    expect(cues.watching("main")).toBe(2);
    expect(cues.watching("vip")).toBe(1);
    a.abort();
    await pa;
    expect(cues.watching()).toBe(1);
    expect(cues.watching("vip")).toBe(0);
    b.abort();
    await pb;
    expect(cues.watching()).toBe(0);
  });

  it("refuses bad rooms", async () => {
    const { cues } = await hub();
    await expect(cues.listen(["ok", ""], new AbortController().signal).next()).rejects.toThrow(/bad room/);
  });

  it("hears cues played on another instance through a shared backend, and keeps them for late arrivals there", async () => {
    const shared = new MemoryBackend();
    const one = await hub(shared);
    const two = await hub(shared);
    const stop = new AbortController();
    const feed = two.cues.listen(["main"], stop.signal);
    const next = feed.next();
    await one.cues.play("cross", { lasts: 5000 });
    expect((await next).value!.name).toBe("cross");
    expect(two.cues.pending(["main"]).map((c) => c.name)).toEqual(["cross"]);
    stop.abort();
  });
});

@route("/rave")
class Rave {
  @inject(Cues) accessor cues!: Cues;
  @action async horn() {
    await this.cues.play("horn", { lasts: 1000 });
  }
  @get page() {
    return (
      <main>
        <p>{this.cues.watching()}</p>
        <button action={this.horn}>horn</button>
      </main>
    );
  }
}

describe("/_yerd/clock", () => {
  it("answers with the server's time, never cached", async () => {
    const app = yerd({ routes: [], services: [], handleSignals: false });
    const before = Date.now();
    const res = await app.request("/_yerd/clock");
    const after = Date.now();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    const { now } = (await res.json()) as { now: number };
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
    const head = await app.request("/_yerd/clock", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("leaves other methods to the app", async () => {
    const app = yerd({ routes: [], services: [], handleSignals: false });
    expect((await app.request("/_yerd/clock", { method: "POST" })).status).toBe(404);
    expect((await app.request("/_yerd/clock/x")).status).toBe(404);
  });
});

describe("/_yerd/cues", () => {
  it("streams pending cues, then new ones, for the asked rooms", async () => {
    const app = yerd({ routes: [Rave], services: [], handleSignals: false });
    const server = await app.listen(0, "127.0.0.1");
    try {
      const cues = app.container.get(Cues);
      await cues.play("early", { in: 10_000 });
      await cues.play("vip-only", { room: "vip", in: 10_000 });
      const abort = new AbortController();
      const res = await fetch(server.url + "/_yerd/cues?room=main", { signal: abort.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
      const reading = messages(res, 2);
      await sleep(20);
      await cues.play("live", { data: { n: 1 } });
      const [first, second] = (await reading).map((m) => JSON.parse(m) as Cue);
      expect(first!.name).toBe("early");
      expect(second).toMatchObject({ name: "live", room: "main", data: { n: 1 } });
      expect(cues.watching()).toBe(1);
      abort.abort();
      await sleep(30);
      expect(cues.watching()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("listens to the default room without a room, and to several with several", async () => {
    const app = yerd({ routes: [], services: [], handleSignals: false, cues: { public: true } });
    const server = await app.listen(0, "127.0.0.1");
    try {
      const cues = app.container.get(Cues);
      const a = new AbortController();
      const b = new AbortController();
      const plain = await fetch(server.url + "/_yerd/cues", { signal: a.signal });
      const many = await fetch(server.url + "/_yerd/cues?room=x&room=" + encodeURIComponent("team:7") + "&room=x", { signal: b.signal });
      await sleep(20);
      expect(cues.watching("main")).toBe(1);
      expect(cues.watching("team:7")).toBe(1);
      expect(cues.watching("x")).toBe(1);
      const gotPlain = messages(plain, 1);
      const gotMany = messages(many, 2);
      await cues.play("m");
      await cues.play("t", { room: "team:7" });
      await cues.play("x1", { room: "x" });
      expect((await gotPlain).map((m) => (JSON.parse(m) as Cue).name)).toEqual(["m"]);
      expect((await gotMany).map((m) => (JSON.parse(m) as Cue).name)).toEqual(["t", "x1"]);
      a.abort();
      b.abort();
    } finally {
      await server.close();
    }
  });

  it("refuses bad rooms and too many of them", async () => {
    const app = yerd({ routes: [], services: [], handleSignals: false, cues: { public: true } });
    const server = await app.listen(0, "127.0.0.1");
    try {
      expect((await fetch(server.url + "/_yerd/cues?room=")).status).toBe(400);
      expect((await fetch(server.url + "/_yerd/cues?room=" + "x".repeat(200))).status).toBe(400);
      expect((await fetch(server.url + "/_yerd/cues?room=a%0Ab")).status).toBe(400);
      const many = Array.from({ length: 33 }, (_, i) => `room=r${i}`).join("&");
      expect((await fetch(server.url + "/_yerd/cues?" + many)).status).toBe(400);
      expect(app.container.get(Cues).watching()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("sends a reconnect delay first", async () => {
    const app = yerd({ routes: [], services: [], handleSignals: false });
    const server = await app.listen(0, "127.0.0.1");
    try {
      const abort = new AbortController();
      const res = await fetch(server.url + "/_yerd/cues", { signal: abort.signal });
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe("retry: 2000\n\n");
      abort.abort();
    } finally {
      await server.close();
    }
  });

  it("ends open cue streams when the server shuts down", async () => {
    const app = yerd({ routes: [], services: [], handleSignals: false, shutdownTimeout: 5000 });
    const server = await app.listen(0, "127.0.0.1");
    const res = await fetch(server.url + "/_yerd/cues");
    const reader = res.body!.getReader();
    await reader.read();
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(app.container.get(Cues).watching()).toBe(0);
  });

  it("isn't served for other methods", async () => {
    const app = yerd({ routes: [], services: [], handleSignals: false });
    expect((await app.request("/_yerd/cues", { method: "POST" })).status).not.toBe(200);
  });
});

describe("Cues in an app", () => {
  it("is one shared instance, injectable into routes", async () => {
    const app = yerd({ routes: [Rave], services: [], handleSignals: false });
    await app.boot();
    const client = app.client();
    expect(await client.page("/rave")).toContain("<p>0</p>");
    const stop = new AbortController();
    const feed = app.container.get(Cues).listen(["main"], stop.signal);
    const next = feed.next();
    expect((await client.action("/rave")).ok).toBe(true);
    expect((await next).value).toMatchObject({ name: "horn", lasts: 1000 });
    stop.abort();
  });

  it("can be replaced through services", async () => {
    class Quiet extends Cues {
      override async play(): Promise<Cue | undefined> {
        return undefined;
      }
    }
    const app = yerd({ routes: [], services: [], handleSignals: false });
    app.services((s) => s.singleton(Cues, Quiet));
    await app.boot();
    expect(app.container.get(Cues)).toBeInstanceOf(Quiet);
  });
});

describe("sync / cue / cueRoom props", () => {
  it("render as the runtime's attributes", async () => {
    expect(await renderToString(<div sync />)).toBe("<div data-yx-sync></div>");
    expect(await renderToString(<div sync={false} />)).toBe("<div></div>");
    expect(await renderToString(<img cue="airhorn" alt="" />)).toBe('<img alt="" data-yx-cue="airhorn">');
    expect(await renderToString(<div cue={["a", "b"]} cueRoom="team:1" />)).toBe('<div data-yx-cue="a b" data-yx-cue-room="team:1"></div>');
    expect(await renderToString(<audio cue="horn" sync src="/h.mp3" />)).toBe('<audio src="/h.mp3" data-yx-sync data-yx-cue="horn"></audio>');
  });

  it("drop a room with no cue, and an empty cue", async () => {
    expect(await renderToString(<div cueRoom="x" />)).toBe("<div></div>");
    expect(await renderToString(<div cue="" cueRoom="x" />)).toBe("<div></div>");
    expect(await renderToString(<div cue={[]} />)).toBe("<div></div>");
  });

  it("escape what they're given", async () => {
    expect(await renderToString(<div cue={'a"b'} cueRoom="<x>" />)).toBe('<div data-yx-cue="a&quot;b" data-yx-cue-room="&lt;x&gt;"></div>');
  });
});

describe("reserved names", () => {
  it("sync and cue can't be custom attributes (the renderer handles them)", () => {
    expect(() => attribute("sync", {})).toThrow(/built-in yerd attribute/);
    expect(() => attribute("cue", {})).toThrow(/built-in yerd attribute/);
  });
});

describe("public and private rooms", () => {
  /** The status /_yerd/cues answers for these rooms, under `cues`. */
  async function status(cues: CuesOptions | undefined, rooms: string[]): Promise<number> {
    const app = yerd({ routes: [], services: [], handleSignals: false, cues });
    const server = await app.listen(0, "127.0.0.1");
    try {
      const abort = new AbortController();
      const res = await fetch(server.url + "/_yerd/cues" + (rooms.length ? "?" + rooms.map((r) => `room=${encodeURIComponent(r)}`).join("&") : ""), { signal: abort.signal });
      abort.abort();
      return res.status;
    } finally {
      await server.close();
    }
  }

  it("serves only the main room by default", async () => {
    expect(await status(undefined, [])).toBe(200);
    expect(await status(undefined, ["main"])).toBe(200);
    expect(await status(undefined, ["rave"])).toBe(403);
    expect(await status(undefined, ["main", "rave"])).toBe(403);
    expect(await status({}, ["rave"])).toBe(403);
  });

  it("takes a list, a function, true or false", async () => {
    expect(await status({ public: ["main", "rave"] }, ["main", "rave"])).toBe(200);
    expect(await status({ public: ["rave"] }, ["main"])).toBe(403);
    expect(await status({ public: ["rave"] }, [])).toBe(403);
    expect(await status({ public: (room) => room.startsWith("lobby:") }, ["lobby:1", "lobby:2"])).toBe(200);
    expect(await status({ public: (room) => room.startsWith("lobby:") }, ["team:1"])).toBe(403);
    expect(await status({ public: true }, ["anything", "at:all"])).toBe(200);
    expect(await status({ public: false }, [])).toBe(403);
    expect(await status({ public: false }, ["main"])).toBe(403);
  });

  it("a function that doesn't return true refuses", async () => {
    expect(await status({ public: (() => "yes") as unknown as (room: string) => boolean }, ["main"])).toBe(403);
  });

  it("checks rooms are valid before whether they're public", async () => {
    expect(await status(undefined, [""])).toBe(400);
  });

  const onTeam = createGuard("onTeam", (ctx) => {
    return ctx.headers["x-team"] === ctx.params.id ? true : new HttpError(403, "not your team");
  });

  @route("/teams/:id/cues", { guards: [onTeam] })
  class TeamCues {
    @inject(Cues) accessor cues!: Cues;
    @param("id") accessor id!: string;
    @signal accessor stop!: AbortSignal;

    @get @sse({ heartbeat: 0 }) feed() {
      return this.cues.listen([`team:${this.id}`], this.stop);
    }
  }

  it("a private room streams from the app's own guarded route", async () => {
    const app = yerd({ routes: [TeamCues], services: [], handleSignals: false });
    const server = await app.listen(0, "127.0.0.1");
    try {
      expect((await fetch(server.url + "/teams/7/cues", { headers: { "x-team": "8" } })).status).toBe(403);
      expect((await fetch(server.url + "/_yerd/cues?room=team%3A7")).status).toBe(403);
      const abort = new AbortController();
      const res = await fetch(server.url + "/teams/7/cues", { headers: { "x-team": "7" }, signal: abort.signal });
      expect(res.status).toBe(200);
      const got = messages(res, 1);
      await sleep(20);
      const cues = app.container.get(Cues);
      await cues.play("other", { room: "team:8" });
      await cues.play("goal", { room: "team:7", data: { by: "ada" } });
      expect((await got).map((m) => JSON.parse(m) as Cue)).toMatchObject([{ name: "goal", room: "team:7", data: { by: "ada" } }]);
      expect(cues.watching("team:7")).toBe(1);
      abort.abort();
    } finally {
      await server.close();
    }
  });
});

describe("cueFrom", () => {
  it("renders with a cue, and not without one", async () => {
    expect(await renderToString(<div cue="goal" cueFrom="/teams/7/cues" />)).toBe('<div data-yx-cue="goal" data-yx-cue-from="/teams/7/cues"></div>');
    expect(await renderToString(<div cue="goal" cueFrom="/t" cueRoom="team:7" />)).toBe('<div data-yx-cue="goal" data-yx-cue-room="team:7" data-yx-cue-from="/t"></div>');
    expect(await renderToString(<div cueFrom="/t" />)).toBe("<div></div>");
    expect(await renderToString(<div cue="a" cueFrom={'/t?a=1&b="2"'} />)).toBe('<div data-yx-cue="a" data-yx-cue-from="/t?a=1&amp;b=&quot;2&quot;"></div>');
  });
});
