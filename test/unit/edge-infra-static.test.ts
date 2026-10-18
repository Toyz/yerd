import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { mimeType, yerd, type RunningServer } from "@toyz/yerd";
import { acceptsEncoding, createMount, serveStatic, type StaticOptions } from "../../src/server/static.js";
import type { Outgoing } from "../../src/respond/coerce.js";

// A mount with every awkward shape a static folder can have.
const base = mkdtempSync(join(tmpdir(), "yerd-edge-static-"));
const root = join(base, "public");
const outside = join(base, "outside");
mkdirSync(root);
mkdirSync(outside);
mkdirSync(join(root, "docs"));
mkdirSync(join(root, "empty"));
mkdirSync(join(root, "assets"));
mkdirSync(join(root, "sub", ".git"), { recursive: true });
writeFileSync(join(root, "index.html"), "<h1>home</h1>");
writeFileSync(join(root, "docs", "index.html"), "<h1>docs</h1>");
writeFileSync(join(root, "hello.txt"), "hello");
writeFileSync(join(root, ".env"), "SECRET=1");
writeFileSync(join(root, "sub", ".git", "config"), "[core]");
writeFileSync(join(root, "café.txt"), "unicode");
writeFileSync(join(root, "with space.txt"), "spaced");
writeFileSync(join(root, "plus+sign.txt"), "plus");
writeFileSync(join(root, "app.js"), "console.log(1)");
writeFileSync(join(root, "app.js.br"), "BR");
writeFileSync(join(root, "app.js.gz"), "GZIP!");
writeFileSync(join(root, "only-gz.css"), "a{}");
writeFileSync(join(root, "only-gz.css.gz"), "GZ");
writeFileSync(join(root, "assets", "index-BKz9_aQ1.js"), "hashed");
writeFileSync(join(outside, "passwd"), "root:x:0:0");
writeFileSync(join(outside, "evil.gz"), "EVIL");
writeFileSync(join(base, "package.json"), "{}");
// Symlinks: a file and a directory pointing out of the mount, a link that
// stays inside, and a compressed sibling that escapes.
symlinkSync(join(outside, "passwd"), join(root, "linked.txt"));
symlinkSync(outside, join(root, "linkdir"));
symlinkSync(join(root, "hello.txt"), join(root, "alias.txt"));
writeFileSync(join(root, "sneaky.txt"), "plain");
symlinkSync(join(outside, "evil.gz"), join(root, "sneaky.txt.gz"));
// The mount's own directory reached through a symlink.
symlinkSync(root, join(base, "public-link"));

afterAll(() => rmSync(base, { recursive: true, force: true }));

const mount = (options: StaticOptions = {}, prefix = "/", dir = root) => createMount(prefix, dir, options);

