import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Stylesheet, assetUrl, get, renderToString, resetManifest, route, useManifest, yerd, type RunningServer } from "@toyz/yerd";

const dir = mkdtempSync(join(tmpdir(), "yerd-static-"));
mkdirSync(join(dir, "assets"));
writeFileSync(join(dir, "hello.txt"), "hello");
writeFileSync(join(dir, "assets", "app-AbC123xyZ9.css"), "body{color:red}");
writeFileSync(join(dir, "assets", "app-AbC123xyZ9.css.br"), "BROTLI");
writeFileSync(join(dir, ".secret"), "nope");
writeFileSync(join(dir, "taken.txt"), "file");
// A separate folder: the "/" mount must not cover it, or it would serve main.ts itself.
const src = mkdtempSync(join(tmpdir(), "yerd-src-"));
writeFileSync(join(src, "styles.css"), "a{}");
writeFileSync(join(src, "main.ts"), "secret source");
// A symlink out of the mount: not served.
const outside = mkdtempSync(join(tmpdir(), "yerd-outside-"));
writeFileSync(join(outside, "passwd"), "root:x:0:0");
symlinkSync(join(outside, "passwd"), join(dir, "linked.txt"));
writeFileSync(join(dir, "manifest.json"), JSON.stringify({ "src/styles.css": { file: "assets/app-AbC123xyZ9.css" } }));

@route("/taken.txt")
class Taken {
  @get show() {
    return "from the route";
  }
}

let server: RunningServer;
beforeAll(async () => {
  server = await yerd({ routes: [Taken], services: [], handleSignals: false })
    .static("/", dir)
    .static("/src", src, { extensions: [".css"] })
    .listen(0, "127.0.0.1");
});
afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(src, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  resetManifest();
});

const at = (path: string, init?: RequestInit) => fetch(server.url + path, init);

/** fetch() normalizes "..", so traversal attempts go out raw through node:http. */
function rawGet(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(server.url);
    request({ host: url.hostname, port: url.port, path, method: "GET" }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on("error", reject)
      .end();
  });
}

describe("static files", () => {
  it("serves files with a mime type, length, etag and revalidation caching", async () => {
    const r = await at("/hello.txt");
    expect(await r.text()).toBe("hello");
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(r.headers.get("content-length")).toBe("5");
    expect(r.headers.get("cache-control")).toBe("no-cache");
    expect(r.headers.get("etag")).toMatch(/^W\/"/);
  });

  it("answers 304 when the etag matches", async () => {
    const etag = (await at("/hello.txt")).headers.get("etag")!;
    const r = await at("/hello.txt", { headers: { "if-none-match": etag } });
    expect(r.status).toBe(304);
  });

  it("caches hashed filenames for a year, immutable", async () => {
    const r = await at("/assets/app-AbC123xyZ9.css", { headers: { "accept-encoding": "identity" } });
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(r.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  it("serves a precompressed sibling when the client accepts it", async () => {
    const r = await rawHeaders("/assets/app-AbC123xyZ9.css", { "accept-encoding": "br, gzip" });
    expect(r["content-encoding"]).toBe("br");
    expect(r["content-length"]).toBe("6");
  });

  it("refuses traversal, encoded traversal and dotfiles", async () => {
    expect(await rawGet("/../package.json")).toBe(404);
    expect(await rawGet("/%2e%2e/%2e%2e/etc/passwd")).toBe(404);
    expect(await rawGet("/assets/..%2f..%2fpackage.json")).toBe(404);
    expect(await rawGet("/.secret")).toBe(404);
    expect(await rawGet("/hello.txt%00.css")).toBe(404);
  });

  it("limits a mount to its allowed extensions", async () => {
    expect(await (await at("/src/styles.css")).text()).toBe("a{}");
    expect((await at("/src/main.ts")).status).toBe(404);
  });

  it("lets routes win over files", async () => {
    expect(await (await at("/taken.txt")).text()).toBe("from the route");
  });

  it("supports HEAD", async () => {
    const r = await at("/hello.txt", { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-length")).toBe("5");
    expect(await r.text()).toBe("");
  });
});

describe("assetUrl", () => {
  it("returns source paths without a manifest and hashed files with one", async () => {
    resetManifest();
    expect(assetUrl("src/styles.css")).toBe("/src/styles.css");
    expect(assetUrl("./src/styles.css")).toBe("/src/styles.css");
    useManifest(join(dir, "manifest.json"));
    expect(assetUrl("src/styles.css")).toBe("/assets/app-AbC123xyZ9.css");
    expect(await renderToString(<Stylesheet href="src/styles.css" />)).toBe('<link rel="stylesheet" href="/assets/app-AbC123xyZ9.css">');
    expect(() => assetUrl("src/missing.css")).toThrow(/isn't in the Vite manifest/);
    resetManifest();
  });
});

function rawHeaders(path: string, headers: Record<string, string>): Promise<Record<string, string | string[] | undefined>> {
  return new Promise((resolve, reject) => {
    const url = new URL(server.url);
    request({ host: url.hostname, port: url.port, path, method: "GET", headers }, (res) => {
      res.resume();
      resolve(res.headers);
    })
      .on("error", reject)
      .end();
  });
}

describe("static edge cases", () => {
  it("doesn't follow a symlink out of the mount", async () => {
    expect((await fetch(server.url + "/linked.txt")).status).toBe(404);
  });

  it("honours q=0 in Accept-Encoding", async () => {
    const { acceptsEncoding } = await import("../../src/server/static.js");
    expect(acceptsEncoding("gzip, br", "br")).toBe(true);
    expect(acceptsEncoding("gzip, br;q=0", "br")).toBe(false);
    expect(acceptsEncoding("*;q=0.5", "br")).toBe(true);
    expect(acceptsEncoding("*, br;q=0", "br")).toBe(false);
    expect(acceptsEncoding("identity", "br")).toBe(false);
  });
});
