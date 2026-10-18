import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import yerd, { yerdDecorators } from "../../src/vite/index.js";

// Plugin hooks are plain functions here; call them without Vite's context types.
type AnyHook = (this: unknown, ...args: unknown[]) => unknown;
const hook = (plugin: Plugin, name: keyof Plugin) => plugin[name] as unknown as AnyHook;

const byName = (name: string) => yerd({ entry: "/src/main.ts", client: ["src/styles.css"] }).find((p) => p.name === name)!;

describe("the plugin set", () => {
  it("is decorators (pre), dev, then build (build only)", () => {
    const plugins = yerd();
    expect(plugins.map((p) => [p.name, p.enforce, p.apply])).toEqual([
      ["yerd:decorators", "pre", undefined],
      ["yerd:dev", undefined, undefined],
      ["yerd:build", undefined, "build"],
    ]);
  });

  it("turns off Oxc and makes the dev app custom", () => {
    expect(hook(yerdDecorators(), "config")()).toEqual({ oxc: false });
    expect(hook(byName("yerd:dev"), "config")()).toEqual({ appType: "custom" });
  });
});

describe("decorator lowering", () => {
  const plugin = yerdDecorators();
  const transform = (code: string, id: string, consumer = "server") =>
    hook(plugin, "transform").call({ environment: { config: { consumer } } }, code, id) as Promise<{ code: string; map: string } | null>;

  const source = `
    const dec = (_v: unknown, _c: unknown) => {};
    export class A {
      @dec accessor field = 1;
      async run(): Promise<number> { return 1; }
    }
  `;

  it.each([
    ["/app/src/a.ts"],
    ["/app/src/a.tsx"],
    ["/app/src/a.mts"],
    ["/app/src/a.cts"],
    ["/app/src/a.jsx"],
    ["/app/src/a.ts?v=123"],
  ])("lowers TC39 decorators in %s", async (id) => {
    const code = id.includes("jsx") ? "export const x = <div />;" : source;
    const result = await transform(code, id);
    expect(result).not.toBeNull();
    expect(result!.code).not.toMatch(/@dec|accessor field/);
    expect(typeof result!.map).toBe("string");
  });

  it.each([
    ["/app/node_modules/pkg/index.ts"],
    ["/app/src/plain.js"],
    ["/app/src/style.css"],
    ["/app/src/data.json"],
    ["/app/src/a.ts.map"],
    ["virtual:yerd/server-entry"],
  ])("leaves %s alone", async (id) => {
    expect(await transform(source, id)).toBeNull();
  });

  it("uses yerd's JSX runtime", async () => {
    const result = await transform("export const x = <div class='a' />;", "/app/src/a.tsx");
    expect(result!.code).toContain("@toyz/yerd/jsx-runtime");
  });

  it("targets ES2022 on the server and ES2016 in the browser (async lowered for the polyfill)", async () => {
    const server = await transform(source, "/app/src/a.ts", "server");
    const client = await transform(source, "/app/src/a.ts", "client");
    expect(server!.code).toMatch(/async run\(\)/);
    expect(client!.code).not.toMatch(/async run\(\)/);
  });

  it("lets the client target be tuned", async () => {
    const result = (await hook(yerdDecorators({ clientTarget: "es2022" }), "transform").call(
      { environment: { config: { consumer: "client" } } },
      source,
      "/app/src/a.ts",
    )) as { code: string };
    expect(result.code).toMatch(/async run\(\)/);
  });

  it("works without an environment (treated as the server)", async () => {
    const result = (await hook(plugin, "transform").call({}, source, "/app/src/a.ts")) as { code: string };
    expect(result.code).toMatch(/async run\(\)/);
  });

  it("reports a syntax error from esbuild", async () => {
    await expect(transform("export class {", "/app/src/bad.ts")).rejects.toThrow();
  });
});