async function bodyOf(out: Outgoing | undefined): Promise<string | undefined> {
  if (!out) return undefined;
  if (out.body === null) return "";
  if (typeof out.body === "string") return out.body;
  const chunks: Buffer[] = [];
  for await (const chunk of out.body as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

const serve = (path: string, headers: Record<string, string> = {}, options: StaticOptions = {}) =>
  serveStatic(mount(options), path, headers);

describe("static: path traversal and forbidden paths", () => {
  const refused = [
    "/../package.json",
    "/../../package.json",
    "/%2e%2e/package.json",
    "/%2E%2E/package.json",
    "/%2e%2e%2fpackage.json",
    "/..%2fpackage.json",
    "/..%2Fpackage.json",
    "/..%5cpackage.json",
    "/..\\package.json",
    "/docs/../../package.json",
    "/docs/%2e%2e/%2e%2e/package.json",
    "/./hello.txt",
    "/%2e/hello.txt",
    "/docs/./index.html",
    "/hello.txt%00",
    "/hello.txt%00.css",
    "/%00",
    "/.env",
    "/%2eenv",
    "/sub/.git/config",
    "/sub/%2egit/config",
    "/%E0%A4%A",
    "/%",
    "/linked.txt",
    "/linkdir/passwd",
    `/${join(outside, "passwd")}`,
    `/${encodeURIComponent(join(outside, "passwd"))}`,
  ];
  it.each(refused)("refuses %s", async (path) => {
    expect(await serve(path)).toBeUndefined();
  });

  it("treats a double-encoded dot-dot as a literal name, not traversal", async () => {
    expect(await serve("/%252e%252e/package.json")).toBeUndefined();
  });

  it("keeps dot-dot refused even with dotfiles allowed, while serving real dotfiles", async () => {
    expect(await bodyOf(await serve("/.env", {}, { dotfiles: true }))).toBe("SECRET=1");
    expect(await serve("/../package.json", {}, { dotfiles: true })).toBeUndefined();
    expect(await serve("/%2e%2e/package.json", {}, { dotfiles: true })).toBeUndefined();
  });

  it("serves a symlink that stays inside the mount", async () => {
    expect(await bodyOf(await serve("/alias.txt"))).toBe("hello");
  });

  it("follows symlinks out of the mount only when told to", async () => {
    expect(await bodyOf(await serve("/linked.txt", {}, { followSymlinks: true }))).toBe("root:x:0:0");
    expect(await bodyOf(await serve("/linkdir/passwd", {}, { followSymlinks: true }))).toBe("root:x:0:0");
  });

  it("never serves a precompressed sibling that escapes the mount; falls back to the plain file", async () => {
    const out = await serve("/sneaky.txt", { "accept-encoding": "gzip" });
    expect(out?.headers["content-encoding"]).toBeUndefined();
    expect(await bodyOf(out)).toBe("plain");
  });

  it("works when the mount directory itself is a symlink", async () => {
    const out = await serveStatic(mount({}, "/", join(base, "public-link")), "/hello.txt", {});
    expect(await bodyOf(out)).toBe("hello");
    expect(await serveStatic(mount({}, "/", join(base, "public-link")), "/linked.txt", {})).toBeUndefined();
  });

  it("answers nothing for a mount whose directory doesn't exist", async () => {
    expect(await serveStatic(mount({}, "/", join(base, "missing")), "/hello.txt", {})).toBeUndefined();
  });
});

describe("static: prefixes, index files and directories", () => {
  it.each([
    ["/", "<h1>home</h1>"],
    ["/docs/", "<h1>docs</h1>"],
    ["/docs/index.html", "<h1>docs</h1>"],
  ])("serves %s", async (path, body) => {
    const out = await serve(path);
    expect(out?.status).toBe(200);
    expect(out?.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(await bodyOf(out)).toBe(body);
  });

  it.each(["/docs", "/empty/", "/empty", "/assets", "/missing.txt", "/hello.txt/"])("finds nothing at %s", async (path) => {
    expect(await serve(path)).toBeUndefined();
  });

  it("serves no index file when index is false", async () => {
    expect(await serve("/", {}, { index: false })).toBeUndefined();
    expect(await serve("/docs/", {}, { index: false })).toBeUndefined();
    expect(await bodyOf(await serve("/docs/index.html", {}, { index: false }))).toBe("<h1>docs</h1>");
  });

  it.each([
    ["/static/hello.txt", "hello"],
    ["/static/", "<h1>home</h1>"],
    ["/static", "<h1>home</h1>"],
  ])("a prefixed mount serves %s", async (path, body) => {
    expect(await bodyOf(await serveStatic(mount({}, "static"), path, {}))).toBe(body);
  });

  it.each(["/staticx/hello.txt", "/hello.txt", "/stat/hello.txt", "/static/../hello.txt"])("a prefixed mount ignores %s", async (path) => {
    expect(await serveStatic(mount({}, "/static/"), path, {})).toBeUndefined();
  });

  it("normalizes the prefix's slashes", () => {
    expect(createMount("///a/b//", root).prefix).toBe("/a/b/");
    expect(createMount("a", root).prefix).toBe("/a/");
    expect(createMount("/", root).prefix).toBe("/");
  });

  it("limits to the allowed extensions, case-insensitively, and still refuses traversal", async () => {
    const options = { extensions: [".txt"] };
    expect(await bodyOf(await serve("/hello.txt", {}, options))).toBe("hello");
    expect(await serve("/app.js", {}, options)).toBeUndefined();
    expect(await serve("/", {}, options)).toBeUndefined();
    expect(await serve("/../package.json", {}, { extensions: [".json"] })).toBeUndefined();
  });
});

describe("static: names", () => {
  it.each([
    ["/caf%C3%A9.txt", "unicode"],
    ["/with%20space.txt", "spaced"],
    ["/plus+sign.txt", "plus"],
    ["/plus%2Bsign.txt", "plus"],
  ])("serves %s", async (path, body) => {
    expect(await bodyOf(await serve(path))).toBe(body);
  });

  it("doesn't treat + as a space (that's form encoding, not paths)", async () => {
    expect(await serve("/with+space.txt")).toBeUndefined();
  });
});

describe("static: content types", () => {
  it.each([
    ["a.html", "text/html; charset=utf-8"],
    ["A.HTML", "text/html; charset=utf-8"],
    ["a.mjs", "text/javascript; charset=utf-8"],
    ["a.js.map", "application/json; charset=utf-8"],
    ["site.webmanifest", "application/manifest+json; charset=utf-8"],
    ["a.svg", "image/svg+xml"],
    ["a.wasm", "application/wasm"],
    ["a.woff2", "font/woff2"],
    ["archive.tar.gz", "application/octet-stream"],
    ["noext", "application/octet-stream"],
    [".bashrc", "application/octet-stream"],
    ["weird.", "application/octet-stream"],
  ])("%s is %s", (name, type) => {
    expect(mimeType(name)).toBe(type);
  });

  it("types a precompressed response by the original file, not the .br/.gz", async () => {
    const out = await serve("/app.js", { "accept-encoding": "br" });
    expect(out?.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(out?.headers["content-encoding"]).toBe("br");
  });
});

describe("static: caching", () => {
  it.each([
    ["/assets/index-BKz9_aQ1.js", "public, max-age=31536000, immutable"],
    ["/hello.txt", "no-cache"],
    ["/app.js", "no-cache"],
  ])("%s gets %s", async (path, cache) => {
    expect((await serve(path))?.headers["cache-control"]).toBe(cache);
  });

  it("uses cacheControl() when given, with the file's path", async () => {
    const seen: string[] = [];
    const out = await serve("/hello.txt", {}, { cacheControl: (p) => (seen.push(p), "private, max-age=5") });
    expect(out?.headers["cache-control"]).toBe("private, max-age=5");
    expect(seen).toEqual([join(root, "hello.txt")]);
  });

  it("sends a weak etag, last-modified and vary", async () => {
    const out = await serve("/hello.txt");
    expect(out?.headers.etag).toMatch(/^W\/"5-[0-9a-f]+"$/);
    expect(new Date(out!.headers["last-modified"]!).getTime()).not.toBeNaN();
    expect(out?.headers.vary).toBe("accept-encoding");
    expect(out?.headers["content-length"]).toBe("5");
  });

  it("answers 304 with no body for a matching If-None-Match, in any of its forms", async () => {
    const etag = (await serve("/hello.txt"))!.headers.etag!;
    const strong = etag.slice(2);
    for (const inm of [etag, `"nope", ${etag}`, `${etag},"other"`, "*", ` ${etag} `, strong, `"x", ${strong}`]) {
      const out = await serve("/hello.txt", { "if-none-match": inm });
      expect([inm, out?.status]).toEqual([inm, 304]);
      expect(out?.body).toBeNull();
      expect(out?.headers.etag).toBe(etag);
    }
  });

  it("answers 200 when If-None-Match doesn't match", async () => {
    for (const inm of ['"nope"', 'W/"nope"', "", "W/"]) {
      expect((await serve("/hello.txt", { "if-none-match": inm }))?.status).toBe(200);
    }
  });

  it("checks If-None-Match before picking an encoding (one etag for all encodings)", async () => {
    const etag = (await serve("/app.js"))!.headers.etag!;
    const out = await serve("/app.js", { "if-none-match": etag, "accept-encoding": "br" });
    expect(out?.status).toBe(304);
    expect(out?.headers["content-encoding"]).toBeUndefined();
  });
});

describe("static: precompressed siblings", () => {
  it.each([
    ["br", "br", "BR"],
    ["gzip", "gzip", "GZIP!"],
    ["br, gzip", "br", "BR"],
    ["gzip, br;q=0", "gzip", "GZIP!"],
    ["br;q=0, gzip;q=0", undefined, "console.log(1)"],
    ["*", "br", "BR"],
    ["*;q=0", undefined, "console.log(1)"],
    ["*;q=0, gzip", "gzip", "GZIP!"],
    ["identity", undefined, "console.log(1)"],
    ["", undefined, "console.log(1)"],
    ["BR", "br", "BR"],
    ["br ;q=0, gzip", "gzip", "GZIP!"],
    ["gzip ;q=0, *", "br", "BR"],
    ["deflate", undefined, "console.log(1)"],
  ])("Accept-Encoding %j serves %s", async (accept, encoding, body) => {
    const out = await serve("/app.js", { "accept-encoding": accept });
    expect(out?.headers["content-encoding"]).toBe(encoding);
    expect(out?.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    expect(await bodyOf(out)).toBe(body);
  });

  it("falls back to gzip when only a .gz sibling exists", async () => {
    const out = await serve("/only-gz.css", { "accept-encoding": "br, gzip" });
    expect(out?.headers["content-encoding"]).toBe("gzip");
    expect(await bodyOf(out)).toBe("GZ");
  });

  it("a request for the sibling itself is a plain download", async () => {
    const out = await serve("/app.js.br");
    expect(out?.headers["content-encoding"]).toBeUndefined();
    expect(out?.headers["content-type"]).toBe("application/octet-stream");
  });
});

describe("acceptsEncoding", () => {
  it.each([
    ["br", "br", true],
    ["BR", "br", true],
    [" br ", "br", true],
    ["br;q=0", "br", false],
    ["br;q=0.0", "br", false],
    ["br;q=0.000", "br", false],
    ["br;q=0.001", "br", true],
    ["br;q=1", "br", true],
    ["br;Q=0", "br", false],
    ["br; q=0", "br", false],
    ["br ;q=0", "br", false],
    ["br ; q=0", "br", false],
    ["br;q=junk", "br", false],
    ["br;level=5", "br", true],
    ["br;level=5;q=0", "br", false],
    ["*", "br", true],
    ["*;q=0", "br", false],
    ["*;q=0, br", "br", true],
    ["br;q=0, *", "br", false],
    ["gzip ;q=0, *", "gzip", false],
    ["gzip", "br", false],
    ["", "br", false],
    [",,,", "br", false],
    ["brotli", "br", false],
  ] as const)("%j accepts %s: %s", (header, encoding, expected) => {
    expect(acceptsEncoding(header, encoding)).toBe(expected);
  });
});

describe("static over HTTP", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await yerd({ routes: [], services: [], handleSignals: false }).static("/", root).listen(0, "127.0.0.1");
  });
  afterAll(() => server.close());

  function raw(path: string, method = "GET", headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(server.url);
      request({ host: url.hostname, port: url.port, path, method, headers }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      })
        .on("error", reject)
        .end();
    });
  }

  it.each(["/../package.json", "/%2e%2e/package.json", "/..%5cpackage.json", "/linkdir/passwd", "/.env", "/hello.txt%00"])(
    "404s %s",
    async (path) => {
      expect((await raw(path)).status).toBe(404);
    },
  );

  it("answers HEAD with the headers and no body, and keeps serving afterwards", async () => {
    for (let i = 0; i < 20; i++) {
      const r = await raw("/hello.txt", "HEAD");
      expect(r.status).toBe(200);
      expect(r.headers["content-length"]).toBe("5");
      expect(r.body).toBe("");
    }
    expect((await raw("/hello.txt")).body).toBe("hello");
  });

  it("answers a conditional HEAD with 304", async () => {
    const etag = (await raw("/hello.txt", "HEAD")).headers.etag as string;
    const r = await raw("/hello.txt", "HEAD", { "if-none-match": etag });
    expect(r.status).toBe(304);
  });

  it("doesn't serve files for POST", async () => {
    expect((await raw("/hello.txt", "POST")).status).toBe(404);
  });

  it("ignores Range (no partial content support): the whole file, 200", async () => {
    const r = await raw("/hello.txt", "GET", { range: "bytes=0-1" });
    expect(r.status).toBe(200);
    expect(r.body).toBe("hello");
  });

  it("sends nosniff with static files", async () => {
    expect((await raw("/hello.txt")).headers["x-content-type-options"]).toBe("nosniff");
  });

  it("refuses traversal in an absolute-form request target", async () => {
    const r = await raw(`${server.url}/../package.json`);
    expect(r.status).toBe(404);
  });
});
