import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  args, body, currentContext, field, files, get, is, ndjsonBody, post, route, yerd,
  type ParsedBody, type RunningServer,
} from "@toyz/yerd";

const LIMIT = 1024;

/** What ctx.body() produced, in a JSON-friendly form. */
function describeBody(b: ParsedBody): unknown {
  if (b.kind === "form") {
    const files: Record<string, unknown[]> = {};
    for (const key of Object.keys(b.files)) {
      files[key] = b.files[key]!.map((f) => ({ name: f.name, size: f.size, type: f.type }));
    }
    return { kind: b.kind, value: { ...b.value }, files, nullProto: Object.getPrototypeOf(b.value) === null };
  }
  if (b.kind === "bytes") return { kind: b.kind, length: b.value.length, first: [...b.value.slice(0, 4)] };
  return { kind: b.kind, value: b.value };
}

function depth(value: unknown): number {
  let d = 0;
  let cur = value;
  while (Array.isArray(cur)) {
    d++;
    cur = cur[0];
  }
  return d;
}

class Item {
  @is.string() name!: string;
}

@route("/parsed")
class Parsed {
  @post async read() {
    return describeBody(await currentContext().body());
  }

  @get async readGet() {
    return describeBody(await currentContext().body());
  }
}

@route("/twice")
class Twice {
  @body() accessor raw!: Promise<unknown>;
  @field("name") accessor name!: Promise<string | undefined>;

  @post async read() {
    const ctx = currentContext();
    const first = ctx.body();
    const second = ctx.body();
    return { same: first === second, raw: await this.raw, name: await this.name };
  }
}

@route("/then-lines")
class ThenLines {
  @post async read() {
    await currentContext().body();
    currentContext().lines();
    return "unreachable";
  }
}

@route("/depth")
class Depth {
  @post async read() {
    const b = await currentContext().body();
    return { depth: depth(b.value) };
  }
}

@route("/ignore")
class Ignore {
  @post ignore() {
    return "not read";
  }
}

@route("/proto")
class Proto {
  @post async read() {
    const b = await currentContext().body();
    const value = b.value as Record<string, unknown>;
    return {
      ownProto: Object.hasOwn(value, "__proto__"),
      protoIsObject: Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
      polluted: ({} as Record<string, unknown>).polluted ?? null,
    };
  }
}

@route("/lines")
class Lines {
  @post
  @args(ndjsonBody())
  async read(rows: AsyncIterable<unknown>) {
    const out: unknown[] = [];
    for await (const row of rows) out.push(row);
    return out;
  }
}

@route("/item-lines")
class ItemLines {
  @post
  @args(ndjsonBody(Item))
  async read(rows: AsyncIterable<Item>) {
    const out: string[] = [];
    for await (const row of rows) out.push(row.name);
    return out;
  }
}

@route("/uploads")
class Uploads {
  @files("doc") accessor docs!: Promise<File[]>;
  @post async read() {
    const docs = await this.docs;
    return docs.map((f) => f.name);
  }
}

let server: RunningServer;
beforeAll(async () => {
  server = await yerd({ routes: [Parsed, Twice, ThenLines, Depth, Ignore, Proto, Lines, ItemLines, Uploads], bodyLimit: LIMIT })
    .logging({ filter: "off" })
    .listen(0, "127.0.0.1");
});
afterAll(() => server.close());

let big: RunningServer;
beforeAll(async () => {
  big = await yerd({ routes: [Parsed, Depth, Proto, Uploads], bodyLimit: 4 * 1024 * 1024 }).logging({ filter: "off" }).listen(0, "127.0.0.1");
});
afterAll(() => big.close());

const send = (path: string, contentType: string | undefined, data: BodyInit, base = server.url) =>
  fetch(base + path, { method: "POST", headers: contentType ? { "content-type": contentType } : {}, body: data });

const parsed = async (contentType: string | undefined, data: BodyInit) => {
  const r = await send("/parsed", contentType, data);
  return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() };
};

interface RawOptions {
  method?: string;
  headers?: Record<string, string>;
  chunks?: (string | Uint8Array)[];
  delay?: number;
}

/** A request through node:http, for chunked bodies, GET bodies and slow uploads. */
function raw(path: string, options: RawOptions = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(server.url + path, { method: options.method ?? "POST", headers: options.headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: text }));
    });
    req.on("error", reject);
    void (async () => {
      for (const chunk of options.chunks ?? []) {
        req.write(chunk);
        if (options.delay) await new Promise((r) => setTimeout(r, options.delay));
      }
      req.end();
    })();
  });
}

