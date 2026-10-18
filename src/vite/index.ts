/**
 * @toyz/yerd/vite
 *
 * - Lowers TC39 decorators with esbuild. Vite 8's Oxc transformer only knows
 *   legacy decorators and passes `@dec` / `accessor` through untouched, which
 *   Node can't run (docs/SPIKES.md), so Oxc is turned off for app TS.
 * - Mounts the yerd app (the entry module's default export) on Vite's dev
 *   server, loaded through the SSR module runner. On server-side file changes
 *   the route registry is reset and the app re-imported.
 * - `vite build` builds two environments: the client (the `client` entries,
 *   e.g. stylesheets, hashed, with a manifest) into `<outDir>/client`, and a
 *   server bundle into `<outDir>/server/server.js` whose generated entry
 *   serves the client build and listens on PORT. `node dist/server/server.js`.
 */

import type { Plugin, ViteDevServer } from "vite";
import type { ModuleRunner } from "vite/module-runner";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Options for the `@toyz/yerd/vite` plugin (the package's default export). */
export interface YerdViteOptions {
  /** Module whose default export is the yerd app. Default "/src/main.ts". */
  entry?: string;
  /**
   * Client build entries, relative to the Vite root: stylesheets and other
   * assets referenced with assetUrl() / <Stylesheet>. Hashed in production.
   */
  client?: string[];
  /** Build output directory, relative to the Vite root. Default "dist". */
  outDir?: string;
}

const SERVER_ENTRY = "virtual:yerd/server-entry";
const PRERENDER_ENTRY = "virtual:yerd/prerender-entry";

function serverEntrySource(entry: string): string {
  return [
    `import { existsSync } from "node:fs";`,
    `import { fileURLToPath } from "node:url";`,
    `import app from ${JSON.stringify(entry)};`,
    ``,
    `const client = fileURLToPath(new URL("../client/", import.meta.url));`,
    `const manifest = new URL("../client/.vite/manifest.json", import.meta.url);`,
    `if (existsSync(manifest)) app.clientBuild(client, manifest);`,
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

  return {
    name: "yerd:build",
    apply: "build",
    config(config) {
      root = config.root ?? process.cwd();
      return {
        builder: {
          async buildApp(builder) {
            if (clientInputs.length > 0) await builder.build(builder.environments.client!);
            await builder.build(builder.environments.ssr!);
            // Prerender: load the built app (not the dev sources) and render @prerender routes into the client build.
            const serverDir = `${root}/${outDir}/server`;
            const clientDir = `${root}/${outDir}/client`;
            const { pathToFileURL } = await import("node:url");
            const { mkdir } = await import("node:fs/promises");
            await mkdir(clientDir, { recursive: true });
            const mod = (await import(pathToFileURL(`${serverDir}/prerender.js`).href)) as {
              default: { prerender(dir: string): Promise<string[]> };
            };
            const written = await mod.default.prerender(clientDir);
            if (written.length > 0) console.log(`yerd: prerendered ${written.length} path(s): ${written.join(", ")}`);
          },
        },
        environments: {
          client: {
            build: {
              outDir: `${outDir}/client`,
              manifest: true,
              emptyOutDir: true,
              rollupOptions: { input: clientInputs.map((input) => `${root}/${input.replace(/^\.?\//, "")}`) },
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
      if (id === `\0${SERVER_ENTRY}`) return serverEntrySource(app);
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
  /** esbuild target for client code. Default "es2016" (async lowered for the async-context polyfill). */
  clientTarget?: string;
}

/**
 * Just the decorator-lowering part of the yerd plugin: compiles app .ts/.tsx
 * with esbuild (TC39 decorators, yerd JSX) and turns off Vite's Oxc
 * transform. The full plugin already includes it; use this alone to tune the
 * client target or in a Vite setup that doesn't run the yerd app. Needs
 * esbuild installed.
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
      const markStale = () => {
        stale = true;
      };
      server.watcher.on("change", markStale);
      server.watcher.on("add", markStale);
      server.watcher.on("unlink", markStale);

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
