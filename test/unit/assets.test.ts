import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ILogger, assetUrl, resetManifest, useManifest, yerd, type LogRecord } from "@toyz/yerd";

const DEV = Symbol.for("yerd.devAssets");

function project() {
  const root = mkdtempSync(join(tmpdir(), "yerd-assets-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "public"));
  writeFileSync(join(root, "src", "styles.css"), "body{}");
  writeFileSync(join(root, "src", "extra.css"), "p{}");
  writeFileSync(join(root, "public", "favicon.svg"), "<svg/>");
  return root;
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[DEV];
  resetManifest();
});

async function warningsFor(paths: string[]): Promise<string[]> {
  const records: LogRecord[] = [];
  const app = yerd({ routes: [], services: [] }).services((s) => s.value(ILogger, { write: (r) => records.push(r) }));
  await app.scope(() => {
    for (const path of paths) assetUrl(path);
  });
  return records.filter((r) => r.level === "warn").map((r) => r.message);
}

describe("assetUrl in development", () => {
  it("warns once about missing files, files left out of `client`, and public/ paths", async () => {
    const root = project();
    (globalThis as Record<symbol, unknown>)[DEV] = { root, publicDir: join(root, "public"), client: ["src/styles.css"] };
    const warnings = await warningsFor(["src/styles.css", "/src/styles.css", "favicon.svg", "src/missing.css", "src/missing.css", "src/extra.css", "public/favicon.svg"]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/assetUrl\("src\/missing.css"\): no such file/);
    expect(warnings[1]).toMatch(/assetUrl\("src\/extra.css"\) isn't in the yerd plugin's `client` option/);
    expect(warnings[2]).toMatch(/files in public\/ are served from the site root; write assetUrl\("favicon.svg"\)/);
  });

  it("stays quiet outside the Vite dev server", async () => {
    expect(await warningsFor(["src/nowhere.css"])).toEqual([]);
    expect(assetUrl("src/nowhere.css")).toBe("/src/nowhere.css");
  });
});

describe("assetUrl in production", () => {
  it("uses the manifest, falls back to public files in the client build, and explains the rest", () => {
    const client = mkdtempSync(join(tmpdir(), "yerd-client-"));
    mkdirSync(join(client, ".vite"));
    writeFileSync(join(client, ".vite", "manifest.json"), JSON.stringify({ "src/styles.css": { file: "assets/styles-abc.css" } }));
    writeFileSync(join(client, "favicon.svg"), "<svg/>");
    useManifest(join(client, ".vite", "manifest.json"));
    expect(assetUrl("src/styles.css")).toBe("/assets/styles-abc.css");
    expect(assetUrl("favicon.svg")).toBe("/favicon.svg");
    expect(() => assetUrl("src/extra.css")).toThrow(/isn't in the Vite manifest \(add it to the yerd plugin's `client` option\) or the client build's public files/);
  });
});