/** Bytes straight onto a socket, for requests node:http won't send. Resolves with the status line. */
function socket(payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(server.url);
    const s = connect(Number(url.port), url.hostname, () => s.write(payload));
    let text = "";
    s.setEncoding("utf8");
    s.on("data", (c: string) => {
      text += c;
      if (text.includes("\r\n")) {
        resolve(text.split("\r\n")[0]!);
        s.destroy();
      }
    });
    s.on("error", reject);
    s.on("end", () => resolve(text.split("\r\n")[0]!));
  });
}

describe("JSON bodies", () => {
  it.each([
    ["null", null],
    ["42", 42],
    ['"text"', "text"],
    ["[1,2,3]", [1, 2, 3]],
    ['{"a":{"b":[true,false,null]}}', { a: { b: [true, false, null] } }],
    ['  \n\t{"a":1}\r\n  ', { a: 1 }],
    ['{"a":1,"a":2}', { a: 2 }],
    ['"\\u0000"', "\u0000"],
  ])("parses %j", async (text, value) => {
    expect(await parsed("application/json", text)).toEqual({ status: 200, body: { kind: "json", value } });
  });

  it.each([
    "   ",
    "{a:1}",
    "{'a':1}",
    '{"a":1,}',
    "[1,2",
    "undefined",
    "NaN",
    '{"a":1}{"b":2}',
    "\u00a0{}",
  ])("rejects %j with a 400", async (text) => {
    expect(await parsed("application/json", text)).toEqual({ status: 400, body: "Request body is not valid JSON" });
  });

  it.each([
    ["application/json; charset=utf-8"],
    ["APPLICATION/JSON"],
    ["application/json ; charset=UTF-8"],
    ["application/vnd.api+json"],
    ["application/merge-patch+json"],
    ["application/problem+json; charset=utf-8"],
  ])("treats %s as JSON", async (type) => {
    expect(await parsed(type, '{"a":1}')).toEqual({ status: 200, body: { kind: "json", value: { a: 1 } } });
  });

  it.each([
    ["application/jsonx", "bytes"],
    ["application/json5", "bytes"],
    ["text/json", "text"],
    ["text/plain", "text"],
    ["application/octet-stream", "bytes"],
  ])("does not treat %s as JSON (%s)", async (type, kind) => {
    const r = await parsed(type, '{"a":1}');
    expect(r.status).toBe(200);
    expect((r.body as { kind: string }).kind).toBe(kind);
  });

  it("no Content-Type at all is raw bytes", async () => {
    const r = await raw("/parsed", { headers: { "content-length": "7" }, chunks: ['{"a":1}'] });
    expect(JSON.parse(r.body)).toEqual({ kind: "bytes", length: 7, first: [123, 34, 97, 34] });
  });

  it("a Content-Length: 0 JSON body is no body at all", async () => {
    const r = await raw("/parsed", { headers: { "content-type": "application/json", "content-length": "0" } });
    expect(JSON.parse(r.body)).toEqual({ kind: "none" });
  });

  // Regression: a chunked request with no bytes was parsed as an empty JSON
  // document (400) instead of the "no body" a Content-Length of 0 gets.
  it("an empty chunked body is also no body", async () => {
    const r = await raw("/parsed", { headers: { "content-type": "application/json", "transfer-encoding": "chunked" } });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ kind: "none" });
  });

  it("a leading UTF-8 byte order mark is ignored, as RFC 8259 allows", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"a":1}')]);
    expect(await parsed("application/json", bom)).toEqual({ status: 200, body: { kind: "json", value: { a: 1 } } });
  });

  it("invalid UTF-8 inside a string becomes U+FFFD rather than an error", async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('{"a":"x'), 0xff, 0xfe, ...new TextEncoder().encode('y"}')]);
    expect(await parsed("application/json", bytes)).toEqual({ status: 200, body: { kind: "json", value: { a: "x\ufffd\ufffdy" } } });
  });

  it("ignores a non-UTF-8 charset parameter (always decodes UTF-8)", async () => {
    const r = await parsed("application/json; charset=latin1", '{"a":"\u00e9"}');
    expect(r.body).toEqual({ kind: "json", value: { a: "\u00e9" } });
  });

  it("keeps __proto__ and constructor as plain own keys, polluting nothing", async () => {
    const r = await send("/proto", "application/json", '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}', big.url);
    expect(await r.json()).toEqual({ ownProto: true, protoIsObject: true, polluted: null });
  });

  it("parses very deep nesting without crashing", async () => {
    const n = 200_000;
    const r = await send("/depth", "application/json", "[".repeat(n) + "]".repeat(n), big.url);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ depth: n });
  });

  it("parses a body close to a large limit", async () => {
    const value = "x".repeat(3 * 1024 * 1024);
    const r = await send("/parsed", "application/json", JSON.stringify({ value }), big.url);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { value: { value: string } }).value.value.length).toBe(value.length);
  });
});

