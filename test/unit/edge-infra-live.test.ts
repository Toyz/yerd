import { describe, expect, it } from "vitest";
import { request } from "node:http";
import {
  ChannelBackend, Channels, HttpError, ILogger, MemoryBackend, YerdResponse, channel, event, get, inject, ndjson, route, signal, sse, yerd,
  type LogRecord,
} from "@toyz/yerd";
import { formatEvent } from "../../src/respond/stream.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Everything a streaming response's body produces, joined. */
async function drain(response: unknown): Promise<string> {
  let out = "";
  for await (const chunk of (response as YerdResponse).body as AsyncIterable<string>) out += chunk;
  return out;
}

async function* items<T>(...values: T[]): AsyncGenerator<T> {
  for (const value of values) yield value;
}

async function hub(backend?: ChannelBackend) {
  const app = yerd({ routes: [], services: [] });
  if (backend) app.services((s) => s.value(ChannelBackend, backend));
  await app.boot();
  return { app, channels: app.container.get(Channels) };
}

describe("formatEvent: SSE framing", () => {
  it.each([
    ["plain string", "hi", "data: hi\n\n"],
    ["empty string", "", "data: \n\n"],
    ["LF lines", "a\nb", "data: a\ndata: b\n\n"],
    ["CRLF lines", "a\r\nb", "data: a\ndata: b\n\n"],
    ["CR lines", "a\rb", "data: a\ndata: b\n\n"],
    ["mixed endings", "a\r\n\r\nb\rc\n", "data: a\ndata: \ndata: b\ndata: c\ndata: \n\n"],
    ["a forged field inside data", "x\nevent: admin\nid: 1", "data: x\ndata: event: admin\ndata: id: 1\n\n"],
    ["a forged blank line inside data", "x\n\ndata: y", "data: x\ndata: \ndata: data: y\n\n"],
    ["unicode", "café 日本   \u0000", "data: café 日本   \u0000\n\n"],
    ["an object", { a: "b\nc" }, 'data: {"a":"b\\nc"}\n\n'],
    ["zero", 0, "data: 0\n\n"],
    ["false", false, "data: false\n\n"],
    ["null", null, "data: null\n\n"],
    ["an array", [1, "two"], 'data: [1,"two"]\n\n'],
    ["undefined (no data field: an event EventSource ignores)", undefined, "\n"],
    ["a function (not JSON)", () => 1, "data: null\n\n"],
  ])("%s", (_label, value, expected) => {
    expect(formatEvent(value)).toBe(expected);
  });

  it("writes comment, event, id, retry and data in that order", () => {
    expect(formatEvent(event({ data: "d", retry: 10, id: "7", event: "e", comment: "c" }))).toBe(
      ": c\nevent: e\nid: 7\nretry: 10\ndata: d\n\n",
    );
  });

  it.each([
    ["event", { event: "x\r\ndata: injected\n\nevent: y" }, "event: xdata: injectedevent: y\n\n"],
    ["id", { id: "1\nretry: 0\r\n" }, "id: 1retry: 0\n\n"],
    ["comment", { comment: "ok\ndata: forged" }, ": okdata: forged\n\n"],
    ["lone CR in event", { event: "a\rb" }, "event: ab\n\n"],
  ])("strips CR/LF from a single-line %s field, so it can't start new fields or events", (_field, init, expected) => {
    expect(formatEvent(event(init))).toBe(expected);
  });

  it.each([
    [1500, "retry: 1500\n"],
    [1500.9, "retry: 1500\n"],
    [-5, "retry: 0\n"],
    [0, "retry: 0\n"],
    [Number.NaN, ""],
    [Number.POSITIVE_INFINITY, ""],
    [Number.NEGATIVE_INFINITY, ""],
  ])("retry %s is written as %j", (retry, line) => {
    expect(formatEvent(event({ retry }))).toBe(`${line}\n`);
  });

  it("keeps an empty id (it resets the client's last event id)", () => {
    expect(formatEvent(event({ id: "" }))).toBe("id: \n\n");
  });

  it("sends a yielded object that merely looks like an event as data", () => {
    expect(formatEvent({ event: "admin", id: "1", data: "x" })).toBe('data: {"event":"admin","id":"1","data":"x"}\n\n');
    // The brand is a symbol, which JSON from a client can't carry.
    expect(formatEvent(JSON.parse('{"event":"admin"}'))).toBe('data: {"event":"admin"}\n\n');
  });

  it("event() copies its input, so later edits don't leak into it", () => {
    const init = { event: "a", data: 1 };
    const e = event(init);
    init.event = "b";
    expect(formatEvent(e)).toBe("event: a\ndata: 1\n\n");
  });
});

