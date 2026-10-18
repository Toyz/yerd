import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import yerd from "../../src/vite/index.js";

const src = (path: string) => fileURLToPath(new URL(`../../src/${path}`, import.meta.url));

// A throwaway app, served by the plugin the way `vite` would.
const dir = mkdtempSync(join(tmpdir(), "yerd-vite-"));
mkdirSync(join(dir, "src", "routes"), { recursive: true });
const home = (text: string) => `
import { get, onShutdown, route, service } from "@toyz/yerd";
@route("/")
export class Home {
  @get show() { return "${text}"; }
}
@service
export class Closer {
  @onShutdown bye() { (globalThis as any).__yerdStopped = ((globalThis as any).__yerdStopped ?? 0) + 1; }
}
`;
writeFileSync(join(dir, "src", "main.ts"), `
import { yerd } from "@toyz/yerd";
export default yerd({ handleSignals: false }).discover(import.meta.glob("./routes/*.ts", { eager: true }));
`);
writeFileSync(join(dir, "src", "routes", "home.ts"), home("v1"));

let server: ViteDevServer;
let url: string;
beforeAll(async () => {
  server = await createServer({
    root: dir,
    configFile: false,
    logLevel: "silent",
    plugins: [yerd({ entry: "/src/main.ts" })],
    resolve: { alias: [{ find: /^@toyz\/yerd$/, replacement: src("index.ts") }] },
    server: { port: 0, host: "127.0.0.1" },
  });
  await server.listen();
  url = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const settle = () => new Promise((r) => setTimeout(r, 300));

describe("the Vite dev server", () => {
  it("serves the app, reloads it on edits without duplicate routes, and stops it on close", async () => {
    expect(await (await fetch(url + "/")).text()).toBe("v1");

    writeFileSync(join(dir, "src", "routes", "home.ts"), home("v2"));
    await settle();
    const first = await fetch(url + "/");
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("v2");
    // The old app was stopped before the new one loaded.
    expect((globalThis as { __yerdStopped?: number }).__yerdStopped).toBe(1);

    writeFileSync(join(dir, "src", "routes", "home.ts"), home("v3"));
    await settle();
    expect(await (await fetch(url + "/")).text()).toBe("v3");

    await server.close();
    await settle();
    expect((globalThis as { __yerdStopped?: number }).__yerdStopped).toBe(3);
  });
});