describe("URL-encoded bodies", () => {
  const form = "application/x-www-form-urlencoded";
  it.each<[string, Record<string, unknown>]>([
    ["a=1&a=2&b=", { a: ["1", "2"], b: "" }],
    ["a=1&a=2&a=3", { a: ["1", "2", "3"] }],
    ["a=x+y&b=x%20y&c=x%2By", { a: "x y", b: "x y", c: "x+y" }],
    ["a=%ZZ&b=%&c=%4", { a: "%ZZ", b: "%", c: "%4" }],
    ["a=%E2%9C%93", { a: "\u2713" }],
    ["a=%FF", { a: "\ufffd" }],
    ["=x&&b", { "": "x", b: "" }],
    ["flag", { flag: "" }],
    ["a=b=c", { a: "b=c" }],
    ["a%5B%5D=1&a%5B%5D=2", { "a[]": ["1", "2"] }],
    ["user[name]=x", { "user[name]": "x" }],
    // URLSearchParams drops a leading "?", which the form-urlencoded parser in the spec would keep.
    ["?a=1", { a: "1" }],
    ["a=1;b=2", { a: "1;b=2" }],
    ["", {}],
  ])("%j", async (text, value) => {
    const r = await parsed(form, text);
    if (text === "") return expect(r.body).toEqual({ kind: "none" });
    expect(r.body).toEqual({ kind: "form", value, files: {}, nullProto: true });
  });

  it("keeps __proto__ and constructor as plain keys of a null-prototype object", async () => {
    const r = await parsed(form, "__proto__=x&constructor=y&__proto__[polluted]=1");
    expect(r.body).toEqual({ kind: "form", value: { ["__proto__"]: "x", constructor: "y", "__proto__[polluted]": "1" }, files: {}, nullProto: true });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("collects many repeats of one key in order", async () => {
    const text = Array.from({ length: 150 }, (_, i) => `k=${i}`).join("&");
    const r = await parsed(form, text);
    const k = (r.body as { value: { k: string[] } }).value.k;
    expect(k).toHaveLength(150);
    expect(k[149]).toBe("149");
  });

  it("matches the media type case-insensitively, with parameters", async () => {
    expect((await parsed("Application/X-WWW-Form-URLEncoded; charset=UTF-8", "a=1")).body).toMatchObject({ kind: "form", value: { a: "1" } });
  });
});

describe("multipart bodies", () => {
  const boundary = "XyZ";
  const multipart = (parts: string) => parts.replaceAll("\n", "\r\n");

  it("parses fields and files sent by fetch", async () => {
    const fd = new FormData();
    fd.append("name", "ada");
    fd.append("name", "bob");
    fd.append("doc", new File(["hello"], "a.txt", { type: "text/plain" }));
    fd.append("doc", new File([new Uint8Array(3)], "b.bin", { type: "application/octet-stream" }));
    const r = await parsed(undefined, fd);
    expect(r.body).toEqual({
      kind: "form",
      value: { name: ["ada", "bob"] },
      files: {
        doc: [
          { name: "a.txt", size: 5, type: "text/plain" },
          { name: "b.bin", size: 3, type: "application/octet-stream" },
        ],
      },
      nullProto: true,
    });
  });

  it.each([
    ["multipart/form-data"],
    ["multipart/form-data; boundary="],
    ["multipart/form-data; boundary=nope"],
  ])("a bad or missing boundary (%s) is a 400", async (type) => {
    const text = multipart(`--${boundary}\nContent-Disposition: form-data; name="a"\n\n1\n--${boundary}--\n`);
    expect(await parsed(type, text)).toEqual({ status: 400, body: "Request body is not valid multipart/form-data" });
  });

  it("garbage with a boundary is a 400", async () => {
    expect(await parsed(`multipart/form-data; boundary=${boundary}`, "not multipart at all")).toEqual({
      status: 400,
      body: "Request body is not valid multipart/form-data",
    });
  });

  it("boundary-like text inside a part's content is a clean 400 (the platform parser's call)", async () => {
    // RFC 2046 only ends a part at CRLF + "--boundary"; Node's FormData parser
    // refuses the body when the boundary appears anywhere in a part. Real
    // clients pick boundaries that never occur in the content, so this only
    // bites hand-built bodies.
    const text = multipart(`--${boundary}\nContent-Disposition: form-data; name="a"\n\nbefore --${boundary} after\n--${boundary}--\n`);
    expect(await parsed(`multipart/form-data; boundary=${boundary}`, text)).toEqual({ status: 400, body: "Request body is not valid multipart/form-data" });
  });

  it("text that merely resembles the boundary is content", async () => {
    const text = multipart(`--${boundary}\nContent-Disposition: form-data; name="a"\n\n--XYZ --xyz Xy-Z\n--${boundary}--\n`);
    expect((await parsed(`multipart/form-data; boundary=${boundary}`, text)).body).toMatchObject({ value: { a: "--XYZ --xyz Xy-Z" } });
  });

  it("matches the media type case-insensitively", async () => {
    const text = multipart(`--${boundary}\nContent-Disposition: form-data; name="a"\n\n1\n--${boundary}--\n`);
    expect((await parsed(`Multipart/Form-Data; boundary=${boundary}`, text)).body).toMatchObject({ kind: "form", value: { a: "1" } });
  });

  it("an empty file input posts a nameless, empty part, which @files ignores", async () => {
    const text = multipart(
      `--${boundary}\nContent-Disposition: form-data; name="doc"; filename=""\nContent-Type: application/octet-stream\n\n\n--${boundary}--\n`,
    );
    const type = `multipart/form-data; boundary=${boundary}`;
    expect((await parsed(type, text)).body).toMatchObject({ files: { doc: [{ name: "", size: 0 }] } });
    expect(await (await send("/uploads", type, text)).json()).toEqual([]);
  });

  it.each([
    ["../../etc/passwd", "../../etc/passwd"],
    ["C:\\temp\\a.txt", "C:\\temp\\a.txt"],
    ["na%C3%AFve.txt", "na%C3%AFve.txt"],
    // The platform parser decodes %22 (how browsers escape a quote) and nothing else.
    ["a%22b.txt", "a\"b.txt"],
  ])("keeps the client's filename %j verbatim (sanitizing it is the app's job)", async (sent, name) => {
    const text = multipart(`--${boundary}\nContent-Disposition: form-data; name="doc"; filename="${sent}"\n\nx\n--${boundary}--\n`);
    expect((await parsed(`multipart/form-data; boundary=${boundary}`, text)).body).toMatchObject({ files: { doc: [{ name }] } });
  });

  it("a unicode filename survives", async () => {
    const fd = new FormData();
    fd.append("doc", new File(["x"], "na\u00efve \u2713.txt"));
    expect((await parsed(undefined, fd)).body).toMatchObject({ files: { doc: [{ name: "na\u00efve \u2713.txt" }] } });
  });

  it("a field and a file can share a name; each lands in its own map", async () => {
    const fd = new FormData();
    fd.append("x", "text");
    fd.append("x", new File(["f"], "f.txt"));
    expect((await parsed(undefined, fd)).body).toMatchObject({ value: { x: "text" }, files: { x: [{ name: "f.txt" }] } });
  });

  it("many small files under one name", async () => {
    const fd = new FormData();
    for (let i = 0; i < 200; i++) fd.append("doc", new File([String(i)], `f${i}.txt`));
    const names = await (await send("/uploads", undefined, fd, big.url)).json();
    expect(names).toHaveLength(200);
    expect(names[199]).toBe("f199.txt");
  });

  it("__proto__ field and file names stay plain keys", async () => {
    const fd = new FormData();
    fd.append("__proto__", "x");
    fd.append("constructor", new File(["f"], "f.txt"));
    const r = await parsed(undefined, fd);
    expect(r.body).toMatchObject({ value: { ["__proto__"]: "x" }, files: { constructor: [{ name: "f.txt" }] }, nullProto: true });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("a large part under a raised limit arrives byte for byte", async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
    const fd = new FormData();
    fd.append("doc", new File([bytes], "big.bin", { type: "application/octet-stream" }));
    fd.append("after", "still here");
    const r = await send("/parsed", undefined, fd, big.url);
    expect(await r.json()).toMatchObject({ value: { after: "still here" }, files: { doc: [{ name: "big.bin", size: bytes.length }] } });
  });

  it("a part over the body limit is a 413", async () => {
    const fd = new FormData();
    fd.append("doc", new File([new Uint8Array(LIMIT)], "big.bin"));
    const r = await send("/parsed", undefined, fd);
    expect(r.status).toBe(413);
  });
});

describe("NDJSON bodies, read whole", () => {
  const type = "application/x-ndjson";
  it.each<[string, unknown[]]>([
    ['{"a":1}\n{"a":2}', [{ a: 1 }, { a: 2 }]],
    ['{"a":1}\n{"a":2}\n', [{ a: 1 }, { a: 2 }]],
    ['\n\n{"a":1}\n   \n\t\n{"a":2}\n\n', [{ a: 1 }, { a: 2 }]],
    ['{"a":1}\r\n{"a":2}\r\n', [{ a: 1 }, { a: 2 }]],
    ["1\n\"x\"\nnull\n[1]", [1, "x", null, [1]]],
  ])("%j", async (text, value) => {
    expect(await parsed(type, text)).toEqual({ status: 200, body: { kind: "ndjson", value } });
  });

  it("names the first bad line, counting blank lines", async () => {
    expect(await parsed(type, '{"a":1}\n\n{nope}\n{"a":2}')).toEqual({ status: 400, body: "Line 3 is not valid JSON" });
  });

  it.each(["application/jsonl", "application/jsonlines", "application/ndjson", "Application/X-NDJSON; charset=utf-8"])("accepts %s", async (t) => {
    expect((await parsed(t, "1\n2")).body).toEqual({ kind: "ndjson", value: [1, 2] });
  });

  it("a whitespace-only body is an empty list", async () => {
    expect((await parsed(type, "\n \n")).body).toEqual({ kind: "ndjson", value: [] });
  });
});

describe("NDJSON bodies, streamed", () => {
  const type = { "content-type": "application/x-ndjson" };

  it("yields each line, skipping blanks, including a last line with no newline", async () => {
    const r = await raw("/lines", { headers: type, chunks: ['{"a":1}\n\n  \n{"a"', ':2}\n3'] });
    expect(JSON.parse(r.body)).toEqual([{ a: 1 }, { a: 2 }, 3]);
  });

  it("reassembles a multi-byte character split across chunks", async () => {
    const bytes = new TextEncoder().encode('"\u2713"\n');
    const r = await raw("/lines", { headers: type, chunks: [bytes.slice(0, 2), bytes.slice(2, 3), bytes.slice(3)] });
    expect(JSON.parse(r.body)).toEqual(["\u2713"]);
  });

  it("a bad line is a 400 naming it", async () => {
    const r = await raw("/lines", { headers: type, chunks: ["1\n2\n{bad\n4\n"] });
    expect(r).toEqual({ status: 400, body: "Line 3 is not valid JSON" });
  });

  it("the whole upload can exceed the body limit; only lines are capped", async () => {
    const line = JSON.stringify("x".repeat(100)) + "\n";
    const r = await raw("/lines", { headers: type, chunks: Array.from({ length: 30 }, () => line) });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toHaveLength(30);
  });

  it("a line of exactly the limit is fine; one byte more is a 413", async () => {
    const exact = JSON.stringify("x".repeat(LIMIT - 2));
    expect(exact.length).toBe(LIMIT);
    expect((await raw("/lines", { headers: type, chunks: [exact + "\n"] })).status).toBe(200);
    const over = JSON.stringify("x".repeat(LIMIT - 1));
    expect(await raw("/lines", { headers: type, chunks: [over + "\n"] })).toEqual({ status: 413, body: `Line 1 is longer than ${LIMIT} bytes` });
  });

  it("an unterminated line that grows past the limit is a 413 before it ends", async () => {
    const r = await raw("/lines", { headers: type, chunks: ["1\n", "x".repeat(600), "x".repeat(600)] });
    expect(r).toEqual({ status: 413, body: `Line 2 is longer than ${LIMIT} bytes` });
  });

  it("counts multi-byte characters as bytes against the limit", async () => {
    const line = JSON.stringify("\u2713".repeat(400)); // 1202 bytes, 402 characters
    expect((await raw("/lines", { headers: type, chunks: [line + "\n"] })).status).toBe(413);
  });

  it("validates each line against a DTO, with the line number", async () => {
    const ok = await raw("/item-lines", { headers: type, chunks: ['{"name":"a"}\n{"name":"b","extra":1}\n'] });
    expect(JSON.parse(ok.body)).toEqual(["a", "b"]);
    const bad = await raw("/item-lines", { headers: type, chunks: ['{"name":"a"}\n{"name":2}\n'] });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body)).toEqual({ error: "Line 2 failed validation", line: 2, issues: [{ path: "name", message: "Expected a string" }] });
  });
});

describe("the body limit", () => {
  const text = (n: number) => "x".repeat(n);

  it.each([
    [LIMIT - 1, 200],
    [LIMIT, 200],
    [LIMIT + 1, 413],
    [LIMIT * 10, 413],
  ])("%i bytes with a Content-Length -> %i", async (n, status) => {
    const r = await send("/parsed", "text/plain", text(n));
    expect(r.status).toBe(status);
    if (status === 413) expect(await r.text()).toBe(`Request body is larger than ${LIMIT} bytes`);
  });

  it.each([
    [LIMIT - 1, 200],
    [LIMIT, 200],
    [LIMIT + 1, 413],
  ])("%i bytes chunked (no Content-Length) -> %i", async (n, status) => {
    const half = Math.floor(n / 2);
    const r = await raw("/parsed", { headers: { "content-type": "text/plain", "transfer-encoding": "chunked" }, chunks: [text(half), text(n - half)] });
    expect(r.status).toBe(status);
  });

  it("counts bytes, not characters", async () => {
    const r = await send("/parsed", "text/plain", "\u2713".repeat(342)); // 1026 bytes
    expect(r.status).toBe(413);
  });

  it("applies to JSON, forms and multipart alike", async () => {
    expect((await send("/parsed", "application/json", JSON.stringify(text(LIMIT)))).status).toBe(413);
    expect((await send("/parsed", "application/x-www-form-urlencoded", `a=${text(LIMIT)}`)).status).toBe(413);
  });

  it("a body nothing reads isn't limited or parsed", async () => {
    const r = await send("/ignore", "application/json", "{not json" + text(LIMIT * 2));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("not read");
  });

  it("a Content-Length that lies upward is refused before reading", async () => {
    const status = await socket(`POST /parsed HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: ${LIMIT + 1}\r\n\r\nshort`);
    expect(status).toMatch(/^HTTP\/1.1 413 /);
  });
});

describe("transport edge cases", () => {
  it("a slow body, a few bytes at a time, still parses", async () => {
    const r = await raw("/parsed", {
      headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
      chunks: ['{"a"', ":", "[1,", "2]}"],
      delay: 15,
    });
    expect(JSON.parse(r.body)).toEqual({ kind: "json", value: { a: [1, 2] } });
  });

  it("a client that aborts mid-body doesn't take the server down", async () => {
    await new Promise<void>((resolve) => {
      const req = httpRequest(server.url + "/parsed", { method: "POST", headers: { "content-type": "application/json", "content-length": "100" } });
      req.on("error", () => resolve());
      req.write('{"a":');
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 20);
    });
    const r = await send("/parsed", "application/json", '{"ok":true}');
    expect(await r.json()).toEqual({ kind: "json", value: { ok: true } });
  });

  it("a GET with a body has it parsed like any other method", async () => {
    const r = await raw("/parsed", { method: "GET", headers: { "content-type": "application/json", "content-length": "7" }, chunks: ['{"a":1}'] });
    expect(JSON.parse(r.body)).toEqual({ kind: "json", value: { a: 1 } });
  });

  it("a GET without a body reads as none", async () => {
    expect(await (await fetch(server.url + "/parsed")).json()).toEqual({ kind: "none" });
  });

  it.each([
    ["Content-Length: abc", "HTTP/1.1 400 Bad Request"],
    ["Content-Length: -1", "HTTP/1.1 400 Bad Request"],
    ["Content-Length: 5\r\nContent-Length: 6", "HTTP/1.1 400 Bad Request"],
    ["Content-Length: 5\r\nTransfer-Encoding: chunked", "HTTP/1.1 400 Bad Request"],
  ])("a malformed framing header (%j) is refused by the HTTP parser", async (headers, status) => {
    expect(await socket(`POST /parsed HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\n${headers}\r\n\r\nhello`)).toBe(status);
  });
});

describe("reading the body more than once", () => {
  it("body() returns one shared promise, and @body and @field share its parse", async () => {
    const r = await send("/twice", "application/x-www-form-urlencoded", "name=ada&x=1");
    expect(await r.json()).toEqual({ same: true, raw: { name: "ada", x: "1" }, name: "ada" });
  });

  it("asking for lines() after body() is a programming error (500), not a hang", async () => {
    const r = await send("/then-lines", "application/x-ndjson", "1\n");
    expect(r.status).toBe(500);
  });
});
