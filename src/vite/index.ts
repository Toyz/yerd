/**
 * @toyz/yerd/vite
 *
 * - Lowers TC39 decorators with esbuild. Vite 8's Oxc transformer only knows
 *   legacy decorators and passes `@dec` / `accessor` through untouched, which
 *   Node can't run (docs/SPIKES.md), so Oxc is turned off for app TS.
 * - Mounts the yerd app (the entry module's default export) on Vite's dev
 *   server, loaded through the SSR module runner. When a module the app
 *   loaded changes (or a module file is added or removed), the registries
 *   are reset and the app re-imported on the next request. Files the app
 *   only reads with node:fs aren't watched that way: import them (`?raw`)
 *   to reload on their changes.
 * - `vite build` builds two environments: the client (the `client` entries,
 *   e.g. stylesheets, and every `*.client.ts` module in the project, hashed,
 *   with a manifest) into `<outDir>/client`, and a
 *   server bundle into `<outDir>/server/server.js` whose generated entry
 *   serves the client build and listens on PORT. `node dist/server/server.js`.
 */

import type { Plugin, ViteDevServer } from "vite";
import type { ModuleRunner } from "vite/module-runner";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readdirSync } from "node:fs";

/**
 * Options for the `@toyz/yerd/vite` plugin (the package's default export).
 * All optional: with none, the app is `src/main.ts`'s default export and
 * the build goes to `dist/`.
 *
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from "vite";
 * import yerd from "@toyz/yerd/vite";
 *
 * export default defineConfig({
 *   plugins: [yerd({ entry: "/src/main.ts", client: ["src/styles.css"] })],
 * });
 * ```
 */
export interface YerdViteOptions {
  /**
   * Module whose default export is the yerd app (it shouldn't call
   * listen(): the plugin serves it in dev and the built server listens).
   * Default "/src/main.ts".
   *
   * ```ts
   * // src/server.ts: yerd({ entry: "/src/server.ts" })
   * export default yerd().sessions().discover(import.meta.glob("./routes/*.tsx", { eager: true }));
   * ```
   */
  entry?: string;
  /**
   * Client build entries, relative to the Vite root: stylesheets and other
   * assets referenced with assetUrl() / <Stylesheet>. Hashed in production.
   * In dev, referencing a file that isn't listed here logs a warning, since
   * the build wouldn't include it. Client modules named `*.client.ts` (or
   * .tsx, .js, .jsx) anywhere in the project are added for you.
   *
   * ```tsx
   * // yerd({ client: ["src/styles.css"] }), then in a layout:
   * <head><Stylesheet href="src/styles.css" /></head>
   * ```
   */
  client?: string[];
  /**
   * Build output directory, relative to the Vite root. Default "dist": the
   * client build lands in `dist/client`, the server in `dist/server/server.js`.
   *
   * ```ts
   * yerd({ outDir: "build" }); // then: node build/server/server.js
   * ```
   */
  outDir?: string;
}

/** Client modules (islands, lazy elements, attribute halves) the build picks up without being listed. */
const CLIENT_MODULE = /\.client\.[jt]sx?$/;

/**
 * Every `*.client.{ts,tsx,js,jsx}` under `root`, relative to it, skipping
 * node_modules, the build output and dot-folders.
 */
function findClientModules(root: string, outDir: string): string[] {
  const skip = outDir.replace(/^\.?\/|\/$/g, "");
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir ? `${root}/${dir}` : root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || path === skip) continue;
        walk(path);
      } else if (entry.isFile() && CLIENT_MODULE.test(entry.name)) found.push(path);
    }
  };
  walk("");
  return found.sort();
}

const SERVER_ENTRY = "virtual:yerd/server-entry";
const PRERENDER_ENTRY = "virtual:yerd/prerender-entry";