describe("sse() streams", () => {
  it("sets stream headers and status", () => {
    const r = sse(items(1));
    expect(r.status).toBe(200);
    expect(r.headers).toMatchObject({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    });
  });

  it.each([
    [{ retry: 3000 }, "retry: 3000\n\n"],
    [{ retry: 2.5 }, "retry: 2\n\n"],
    [{ retry: -1 }, "retry: 0\n\n"],
    [{ retry: Number.NaN }, ""],
    [{}, ""],
  ])("with options %j starts with %j", async (options, start) => {
    expect(await drain(sse(items("x"), { heartbeat: 0, ...options }))).toBe(`${start}data: x\n\n`);
  });

  it("ends a stream that throws with a generic error event, or exposes an HttpError's message", async () => {
    async function* fails(error: unknown) {
      yield "a";
      throw error;
    }
    expect(await drain(sse(fails(new Error("db password leaked")), { heartbeat: 0 }))).toBe(
      'data: a\n\nevent: error\ndata: {"error":"Internal Server Error"}\n\n',
    );
    expect(await drain(sse(fails(new HttpError(409, "conflict")), { heartbeat: 0 }))).toBe(
      'data: a\n\nevent: error\ndata: {"error":"conflict"}\n\n',
    );
  });

  it("rethrows instead of sending an error event when errorEvent is false", async () => {
    async function* fails() {
      yield "a";
      throw new Error("x");
    }
    await expect(drain(sse(fails(), { heartbeat: 0, errorEvent: false }))).rejects.toThrow("x");
  });

  it("turns unserializable data (BigInt) into an error event instead of crashing", async () => {
    expect(await drain(sse(items({ n: 1n }), { heartbeat: 0 }))).toBe('event: error\ndata: {"error":"Internal Server Error"}\n\n');
  });

  it("sends ping comments while the source is quiet, and stops them once it ends", async () => {
    async function* slow() {
      await sleep(70);
      yield "done";
    }
    const text = await drain(sse(slow(), { heartbeat: 15 }));
    expect(text.endsWith("data: done\n\n")).toBe(true);
    const pings = text.split(": ping\n\n").length - 1;
    expect(pings).toBeGreaterThanOrEqual(2);
    expect(text.replaceAll(": ping\n\n", "")).toBe("data: done\n\n");
  });

  it("closes the source when the consumer stops early", async () => {
    let finished = false;
    async function* endless() {
      try {
        for (let i = 0; ; i++) yield i;
      } finally {
        finished = true;
      }
    }
    const body = sse(endless(), { heartbeat: 0 }).body as AsyncGenerator<string>;
    expect((await body.next()).value).toBe("data: 0\n\n");
    await body.return(undefined);
    expect(finished).toBe(true);
  });
});

