import { describe, expect, it } from "vitest";
import {
  ChannelBackend, Channels, MemoryBackend, channel, get, header, inject, route, signal, sse, yerd,
} from "@toyz/yerd";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ping {
  n: number;
}
const userChannel = (id: string) => channel<Ping>(`user:${id}`);

async function hub() {
  const app = yerd({ routes: [], services: [] });
  await app.boot();
  return app.container.get(Channels);
}

/** Collect what a subscription yields until `count` messages arrive. */
async function take<T>(source: AsyncGenerator<T>, count: number): Promise<T[]> {
  const out: T[] = [];
  for await (const message of source) {
    out.push(message);
    if (out.length === count) break;
  }
  return out;
}

describe("Channels", () => {
  it("is built in and delivers only to that channel's subscribers", async () => {
    const channels = await hub();
    const abort = new AbortController();
    const ada = take(channels.subscribe(userChannel("ada"), abort.signal), 2);
    const bob = take(channels.subscribe(userChannel("bob"), abort.signal), 1);
    await sleep(1);
    await channels.publish(userChannel("ada"), { n: 1 });
    await channels.publish(userChannel("bob"), { n: 99 });
    await channels.publish(userChannel("ada"), { n: 2 });
    expect(await ada).toEqual([{ n: 1 }, { n: 2 }]);
    expect(await bob).toEqual([{ n: 99 }]);
    abort.abort();
  });

  it("subscribes to several channels at once", async () => {
    const channels = await hub();
    const abort = new AbortController();
    const both = take(channels.subscribe([userChannel("a"), userChannel("b")], abort.signal), 2);
    await sleep(1);
    await channels.publish(userChannel("b"), { n: 2 });
    await channels.publish(userChannel("a"), { n: 1 });
    expect(await both).toEqual([{ n: 2 }, { n: 1 }]);
    abort.abort();
  });

  it("unsubscribes when the signal aborts", async () => {
    const backend = new MemoryBackend();
    const app = yerd({ routes: [], services: [] }).services((s) => s.value(ChannelBackend, backend));
    await app.boot();
    const channels = app.container.get(Channels);
    const abort = new AbortController();
    const done = take(channels.subscribe("room", abort.signal), 5);
    await sleep(1);
    expect(backend.listeners("room")).toBe(1);
    abort.abort();
    await done;
    expect(backend.listeners("room")).toBe(0);
  });

  it("drops the oldest messages for a subscriber that falls too far behind", async () => {
    const channels = await hub();
    const abort = new AbortController();
    const warn = console.warn;
    console.warn = () => {};
    try {
      const source = channels.subscribe("busy", abort.signal, { buffer: 3 });
      const first = source.next();
      await sleep(1);
      for (let n = 1; n <= 6; n++) await channels.publish("busy", { n });
      // The first message was handed over straight away; the queue kept the newest 3 of the rest.
      expect((await first).value).toEqual({ n: 1 });
      expect(await take(source, 3)).toEqual([{ n: 4 }, { n: 5 }, { n: 6 }]);
    } finally {
      console.warn = warn;
      abort.abort();
    }
  });

  it("subscribes eagerly: messages published before the first read are kept", async () => {
    const channels = await hub();
    const abort = new AbortController();
    const source = channels.subscribe("early", abort.signal);
    await channels.publish("early", { n: 1 });
    await channels.publish("early", { n: 2 });
    expect(await take(source, 2)).toEqual([{ n: 1 }, { n: 2 }]);
    abort.abort();
  });

  it("cleans up on return(), and a subscription never read once the signal aborts", async () => {
    const backend = new MemoryBackend();
    const app = yerd({ routes: [], services: [] }).services((s) => s.value(ChannelBackend, backend));
    await app.boot();
    const channels = app.container.get(Channels);
    const abort = new AbortController();
    const unread = channels.subscribe("room", abort.signal);
    const broken = channels.subscribe("room", new AbortController().signal);
    expect(backend.listeners("room")).toBe(2);
    await broken.return(undefined);
    expect(backend.listeners("room")).toBe(1);
    abort.abort();
    expect(backend.listeners("room")).toBe(0);
    expect(await unread.next()).toEqual({ value: undefined, done: true });
    // Already aborted: never subscribes.
    channels.subscribe("room", abort.signal);
    expect(backend.listeners("room")).toBe(0);
  });

  it("unsubscribes the earlier channels when the backend fails on a later one", async () => {
    const memory = new MemoryBackend();
    const flaky: ChannelBackend = {
      publish: (c, m) => memory.publish(c, m),
      subscribe(c, listener) {
        if (c === "bad") throw new Error("backend down");
        return memory.subscribe(c, listener);
      },
    };
    const app = yerd({ routes: [], services: [] }).services((s) => s.value(ChannelBackend, flaky));
    await app.boot();
    const channels = app.container.get(Channels);
    expect(() => channels.subscribe(["good", "bad"], new AbortController().signal)).toThrow(/backend down/);
    expect(memory.listeners("good")).toBe(0);
  });

  it("type-checks messages for typed channels", async () => {
    const channels = await hub();
    // @ts-expect-error a Ping has a number `n`
    await channels.publish(userChannel("x"), { n: "nope" });
    await channels.publish("untyped", { anything: true });
  });
});

@route("/live")
class Live {
  @inject(Channels) accessor channels!: Channels;
  @header("x-user") accessor user: string | undefined;
  @signal accessor stop!: AbortSignal;

  @get @sse({ heartbeat: 0 }) feed() {
    return this.channels.subscribe(userChannel(this.user ?? "anon"), this.stop);
  }
}

describe("per-user live feeds", () => {
  it("streams a channel over SSE, and only that user's channel", async () => {
    const app = yerd({ routes: [Live], services: [], handleSignals: false });
    const server = await app.listen(0, "127.0.0.1");
    try {
      const abort = new AbortController();
      const r = await fetch(server.url + "/live", { headers: { "x-user": "ada" }, signal: abort.signal });
      const reader = r.body!.getReader();
      const channels = app.container.get(Channels);
      await sleep(20);
      await channels.publish(userChannel("bob"), { n: 0 });
      await channels.publish(userChannel("ada"), { n: 7 });
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe('data: {"n":7}\n\n');
      abort.abort();
    } finally {
      await server.close();
    }
  });
});