describe("the build plugin", () => {
  const root = mkdtempSync(join(tmpdir(), "yerd-vite-build-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function configured(options: Parameters<typeof yerd>[0]) {
    const plugin = yerd(options).find((p) => p.name === "yerd:build")!;
    const config = hook(plugin, "config")({ root }) as {
      builder: { buildApp(builder: unknown): Promise<void> };
      environments: { client: { build: Record<string, any> }; ssr: { build: Record<string, any> } };
    };
    return { plugin, config };
  }

  it("builds the client into <outDir>/client with a manifest, from root-relative inputs", () => {
    const { config } = configured({ client: ["src/a.css", "./src/b.css", "/src/c.css"], outDir: "out" });
    expect(config.environments.client.build).toMatchObject({ outDir: "out/client", manifest: true, emptyOutDir: true });
    expect(config.environments.client.build.rollupOptions.input).toEqual([`${root}/src/a.css`, `${root}/src/b.css`, `${root}/src/c.css`]);
  });

  it("adds every *.client module in the project as an entry, keeping their exports", async () => {
    const project = mkdtempSync(join(tmpdir(), "yerd-vite-client-"));
    try {
      for (const file of [
        "src/widgets/chart.client.ts", "src/a.client.tsx", "src/b.client.js", "lib/c.client.jsx", "client.ts", "src/plain.ts", "src/x.client.css",
        "node_modules/pkg/skip.client.ts", ".cache/skip.client.ts", "out/client/skip.client.js", "src/.hidden/skip.client.ts",
      ]) {
        mkdirSync(join(project, file, ".."), { recursive: true });
        writeFileSync(join(project, file), "export default () => {};\n");
      }
      const plugin = yerd({ client: ["src/styles.css", "./src/a.client.tsx"], outDir: "out" }).find((p) => p.name === "yerd:build")!;
      const config = hook(plugin, "config")({ root: project }) as {
        builder: { buildApp(builder: unknown): Promise<void> };
        environments: { client: { build: Record<string, any> } };
      };
      expect(config.environments.client.build.rollupOptions).toEqual({
        input: ["src/styles.css", "src/a.client.tsx", "lib/c.client.jsx", "src/b.client.js", "src/widgets/chart.client.ts"].map((file) => `${project}/${file}`),
        preserveEntrySignatures: "exports-only",
      });

      // With no `client` list, the modules alone are reason to build the client.
      const only = hook(yerd({ outDir: "out" }).find((p) => p.name === "yerd:build")!, "config")({ root: project }) as typeof config;
      expect(only.environments.client.build.rollupOptions.input).toHaveLength(4);
      mkdirSync(join(project, "out", "server"), { recursive: true });
      writeFileSync(join(project, "out", "server", "prerender.js"), "export default { async prerender() { return []; } };\n");
      const built: string[] = [];
      await only.builder.buildApp({ environments: { client: { name: "client" }, ssr: { name: "ssr" } }, build: async (env: { name: string }) => void built.push(env.name) });
      expect(built).toEqual(["client", "ssr"]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("builds the server unminified into <outDir>/server from two virtual entries", () => {
    const { config } = configured({});
    expect(config.environments.ssr.build).toMatchObject({
      outDir: "dist/server",
      ssr: true,
      minify: false,
      rollupOptions: { input: { server: "virtual:yerd/server-entry", prerender: "virtual:yerd/prerender-entry" } },
    });
  });

  it("resolves only its own virtual ids", () => {
    const { plugin } = configured({});
    const resolveId = hook(plugin, "resolveId");
    expect(resolveId("virtual:yerd/server-entry")).toBe("\0virtual:yerd/server-entry");
    expect(resolveId("virtual:yerd/prerender-entry")).toBe("\0virtual:yerd/prerender-entry");
    expect(resolveId("virtual:yerd/other")).toBeNull();
    expect(resolveId("/src/main.ts")).toBeNull();
  });

  it("generates a server entry that serves the client build and listens on PORT and HOST", () => {
    const { plugin } = configured({ entry: "/src/app.ts" });
    const code = hook(plugin, "load")("\0virtual:yerd/server-entry") as string;
    // NODE_ENV is set before the app loads, so the app is imported dynamically after it.
    expect(code).toContain(`process.env["NODE_ENV"] ??= "production";`);
    expect(code).toContain(`const { default: app } = await import(${JSON.stringify(`${root}/src/app.ts`)});`);
    expect(code.indexOf("NODE_ENV")).toBeLessThan(code.indexOf("await import("));
    // Vite's base goes to clientBuild ("/" when the config sets none).
    expect(code).toContain(`if (existsSync(manifest)) app.clientBuild(client, manifest, { base: "/" });`);
    expect(code).toContain(`else app.static("/", client);`);
    expect(code).toContain("app.listen(Number(process.env.PORT ?? 3000), process.env.HOST || undefined)");
  });

  it("generates a prerender entry that only re-exports the app", () => {
    const { plugin } = configured({});
    expect(hook(plugin, "load")("\0virtual:yerd/prerender-entry")).toBe(`export { default } from ${JSON.stringify(`${root}/src/main.ts`)};\n`);
    expect(hook(plugin, "load")("/src/main.ts")).toBeNull();
  });

  it("passes a bare-module entry through, and escapes awkward characters in the path", () => {
    const bare = configured({ entry: "my-app/server" });
    expect(hook(bare.plugin, "load")("\0virtual:yerd/prerender-entry")).toBe('export { default } from "my-app/server";\n');
    const odd = configured({ entry: '/src/we"ird\\name.ts' });
    const code = hook(odd.plugin, "load")("\0virtual:yerd/prerender-entry") as string;
    expect(code).toBe(`export { default } from ${JSON.stringify(`${root}/src/we"ird\\name.ts`)};\n`);
  });

  it("buildApp builds the server (and the client only when there are client entries), then prerenders into the client dir", async () => {
    const outDir = "dist-test";
    mkdirSync(join(root, outDir, "server"), { recursive: true });
    writeFileSync(
      join(root, outDir, "server", "prerender.js"),
      `export default { async prerender(dir) { globalThis.__yerdPrerenderDir = dir; return ["/", "/about"]; } };\n`,
    );
    const built: string[] = [];
    const builder = {
      environments: { client: { name: "client" }, ssr: { name: "ssr" } },
      build: async (env: { name: string }) => void built.push(env.name),
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await configured({ outDir }).config.builder.buildApp(builder);
      expect(built).toEqual(["ssr"]);
      await configured({ outDir, client: ["src/a.css"] }).config.builder.buildApp(builder);
      expect(built).toEqual(["ssr", "client", "ssr"]);
      expect((globalThis as { __yerdPrerenderDir?: string }).__yerdPrerenderDir).toBe(`${root}/${outDir}/client`);
      expect(existsSync(join(root, outDir, "client"))).toBe(true);
      expect(log).toHaveBeenCalledWith("yerd: prerendered 2 path(s): /, /about");
    } finally {
      log.mockRestore();
    }
  });
});

describe("the dev server", () => {
  const src = (path: string) => fileURLToPath(new URL(`../../src/${path}`, import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "yerd-vite-edge-"));
  mkdirSync(join(dir, "src", "routes"), { recursive: true });
  mkdirSync(join(dir, "public"), { recursive: true });
  const route = (path: string, text: string) => `
import { get, route } from "@toyz/yerd";
@route(${JSON.stringify(path)})
export class Page {
  @get show() { return ${JSON.stringify(text)}; }
}
`;
  const goodMain = `
import { yerd } from "@toyz/yerd";
export default yerd({ handleSignals: false }).discover(import.meta.glob("./routes/*.ts", { eager: true }));
`;
  writeFileSync(join(dir, "src", "main.ts"), goodMain);
  writeFileSync(join(dir, "src", "routes", "page.ts"), route("/", "one"));

  let server: ViteDevServer;
  let url: string;
  beforeAll(async () => {
    server = await createServer({
      root: dir,
      configFile: false,
      logLevel: "silent",
      plugins: [yerd({ entry: "/src/main.ts", client: ["src/styles.css"] })],
      resolve: { alias: [{ find: /^@toyz\/yerd$/, replacement: src("index.ts") }] },
      server: { port: 0, host: "127.0.0.1" },
    });
    await server.listen();
    url = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
  });
  afterAll(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const settle = () => new Promise((r) => setTimeout(r, 300));
  const text = async (path: string) => {
    const r = await fetch(url + path);
    return [r.status, await r.text()] as const;
  };

  it("publishes where assets live for assetUrl() checks", () => {
    expect((globalThis as Record<symbol, unknown>)[Symbol.for("yerd.devAssets")]).toEqual({
      root: dir,
      publicDir: join(dir, "public"),
      client: ["src/styles.css"],
    });
  });

  it("serves the app, answers 404s itself, and recovers from a broken route module without duplicate routes", async () => {
    expect(await text("/")).toEqual([200, "one"]);
    expect((await text("/nowhere"))[0]).toBe(404);

    writeFileSync(join(dir, "src", "routes", "page.ts"), `${route("/", "two")}\nthrow new Error("half-evaluated");\n`);
    await settle();
    expect((await text("/"))[0]).toBe(500);
    // Fails again (not "Duplicate route") while it's still broken.
    expect((await text("/"))[0]).toBe(500);

    writeFileSync(join(dir, "src", "routes", "page.ts"), route("/", "three"));
    await settle();
    expect(await text("/")).toEqual([200, "three"]);
  });

  it("explains an entry without a default export, then picks up the fix", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(join(dir, "src", "main.ts"), `export const notTheApp = 1;\n`);
    await settle();
    expect((await text("/"))[0]).toBe(500);

    writeFileSync(join(dir, "src", "main.ts"), goodMain);
    await settle();
    expect(await text("/")).toEqual([200, "three"]);
  });

  it("serves concurrent requests during a reload from the new app only", async () => {
    writeFileSync(join(dir, "src", "routes", "page.ts"), route("/", "four"));
    await settle();
    const results = await Promise.all(Array.from({ length: 10 }, () => text("/")));
    expect(results).toEqual(Array.from({ length: 10 }, () => [200, "four"]));
  });

  it("tells MemoryStore it runs under the dev server with a flag of its own", () => {
    expect((globalThis as Record<symbol, unknown>)[Symbol.for("yerd.devServer")]).toBe(true);
  });

  it("reloads for modules the app loaded and new module files, not for stylesheets, public files or data", async () => {
    // A value fixed when the module runs: it changes only when the app is re-imported.
    writeFileSync(join(dir, "src", "routes", "loaded.ts"), `
import { get, route } from "@toyz/yerd";
const loadedAt = Math.random();
@route("/loaded")
export class Loaded {
  @get show() { return String(loadedAt); }
}
`);
    await settle();
    const [, first] = await text("/loaded");
    expect(first).toMatch(/^0\./);

    writeFileSync(join(dir, "src", "styles.css"), "body { color: red; }");
    writeFileSync(join(dir, "public", "data.json"), `{"n":${Date.now()}}`);
    writeFileSync(join(dir, "notes.md"), "# notes");
    await settle();
    expect(await text("/loaded")).toEqual([200, first]);

    // An edit to a module the app imported does reload it.
    writeFileSync(join(dir, "src", "routes", "page.ts"), route("/", "five"));
    await settle();
    expect(await text("/")).toEqual([200, "five"]);
    expect((await text("/loaded"))[1]).not.toBe(first);
  });
});