describe("ndjson() streams", () => {
  it.each([
    ["objects", [{ a: 1 }, { b: [2] }], '{"a":1}\n{"b":[2]}\n'],
    ["strings with newlines stay on one line", ["a\nb", "c\r\nd"], '"a\\nb"\n"c\\r\\nd"\n'],
    ["unicode line separators are escaped or kept inside a string", ["  "], '"  "\n'],
    ["primitives", [1, true, null, "s"], '1\ntrue\nnull\n"s"\n'],
    ["undefined becomes null, keeping every line valid JSON", [undefined], "null\n"],
    ["a function becomes null", [() => 1], "null\n"],
    ["dates use toJSON", [new Date(0)], '"1970-01-01T00:00:00.000Z"\n'],
  ])("%s", async (_label, values, expected) => {
    expect(await drain(ndjson(items(...values)))).toBe(expected);
  });

  it("every line it writes parses as JSON", async () => {
    const values = [undefined, null, 0, "", { x: undefined }, [undefined], () => 1, Symbol("s")];
    const text = await drain(ndjson(items(...values)));
    for (const line of text.trimEnd().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("ends with an error line on a mid-stream failure, generic unless exposed", async () => {
    async function* fails(error: unknown) {
      yield 1;
      throw error;
    }
    expect(await drain(ndjson(fails(new Error("internal"))))).toBe('1\n{"error":"Internal Server Error"}\n');
    expect(await drain(ndjson(fails(new HttpError(422, "bad row 3"))))).toBe('1\n{"error":"bad row 3"}\n');
    expect(await drain(ndjson(fails(new HttpError(503, "upstream token=abc"))))).toBe('1\n{"error":"Internal Server Error"}\n');
    expect(await drain(ndjson(fails(new HttpError(400, "hidden", { expose: false }))))).toBe('1\n{"error":"Internal Server Error"}\n');
  });

  it("rethrows when errorLine is false", async () => {
    async function* fails() {
      yield 1;
      throw new Error("x");
    }
    await expect(drain(ndjson(fails(), { errorLine: false }))).rejects.toThrow("x");
  });

  it("turns a BigInt item into an error line", async () => {
    expect(await drain(ndjson(items({ ok: 1 }, { n: 2n })))).toBe('{"ok":1}\n{"error":"Internal Server Error"}\n');
  });

  it("writes blank heartbeat lines only while quiet (default off)", async () => {
    async function* slow() {
      await sleep(50);
      yield 1;
    }
    expect(await drain(ndjson(slow()))).toBe("1\n");
    const text = await drain(ndjson(slow(), { heartbeat: 10 }));
    expect(text.endsWith("1\n")).toBe(true);
    expect(text.replace(/^\n+/, "")).toBe("1\n");
    expect(text.length).toBeGreaterThan(2);
  });

  it("runs the source's finally when the consumer stops early", async () => {
    const log: string[] = [];
    async function* source() {
      try {
        yield 1;
        yield 2;
      } finally {
        log.push("finally");
      }
    }
    const body = ndjson(source()).body as AsyncGenerator<string>;
    await body.next();
    await body.return(undefined);
    expect(log).toEqual(["finally"]);
  });
});

describe("Channels: edge cases", () => {
  it("delivers every message, in order, to many subscribers", async () => {
    const { channels } = await hub();
    const abort = new AbortController();
    const subs = Array.from({ length: 500 }, () => channels.subscribe("room", abort.signal));
    for (let i = 0; i < 5; i++) await channels.publish("room", i);
    for (const sub of subs) {
      const got: unknown[] = [];
      for (let i = 0; i < 5; i++) got.push((await sub.next()).value);
      expect(got).toEqual([0, 1, 2, 3, 4]);
    }
    abort.abort();
    expect((channels.backend as MemoryBackend).listeners("room")).toBe(0);
  });

  it("keeps only the newest `buffer` messages for a subscriber that isn't reading", async () => {
    const { channels } = await hub();
    const abort = new AbortController();
    const sub = channels.subscribe("c", abort.signal, { buffer: 2 });
    for (let i = 0; i < 6; i++) await channels.publish("c", i);
    expect((await sub.next()).value).toBe(4);
    expect((await sub.next()).value).toBe(5);
    abort.abort();
    expect(await sub.next()).toEqual({ value: undefined, done: true });
  });

  it("with buffer 0, hands messages only to a reader already waiting", async () => {
    const { channels } = await hub();
    const abort = new AbortController();
    const sub = channels.subscribe("c", abort.signal, { buffer: 0 });
    await channels.publish("c", "dropped");
    const waiting = sub.next();
    await channels.publish("c", "kept");
    expect((await waiting).value).toBe("kept");
    abort.abort();
  });

  it("hands queued messages to concurrent next() calls in order", async () => {
    const { channels } = await hub();
    const abort = new AbortController();
    const sub = channels.subscribe("c", abort.signal);
    const [a, b, c] = [sub.next(), sub.next(), sub.next()];
    await channels.publish("c", 1);
    await channels.publish("c", 2);
    abort.abort();
    expect(await Promise.all([a, b, c])).toEqual([
      { value: 1, done: false },
      { value: 2, done: false },
      { value: undefined, done: true },
    ]);
  });

  it("handles publishing to the same channel from inside the loop without recursion or loss", async () => {
    const { channels } = await hub();
    const abort = new AbortController();
    const sub = channels.subscribe<string>("echo", abort.signal);
    await channels.publish("echo", 0);
    const seen: unknown[] = [];
    for await (const n of sub) {
      seen.push(n);
      if ((n as number) < 4) await channels.publish("echo", (n as number) + 1);
      else break;
    }
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect((channels.backend as MemoryBackend).listeners("echo")).toBe(0);
  });

  it("doesn't deliver a message to a subscriber added while that message is being published", async () => {
    const backend = new MemoryBackend();
    const got: string[] = [];
    backend.subscribe("c", (m) => {
      got.push(`first:${m}`);
      backend.subscribe("c", (n) => got.push(`late:${n}`));
    });
    backend.publish("c", 1);
    expect(got).toEqual(["first:1"]);
  });

  it("closes at once for an already-aborted signal, without subscribing", async () => {
    const { channels } = await hub();
    const sub = channels.subscribe("c", AbortSignal.abort());
    expect((channels.backend as MemoryBackend).listeners("c")).toBe(0);
    expect(await sub.next()).toEqual({ value: undefined, done: true });
  });

  it("ends a pending read and unsubscribes when the signal aborts; later publishes go nowhere", async () => {
    const { channels } = await hub();
    const abort = new AbortController();
    const sub = channels.subscribe("c", abort.signal);
    const pending = sub.next();
    abort.abort();
    expect(await pending).toEqual({ value: undefined, done: true });
    await channels.publish("c", 1);
    expect(await sub.next()).toEqual({ value: undefined, done: true });
    expect((channels.backend as MemoryBackend).listeners("c")).toBe(0);
  });

  it("drops queued messages on close and stays closed", async () => {
    const { channels } = await hub();
    const abort = new AbortController();
    const sub = channels.subscribe("c", abort.signal);
    await channels.publish("c", 1);
    await sub.return(undefined);
    expect(await sub.next()).toEqual({ value: undefined, done: true });
    // Closing again (return, abort, dispose) is harmless.
    await sub.return(undefined);
    abort.abort();
    await sub[Symbol.asyncDispose]();
  });

  it("throw() closes the subscription and rejects with the error", async () => {
    const { channels } = await hub();
    const abort = new AbortController();
    const sub = channels.subscribe("c", abort.signal);
    await expect(sub.throw(new Error("stop"))).rejects.toThrow("stop");
    expect((channels.backend as MemoryBackend).listeners("c")).toBe(0);
  });

  it("closes with `await using`", async () => {
    const { channels } = await hub();
    const abort = new AbortController();
    {
      await using sub = channels.subscribe("c", abort.signal);
      expect((channels.backend as MemoryBackend).listeners("c")).toBe(1);
      void sub;
    }
    expect((channels.backend as MemoryBackend).listeners("c")).toBe(0);
  });

  it("removes its abort listener when closed early (no listener leak on a long-lived signal)", async () => {
    const { channels } = await hub();
    const abort = new AbortController();
    let added = 0;
    let removed = 0;
    const add = abort.signal.addEventListener.bind(abort.signal);
    const remove = abort.signal.removeEventListener.bind(abort.signal);
    abort.signal.addEventListener = ((...a: Parameters<typeof add>) => (added++, add(...a))) as typeof add;
    abort.signal.removeEventListener = ((...a: Parameters<typeof remove>) => (removed++, remove(...a))) as typeof remove;
    for (let i = 0; i < 10; i++) await channels.subscribe("c", abort.signal).return(undefined);
    expect([added, removed]).toEqual([10, 10]);
  });

  it("listing a channel twice delivers each message once", async () => {
    const { channels } = await hub();
    const abort = new AbortController();
    const sub = channels.subscribe(["c", "c"], abort.signal);
    await channels.publish("c", 1);
    await channels.publish("c", 2);
    expect((await sub.next()).value).toBe(1);
    expect((await sub.next()).value).toBe(2);
    abort.abort();
    expect((channels.backend as MemoryBackend).listeners("c")).toBe(0);
  });

  it("treats a channel() ref and its plain name as the same channel", async () => {
    const { channels } = await hub();
    const abort = new AbortController();
    const sub = channels.subscribe(channel<number>("same"), abort.signal);
    await channels.publish("same", 9);
    expect((await sub.next()).value).toBe(9);
    abort.abort();
  });

  it("interleaves several channels in publish order", async () => {
    const { channels } = await hub();
    const abort = new AbortController();
    const sub = channels.subscribe(["a", "b"], abort.signal);
    await channels.publish("a", 1);
    await channels.publish("b", 2);
    await channels.publish("a", 3);
    const got = [(await sub.next()).value, (await sub.next()).value, (await sub.next()).value];
    expect(got).toEqual([1, 2, 3]);
    abort.abort();
  });

  it("an empty channel list ends only when the signal aborts", async () => {
    const { channels } = await hub();
    const abort = new AbortController();
    const sub = channels.subscribe([], abort.signal);
    const pending = sub.next();
    setTimeout(() => abort.abort(), 5);
    expect(await pending).toEqual({ value: undefined, done: true });
  });

  it("uses a registered backend, awaiting its publish and surfacing its failures", async () => {
    const sent: Array<[string, unknown]> = [];
    const backend: ChannelBackend = {
      async publish(name, message) {
        await sleep(1);
        if (name === "bad") throw new Error("backend down");
        sent.push([name, message]);
      },
      subscribe: () => () => {},
    };
    const { channels } = await hub(backend);
    expect(channels.backend).toBe(backend);
    await channels.publish("ok", 1);
    expect(sent).toEqual([["ok", 1]]);
    await expect(channels.publish("bad", 2)).rejects.toThrow("backend down");
  });

  it("MemoryBackend: a stop function called twice doesn't unsubscribe someone who joined in between", () => {
    const backend = new MemoryBackend();
    const got: unknown[] = [];
    const stop = backend.subscribe("c", () => {});
    stop();
    backend.subscribe("c", (m) => got.push(m));
    stop();
    backend.publish("c", "still here");
    expect(got).toEqual(["still here"]);
    expect(backend.listeners("c")).toBe(1);
  });

  it("warns once per subscriber when it starts dropping messages", async () => {
    const records: LogRecord[] = [];
    const app = yerd({ routes: [], services: [] }).services((s) => s.value(ILogger, { write: (r) => records.push(r) }));
    await app.boot();
    const channels = app.container.get(Channels);
    const abort = new AbortController();
    await app.scope(async () => {
      channels.subscribe("c", abort.signal, { buffer: 1 });
      for (let i = 0; i < 10; i++) await channels.publish("c", i);
    });
    const warnings = records.filter((r) => r.target === "yerd::channels");
    expect(warnings.map((r) => [r.level, r.message])).toEqual([["warn", "a channel subscriber fell 1 messages behind; dropping the oldest"]]);
    abort.abort();
  });
});

describe("live streams over HTTP", () => {
  it("unsubscribes an SSE route's channel subscription when the client disconnects", async () => {
    @route("/feed")
    class Feed {
      @inject(Channels) accessor channels!: Channels;
      @signal accessor stop!: AbortSignal;
      @get @sse({ heartbeat: 0 }) feed() {
        return this.channels.subscribe("news", this.stop);
      }
    }
    const app = yerd({ routes: [Feed], services: [], handleSignals: false });
    const server = await app.listen(0, "127.0.0.1");
    try {
      const memory = app.container.get(Channels).backend as MemoryBackend;
      const clients = await Promise.all(
        Array.from({ length: 5 }, async () => {
          const abort = new AbortController();
          const r = await fetch(server.url + "/feed", { signal: abort.signal });
          return { abort, reader: r.body!.getReader() };
        }),
      );
      await sleep(20);
      expect(memory.listeners("news")).toBe(5);
      await app.container.get(Channels).publish("news", "line1\nline2");
      const { value } = await clients[0]!.reader.read();
      expect(new TextDecoder().decode(value)).toBe("data: line1\ndata: line2\n\n");
      for (const c of clients) c.abort.abort();
      for (let i = 0; i < 50 && memory.listeners("news") > 0; i++) await sleep(10);
      expect(memory.listeners("news")).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("applies backpressure: a client that stops reading stops the generator, and leaving runs its finally", async () => {
    let produced = 0;
    let finished = false;
    const chunk = "x".repeat(64 * 1024);
    @route("/big")
    class Big {
      @get @ndjson async *rows() {
        try {
          for (; produced < 2000; produced++) yield { chunk };
        } finally {
          finished = true;
        }
      }
    }
    const server = await yerd({ routes: [Big], services: [], handleSignals: false }).listen(0, "127.0.0.1");
    try {
      const url = new URL(server.url);
      const req = request({ host: url.hostname, port: url.port, path: "/big" });
      const res = await new Promise<import("node:http").IncomingMessage>((resolve) => req.on("response", resolve).end());
      res.pause();
      await sleep(200);
      // 2000 x 64 KiB is 128 MiB; a paused reader holds back all but a few socket buffers' worth.
      expect(produced).toBeLessThan(400);
      req.destroy();
      for (let i = 0; i < 50 && !finished; i++) await sleep(10);
      expect(finished).toBe(true);
      expect(produced).toBeLessThan(2000);
    } finally {
      await server.close();
    }
  });

  it("serves HEAD for an SSE route without running it forever", async () => {
    let started = 0;
    @route("/sse-head")
    class SseHead {
      @get @sse({ heartbeat: 0 }) async *feed() {
        started++;
        yield "x";
        await sleep(10_000);
      }
    }
    const server = await yerd({ routes: [SseHead], services: [], handleSignals: false }).listen(0, "127.0.0.1");
    try {
      const r = await fetch(server.url + "/sse-head", { method: "HEAD" });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      expect(started).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("renders data-yx-live as a plain attribute", async () => {
    const { renderToString } = await import("@toyz/yerd");
    const { jsx } = await import("../../src/jsx/jsx-runtime.js");
    expect(await renderToString(jsx("div", { "data-yx-live": '/events?a=1&b="2"', hidden: true }))).toBe(
      '<div data-yx-live="/events?a=1&amp;b=&quot;2&quot;" hidden></div>',
    );
  });
});
