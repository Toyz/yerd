// app.compression(): br / gzip on the fly for text responses, streamed pages flushed chunk by chunk.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { get, res, route, sse, yerd, type RunningServer } from "@toyz/yerd";

const rows = Array.from({ length: 400 }, (_, i) => ({ id: i, name: `row number ${i}` }));

async function Slow() {
  await new Promise((r) => setTimeout(r, 300));
  return <p>slow part</p>;
}

@route("/data")
class Data {
  @get list() {
    return rows;
  }
}

@route("/small")
class Small {
  @get read() {
    return { ok: true };
  }
}

@route("/pixels")
class Pixels {
  @get read() {
    return res(new Uint8Array(4096), { headers: { "content-type": "image/png" } });
  }
}

@route("/raw")
class Raw {
  @get read() {
    return res("x".repeat(5000), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-transform" } });
  }
}

@route("/page")
class Page {
  @get show() {
    return <main><h1>top of the page</h1><Slow /></main>;
  }
}

@route("/events")
class Events {
  @get stream() {
    return sse((async function* () {
      yield { data: "x".repeat(2000) };
    })());
  }
}

const dir = mkdtempSync(join(tmpdir(), "yerd-compress-"));
writeFileSync(join(dir, "app.js"), "console.log('hello');\n".repeat(200));
writeFileSync(join(dir, "pre.js"), "precompressed");
writeFileSync(join(dir, "pre.js.br"), "not really brotli");

let server: RunningServer;
beforeAll(async () => {
  server = await yerd({ routes: [Data, Small, Pixels, Raw, Page, Events], services: [], handleSignals: false })
    .static("/", dir)
    .compression()
    .listen(0, "127.0.0.1");
});
afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Got {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  /** ms from the request to the first body bytes, and those bytes. */
  first: { at: number; bytes: Buffer } | undefined;
}

function fetchRaw(path: string, accept: string | undefined, method = "GET"): Promise<Got> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const headers: Record<string, string> = accept === undefined ? {} : { "accept-encoding": accept };
    request({ host: "127.0.0.1", port: server.port, path, method, headers }, (r) => {
      const chunks: Buffer[] = [];
      let first: Got["first"];
      r.on("data", (c: Buffer) => {
        first ??= { at: Date.now() - started, bytes: c };
        chunks.push(c);
      });
      r.on("end", () => resolve({ status: r.statusCode!, headers: r.headers, body: Buffer.concat(chunks), first }));
    }).on("error", reject).end();
  });
}

describe("app.compression()", () => {
  it("compresses JSON with brotli, keeping a Content-Length", async () => {
    const r = await fetchRaw("/data", "gzip, deflate, br");
    expect(r.headers["content-encoding"]).toBe("br");
    expect(r.headers["vary"]).toBe("accept-encoding");
    expect(Number(r.headers["content-length"])).toBe(r.body.length);
    expect(JSON.parse(brotliDecompressSync(r.body).toString())).toEqual(rows);
    expect(r.body.length).toBeLessThan(JSON.stringify(rows).length / 4);
  });

  it("uses gzip when that's what's accepted, and nothing when nothing is", async () => {
    const gz = await fetchRaw("/data", "gzip");
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(JSON.parse(gunzipSync(gz.body).toString())).toEqual(rows);
    const plain = await fetchRaw("/data", undefined);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.headers["vary"]).toBe("accept-encoding");
    expect(JSON.parse(plain.body.toString())).toEqual(rows);
  });

  it("leaves small bodies, non-text types, no-transform and HEAD as they are", async () => {
    const small = await fetchRaw("/small", "br");
    expect(small.headers["content-encoding"]).toBeUndefined();
    expect(small.headers["vary"]).toBe("accept-encoding");
    expect((await fetchRaw("/pixels", "br")).headers["content-encoding"]).toBeUndefined();
    const raw = await fetchRaw("/raw", "br");
    expect(raw.headers["content-encoding"]).toBeUndefined();
    expect(raw.body.toString()).toBe("x".repeat(5000));
    const head = await fetchRaw("/data", "br", "HEAD");
    expect(head.headers["content-encoding"]).toBeUndefined();
  });

  it("streams a page compressed, its top flushed before the slow part renders", async () => {
    const r = await fetchRaw("/page", "br");
    expect(r.headers["content-encoding"]).toBe("br");
    expect(r.headers["content-length"]).toBeUndefined();
    expect(brotliDecompressSync(r.body).toString()).toContain("<h1>top of the page</h1><p>slow part</p>");
    // The first compressed bytes decode on their own to the top of the page, well before Slow's 300ms.
    expect(r.first!.at).toBeLessThan(250);
    const gz = await fetchRaw("/page", "gzip");
    expect(gunzipSync(gz.body).toString()).toContain("<p>slow part</p>");
  });

  it("leaves SSE alone", async () => {
    const r = await fetchRaw("/events", "br");
    expect(r.headers["content-type"]).toContain("text/event-stream");
    expect(r.headers["content-encoding"]).toBeUndefined();
  });

  it("compresses a static file without a sibling, and leaves a precompressed one to its sibling", async () => {
    const js = await fetchRaw("/app.js", "br");
    expect(js.headers["content-encoding"]).toBe("br");
    expect(brotliDecompressSync(js.body).toString()).toBe("console.log('hello');\n".repeat(200));
    const pre = await fetchRaw("/pre.js", "br");
    expect(pre.headers["content-encoding"]).toBe("br");
    expect(pre.body.toString()).toBe("not really brotli");
  });

  it("refuses bad options", () => {
    const app = yerd({ routes: [], services: [], handleSignals: false });
    expect(() => app.compression({ threshold: -1 })).toThrow("threshold");
    expect(() => app.compression({ encodings: [] })).toThrow("encodings");
    expect(() => app.compression({ brotliQuality: 12 })).toThrow("brotliQuality");
    expect(() => app.compression({ gzipLevel: 0 })).toThrow("gzipLevel");
  });
});
