// How send() pulls a streamed body: memory over a long-lived connection, abort, backpressure.
import { queryObjects } from "node:v8";
import { describe, expect, it } from "vitest";
import { get, ndjson, route, signal, yerd } from "@toyz/yerd";

const gates: Array<() => void> = [];
const gate = () => new Promise<void>((resolve) => gates.push(resolve));
const finallies: string[] = [];

@route("/many")
class Many {
  @signal accessor stop!: AbortSignal;

  /** 50 rows, a pause, 3000 more, then open until released. */
  @get @ndjson async *rows() {
    try {
      for (let i = 0; i < 50; i++) yield { i };
      await gate();
      for (let i = 0; i < 3000; i++) yield { i };
      await gate();
    } finally {
      finallies.push(`many:${this.stop.aborted}`);
    }
  }
}

/** Read `count` newline-terminated rows from a body. */
async function readRows(reader: ReadableStreamDefaultReader<Uint8Array>, count: number): Promise<void> {
  const decoder = new TextDecoder();
  let seen = 0;
  while (seen < count) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended after ${seen} rows`);
    seen += (decoder.decode(value).match(/\n/g) ?? []).length;
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("send() on a long-lived stream", () => {
  it("doesn't keep anything alive per chunk while the connection stays open", async () => {
    const app = yerd({ routes: [Many], services: [], handleSignals: false });
    const res = await app.request("/many");
    const reader = res.body!.getReader();
    await readRows(reader, 50);
    await settle();
    const before = queryObjects(Promise, { format: "count" }) as number;
    gates.shift()!();
    await readRows(reader, 3000);
    await settle();
    const after = queryObjects(Promise, { format: "count" }) as number;
    // Racing each chunk against an abort-only promise kept one promise alive per chunk (3000 here).
    expect(after - before).toBeLessThan(300);
    // Hanging up still aborts the stream, and the source finishes once its await returns.
    await reader.cancel();
    gates.shift()!();
    await settle();
    expect(finallies).toEqual(["many:true"]);
    await app.stop();
  });
});

let bigYielded = 0;

@route("/big")
class Big {
  /** 100 rows of about 8 KB each, counting how far the source got. */
  @get async *rows() {
    for (let i = 0; i < 100; i++) {
      bigYielded++;
      yield "x".repeat(8 * 1024) + "\n";
    }
  }
}

describe("app.fetch() backpressure", () => {
  it("pulls only as fast as the reader reads, then drains to the end", async () => {
    const app = yerd({ routes: [Big], services: [], handleSignals: false });
    const res = await app.request("/big");
    await settle();
    // Nothing read yet: the source waits once about 16 KiB are buffered, instead of running to the end.
    expect(bigYielded).toBeGreaterThan(0);
    expect(bigYielded).toBeLessThan(10);
    const text = await res.text();
    expect(bigYielded).toBe(100);
    expect(text.length).toBe(100 * (8 * 1024 + 1));
    await app.stop();
  });
});