function serverEntrySource(entry: string, base: string): string {
  return [
    `import { existsSync } from "node:fs";`,
    `import { fileURLToPath } from "node:url";`,
    ``,
    // A built server is production unless the environment says otherwise. Set
    // before the app loads (hence the dynamic import: static ones run first),
    // in bracket form because Vite's define rewrites process.env.NODE_ENV.
    `process.env["NODE_ENV"] ??= "production";`,
    `const { default: app } = await import(${JSON.stringify(entry)});`,
    ``,
    `const client = fileURLToPath(new URL("../client/", import.meta.url));`,
    `const manifest = new URL("../client/.vite/manifest.json", import.meta.url);`,
    `if (existsSync(manifest)) app.clientBuild(client, manifest, { base: ${JSON.stringify(base)} });`,
    `else app.static("/", client);`,
    ``,
    `const server = await app.listen(Number(process.env.PORT ?? 3000), process.env.HOST || undefined);`,
    "console.log(`yerd listening on ${server.url}`);",
    ``,
  ].join("\n");
}

function production(options: YerdViteOptions): Plugin {
  const entry = options.entry ?? "/src/main.ts";
  const outDir = options.outDir ?? "dist";
  const clientInputs = options.client ?? [];
  let root = process.cwd();
  // Vite's base: where the client build is served from (assets, the css bundle).
  let base = "/";

  return {
    name: "yerd:build",
    apply: "build",
    config(config) {
      root = config.root ?? process.cwd();
      base = config.base ?? "/";
      // Listed entries, then the project's client modules, each once.
      const inputs = Array.from(new Set([...clientInputs.map((input) => input.replace(/^\.?\//, "")), ...findClientModules(root, outDir)]));
      return {
        builder: {
          async buildApp(builder) {
            if (inputs.length > 0) await builder.build(builder.environments.client!);
            await builder.build(builder.environments.ssr!);
            // Prerender: load the built app (not the dev sources) and render @prerender routes into the client build.
            const serverDir = `${root}/${outDir}/server`;
            const clientDir = `${root}/${outDir}/client`;
            const { pathToFileURL } = await import("node:url");
            const { mkdir } = await import("node:fs/promises");
            await mkdir(clientDir, { recursive: true });
            const mod = (await import(pathToFileURL(`${serverDir}/prerender.js`).href)) as {
              default: { prerender(dir: string, options?: { base?: string }): Promise<string[]> };
            };
            const written = await mod.default.prerender(clientDir, { base });
            if (written.length > 0) console.log(`yerd: prerendered ${written.length} path(s): ${written.join(", ")}`);
          },
        },
        environments: {
          client: {
            build: {
              outDir: `${outDir}/client`,
              manifest: true,
              emptyOutDir: true,
              rollupOptions: {
                input: inputs.map((input) => `${root}/${input}`),
                // An app build would drop entry exports (nothing imports an
                // entry); a client module's default export is what yerd calls.
                preserveEntrySignatures: "exports-only",
              },
            },
          },
          ssr: {
            build: {
              outDir: `${outDir}/server`,
              ssr: true,
              emptyOutDir: true,
              // Keep names readable in stack traces and @instrument logs.
              minify: false,
              rollupOptions: { input: { server: SERVER_ENTRY, prerender: PRERENDER_ENTRY } },
            },
          },
        },
      };
    },
    resolveId(id) {
      return id === SERVER_ENTRY || id === PRERENDER_ENTRY ? `\0${id}` : null;
    },
    load(id) {
      const app = entry.startsWith("/") ? `${root}${entry}` : entry;
      if (id === `\0${SERVER_ENTRY}`) return serverEntrySource(app, base);
      // Exports the app without listening, for build-time prerendering.
      if (id === `\0${PRERENDER_ENTRY}`) return `export { default } from ${JSON.stringify(app)};\n`;
      return null;
    },
  };
}

const TS_FILE = /\.[cm]?[jt]sx?$/;

interface EsbuildModule {
  transform(code: string, options: Record<string, unknown>): Promise<{ code: string; map: string }>;
}

let esbuild: Promise<EsbuildModule> | undefined;

function loadEsbuild(): Promise<EsbuildModule> {
  esbuild ??= import("esbuild" as string).catch(() => {
    throw new Error("@toyz/yerd/vite needs esbuild to lower TC39 decorators: npm install -D esbuild");
  }) as Promise<EsbuildModule>;
  return esbuild;
}

/** Options for yerdDecorators(). */
export interface DecoratorOptions {
  /**
   * esbuild target for client code. Default "es2016": async functions are
   * lowered to generators so the browser's async-context polyfill can
   * follow them. Raise it only for client code that doesn't rely on that.
   *
   * ```ts
   * plugins: [yerdDecorators({ clientTarget: "es2020" })],
   * ```
   */
  clientTarget?: string;
}

/**
 * Just the decorator-lowering part of the yerd plugin: compiles app .ts/.tsx
 * with esbuild (TC39 decorators, yerd JSX) and turns off Vite's Oxc
 * transform. The full plugin already includes it; use this alone where the
 * yerd app shouldn't be mounted or built, above all in vitest, which runs on
 * Vite and can't compile TC39 decorators on its own. Needs esbuild installed.
 *
 * ```ts
 * // vitest.config.ts
 * import { defineConfig } from "vitest/config";
 * import { yerdDecorators } from "@toyz/yerd/vite";
 *
 * export default defineConfig({
 *   plugins: [yerdDecorators()],
 * });
 * ```
 */
function decorators(options: DecoratorOptions = {}): Plugin {
  return {
    name: "yerd:decorators",
    enforce: "pre",
    config() {
      return { oxc: false };
    },
    async transform(code, id) {
      const file = id.split("?")[0]!;
      if (!TS_FILE.test(file) || file.includes("/node_modules/") || file.endsWith(".js")) return null;
      const client = this.environment?.config.consumer === "client";
      const { transform } = await loadEsbuild();
      const result = await transform(code, {
        loader: file.endsWith("x") ? (file.endsWith(".jsx") ? "jsx" : "tsx") : "ts",
        // ES2016 in the browser so `async` becomes generators the
        // AsyncLocalStorage polyfill can follow (docs/DYNAMICS.md).
        target: client ? (options.clientTarget ?? "es2016") : "es2022",
        format: "esm",
        jsx: "automatic",
        jsxImportSource: "@toyz/yerd",
        sourcemap: true,
        sourcefile: file,
      });
      return { code: result.code, map: result.map };
    },
  };
}

interface AppModule {
  default?: {
    handle(req: IncomingMessage, res: ServerResponse, next?: (e?: unknown) => void): Promise<void>;
    stop?(): Promise<void>;
    resetRegistries?(): void;
  };
}

interface YerdModule {
  resetRouteRegistry?: () => void;
  resetServiceRegistry?: () => void;
  resetGuardRegistry?: () => void;
  resetAttributeRegistry?: () => void;
  resetLazyElements?: () => void;
}

function devServer(options: YerdViteOptions): Plugin {
  const entry = options.entry ?? "/src/main.ts";
  let stale = false;
  let current: AppModule["default"];
  // The registries the routes write to, reached through the last app that
  // loaded (it keeps working after a failed load: yerd itself isn't reloaded).
  let resetRegistries: (() => void) | undefined;
  // One reload at a time; requests that arrive during it wait for the new app.
  let reloading: Promise<void> | undefined;

  return {
    name: "yerd:dev",
    config() {
      return { appType: "custom" };
    },
    configureServer(server: ViteDevServer) {
      // For assetUrl() / <Stylesheet> in the app (its own module instance): warn
      // about files that don't exist, or that `vite build` won't include.
      (globalThis as Record<symbol, unknown>)[Symbol.for("yerd.devAssets")] = {
        root: server.config.root,
        publicDir: server.config.publicDir || false,
        client: options.client ?? [],
      };
      // MemoryStore keeps its records across the reloads below.
      (globalThis as Record<symbol, unknown>)[Symbol.for("yerd.devServer")] = true;
      // Reload only for files the app's code is made of: modules the server
      // side has loaded (CSS imported with ?url included), or a new module a
      // glob may pick up. Stylesheets linked with assetUrl(), public files and
      // data the app writes don't restart it (Vite serves the assets itself).
      const loaded = (file: string) => (server.environments.ssr.moduleGraph.getModulesByFile(file.replace(/\\/g, "/"))?.size ?? 0) > 0;
      server.watcher.on("change", (file) => {
        if (loaded(file)) stale = true;
      });
      const addedOrRemoved = (file: string) => {
        if (TS_FILE.test(file) || loaded(file)) stale = true;
      };
      server.watcher.on("add", addedOrRemoved);
      server.watcher.on("unlink", addedOrRemoved);

      // yerd's own module runner, with HMR off. Vite's default SSR runner
      // re-executes the entries it has seen as soon as a file changes, which
      // would race the reload below and register every route twice. With HMR
      // off, code is only re-run when this plugin clears the cache, once, in
      // order: stop the old app, reset the registries, import afresh.
      let ownRunner: Promise<ModuleRunner> | undefined;
      const runnerFor = () =>
        (ownRunner ??= import("vite").then(({ createServerModuleRunner }) => {
          const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
          // Vite shutting down: stop the app too (hosted services, timers,
          // @onShutdown hooks), or they'd keep the process alive.
          server.httpServer?.once("close", () => {
            void Promise.resolve(current?.stop?.())
              .catch((error) => console.error("[yerd] stopping the app failed:", error))
              .finally(() => runner.close());
          });
          return runner;
        }));

      // Returned function: runs after Vite's own middlewares, so assets and
      // /@vite/* are served first and yerd gets everything else.
      return () => {
        server.middlewares.use(async (req, res, next) => {
          try {
            const runner = await runnerFor();
            if (stale && !reloading) {
              stale = false;
              reloading = (async () => {
                // Stop the old app's hosted services, timers and singletons before
                // loading the new one, or every reload would leave them running.
                const old = current;
                current = undefined;
                try {
                  await old?.stop?.();
                } catch (error) {
                  console.error("[yerd] stopping the previous app failed:", error);
                }
                if (resetRegistries) resetRegistries();
                else {
                  // No app has loaded yet: the best guess is yerd as the runner sees it.
                  const yerdModule = (await runner.import("@toyz/yerd")) as YerdModule;
                  yerdModule.resetRouteRegistry?.();
                  yerdModule.resetServiceRegistry?.();
                  yerdModule.resetGuardRegistry?.();
                  yerdModule.resetAttributeRegistry?.();
                  yerdModule.resetLazyElements?.();
                }
                runner.clearCache();
              })().finally(() => {
                reloading = undefined;
              });
            }
            if (reloading) await reloading;
            let mod: AppModule;
            try {
              mod = (await runner.import(entry)) as AppModule;
            } catch (error) {
              // A half-evaluated entry may have registered some routes; start
              // clean on the next request instead of reporting duplicates.
              stale = true;
              throw error;
            }
            if (!mod.default || typeof mod.default.handle !== "function") {
              throw new Error(`${entry} must default-export a yerd app (export default yerd()...)`);
            }
            current = mod.default;
            if (mod.default.resetRegistries) resetRegistries = mod.default.resetRegistries.bind(mod.default);
            // No `next`: Vite's own middlewares already ran, so anything that
            // reaches yerd is the app's, 404s included (rendered by errorPage).
            await mod.default.handle(req, res);
          } catch (error) {
            if (error instanceof Error) server.ssrFixStacktrace(error);
            next(error);
          }
        });
      };
    },
  };
}

/** The yerd Vite plugin: decorator lowering, the dev server mount, and the production build. */
export default function yerd(options: YerdViteOptions = {}): Plugin[] {
  return [decorators(), devServer(options), production(options)];
}

export { decorators as yerdDecorators };
