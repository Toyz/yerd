import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError, event, ndjson, sse } from "@toyz/yerd";

function body(response: unknown): AsyncGenerator<string> {
  return (response as { body: AsyncGenerator<string> }).body;
}

/** A source that yields `items`, waiting `gap` ms before each. */
async function* slow<T>(items: T[], gap: number) {
  for (const item of items) {
    await new Promise((resolve) => setTimeout(resolve, gap));
    yield item;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("heartbeats", () => {
  it("beat while the source is quiet, without racing promises or a timer per item", async () => {
    const race = vi.spyOn(Promise, "race");
    const out: string[] = [];
    for await (const chunk of body(ndjson(slow([1, 2], 70), { heartbeat: { every: 25, send: ({ count }) => ({ beat: count }) } }))) {
      out.push(chunk);
    }
    expect(race).not.toHaveBeenCalled();
    const beats = out.filter((line) => line.includes("beat"));
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(out.filter((line) => !line.includes("beat"))).toEqual(["1\n", "2\n"]);
    // Beats count up across the whole stream.
    expect(beats.map((line) => JSON.parse(line).beat)).toEqual(beats.map((_, i) => i + 1));
  });

  it("start the quiet period over after each item", async () => {
    const out: string[] = [];
    for await (const chunk of body(ndjson(slow([1, 2, 3, 4], 10), { heartbeat: 40 }))) out.push(chunk);
    expect(out).toEqual(["1\n", "2\n", "3\n", "4\n"]);
  });

  it("make one timer per stream", async () => {
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    const items = Array.from({ length: 20 }, (_, i) => i);
    async function* fast() {
      for (const item of items) yield item;
    }
    const out: string[] = [];
    for await (const chunk of body(sse(fast(), { heartbeat: 1000 }))) out.push(chunk);
    expect(out).toHaveLength(20);
    expect(timeouts).toHaveBeenCalledTimes(1);
  });

  it("stop the source and the timer when the reader leaves", async () => {
    let finished = false;
    async function* forever() {
      try {
        for (let i = 0; ; i++) yield i;
      } finally {
        finished = true;
      }
    }
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const stream = body(ndjson(forever(), { heartbeat: 1000 }));
    expect((await stream.next()).value).toBe("0\n");
    await stream.return(undefined);
    expect(finished).toBe(true);
    expect(clear).toHaveBeenCalled();
  });

  it("pass a failing source's error on", async () => {
    async function* broken() {
      yield 1;
      throw new HttpError(409, "boom");
    }
    const out: string[] = [];
    for await (const chunk of body(sse(broken(), { heartbeat: 1000 }))) out.push(chunk);
    expect(out).toEqual(["data: 1\n\n", formatted("boom")]);
  });
});

function formatted(message: string): string {
  return `event: error\ndata: ${JSON.stringify({ error: message })}\n\n`;
}

describe("ndjson() and sse() given the wrong thing", () => {
  class Feed {
    async *rows() {
      yield 1;
    }
  }

  it.each([
    ["ndjson", ndjson as (a?: unknown) => unknown],
    ["sse", sse as (a?: unknown) => unknown],
  ])("%s() refuses an uncalled generator", (name, helper) => {
    expect(() => helper(new Feed().rows)).toThrow(`${name}() got a function: pass an async iterable (did you forget to call the generator?), or options`);
  });

  it.each([null, [1, 2], "rows", 5])("refuses %j", (value) => {
    expect(() => (ndjson as (a?: unknown) => unknown)(value)).toThrow(TypeError);
    expect(() => (sse as (a?: unknown) => unknown)(value)).toThrow(TypeError);
  });

  it("still takes options, or nothing", () => {
    expect(typeof ndjson({ heartbeat: 5 })).toBe("function");
    expect(typeof sse()).toBe("function");
    expect(typeof sse(Object.create(null))).toBe("function");
  });

  it("still sends events from a called generator", async () => {
    async function* one() {
      yield event({ event: "hi", data: 1 });
    }
    const out: string[] = [];
    for await (const chunk of body(sse(one(), { heartbeat: 0 }))) out.push(chunk);
    expect(out).toEqual(["event: hi\ndata: 1\n\n"]);
  });
});
