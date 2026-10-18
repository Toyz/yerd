import { describe, expect, it } from "vitest";
import { event, ndjson, sse, type HeartbeatInfo, type YerdResponse } from "@toyz/yerd";

/** A source that yields `items`, with `gapMs` of silence before each. */
async function* slow<T>(items: T[], gapMs: number) {
  for (const item of items) {
    await new Promise((r) => setTimeout(r, gapMs));
    yield item;
  }
}

async function text(response: YerdResponse): Promise<string> {
  let out = "";
  for await (const chunk of response.body as AsyncIterable<string>) out += chunk;
  return out;
}

describe("heartbeats", () => {
  it("SSE: a number sends the default comment", async () => {
    const body = await text(sse(slow(["a"], 45), { heartbeat: 20 }));
    expect(body).toMatch(/^(: ping\n\n)+data: a\n\n$/);
  });

  it("SSE: a custom value is written like any item: event() for a named event", async () => {
    const body = await text(sse(slow(["a"], 45), { heartbeat: { every: 20, send: event({ event: "ping", data: "ok" }) } }));
    expect(body).toContain("event: ping\ndata: ok\n\n");
    expect(body).not.toMatch(/^: ping/m);
  });

  it("SSE: a function gets the beat count and idle time, and undefined falls back to the default", async () => {
    const seen: HeartbeatInfo[] = [];
    const body = await text(
      sse(slow(["a"], 70), {
        heartbeat: {
          every: 20,
          send: (info) => {
            seen.push(info);
            return info.count === 1 ? undefined : { beat: info.count };
          },
        },
      }),
    );
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.map((s) => s.count)).toEqual(seen.map((_, i) => i + 1));
    expect(seen[1]!.idleMs).toBeGreaterThanOrEqual(seen[0]!.idleMs);
    expect(body.startsWith(": ping\n\ndata: {\"beat\":2}\n\n")).toBe(true);
  });

  it("NDJSON: a custom beat is a JSON line; the default is a blank line", async () => {
    const custom = await text(ndjson(slow([{ n: 1 }], 45), { heartbeat: { every: 20, send: ({ count }) => ({ type: "ping", count }) } }));
    const lines = custom.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.at(-1)).toEqual({ n: 1 });
    expect(lines[0]).toEqual({ type: "ping", count: 1 });
    expect(await text(ndjson(slow([1], 45), { heartbeat: 20 }))).toMatch(/^\n+1\n$/);
  });

  it("the idle time restarts after each item", async () => {
    const seen: number[] = [];
    await text(ndjson(slow([1, 2], 50), { heartbeat: { every: 20, send: ({ idleMs }) => (seen.push(idleMs), { idleMs }) } }));
    // Every beat is less than one gap after the last item, never the time since the start.
    expect(Math.max(...seen)).toBeLessThan(50);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("refuses heartbeat %s up front, before any headers go out", (bad) => {
    expect(() => sse(slow([], 0), { heartbeat: bad })).toThrow(TypeError);
    expect(() => ndjson(slow([], 0), { heartbeat: { every: bad, send: 1 } })).toThrow(/heartbeat.every/);
  });
});
