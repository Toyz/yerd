/**
 * Asset URLs that work the same in dev and production.
 *
 * Write source paths (relative to the Vite root): `assetUrl("src/styles.css")`.
 * In dev (and raw mode) that's `/src/styles.css`, which Vite (or a static
 * mount) serves directly. After `vite build`, the app reads Vite's manifest and
 * the same call returns the hashed file, `/assets/styles-AbC123xy.css`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "./log/logger.js";
import { escapeHtml, raw } from "./render/escape.js";

interface ManifestEntry {
  file: string;
  css?: string[];
}

type Manifest = Record<string, ManifestEntry>;

let manifest: Manifest | undefined;
let base = "/";
/** The client build directory (the manifest's), where files from public/ were copied. */
let clientDir: string | undefined;

/** What the Vite plugin tells a dev app about the project (see src/vite). */
interface DevAssets {
  root: string;
  publicDir: string | false;
  client: string[];
}

const DEV_ASSETS = Symbol.for("yerd.devAssets");
const checked = new Set<string>();

/**
 * In development, once per path: warn when an asset doesn't exist (the page
 * would quietly 404), sits in public/ but is written with its folder, or
 * isn't in the plugin's `client` option (fine in dev, broken after build).
 */
function checkDev(key: string): void {
  const dev = (globalThis as Record<symbol, DevAssets | undefined>)[DEV_ASSETS];
  if (!dev || checked.has(key)) return;
  checked.add(key);
  const log = new Logger("yerd::assets");
  const inPublic = dev.publicDir !== false && existsSync(join(dev.publicDir, key));
  const inRoot = existsSync(join(dev.root, key));
  if (dev.publicDir !== false && inRoot) {
    const fromPublic = relative(dev.publicDir, join(dev.root, key));
    if (!fromPublic.startsWith("..") && !isAbsolute(fromPublic)) {
      log.warn(`assetUrl("${key}"): files in public/ are served from the site root; write assetUrl("${fromPublic.split("\\").join("/")}")`);
      return;
    }
  }
  if (!inRoot && !inPublic) {
    log.warn(`assetUrl("${key}"): no such file under ${dev.root}${dev.publicDir ? " or public/" : ""}, so the page gets a 404`);
    return;
  }
  if (inRoot && !dev.client.some((entry) => normalize(entry) === key)) {
    log.warn(`assetUrl("${key}") isn't in the yerd plugin's \`client\` option: it works in dev, but vite build won't include it, so production pages using it will fail`);
  }
}

function normalize(path: string): string {
  return path.replace(/^\.?\//, "");
}

/**
 * Load a Vite manifest (`.vite/manifest.json` from the client build). After
 * this, assetUrl() returns hashed build output. `publicBase` is where the
 * client build is served from (default "/"). The production server the Vite
 * plugin generates does this for you (through `app.clientBuild()`); call it
 * yourself only with a hand-rolled production setup.
 *
 * ```ts
 * useManifest(new URL("../dist/client/.vite/manifest.json", import.meta.url));
 * // or, with the client build served under /static/:
 * useManifest("dist/client/.vite/manifest.json", "/static/");
 * ```
 */
export function useManifest(file: string | URL, publicBase = "/"): void {
  manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
  base = publicBase.endsWith("/") ? publicBase : `${publicBase}/`;
  // <client>/.vite/manifest.json
  clientDir = dirname(dirname(file instanceof URL ? fileURLToPath(file) : file));
}

/**
 * Forget the manifest (dev servers, tests): assetUrl() goes back to source
 * paths. Also clears the once-per-file dev warnings.
 *
 * ```ts
 * import { afterEach } from "vitest";
 * import { resetManifest } from "@toyz/yerd";
 *
 * afterEach(() => resetManifest());
 * ```
 */
export function resetManifest(): void {
  manifest = undefined;
  base = "/";
  clientDir = undefined;
  checked.clear();
}

/**
 * The URL for a source asset: the hashed build file in production, the
 * source path otherwise. Files in public/ go by their path from it
 * (`assetUrl("favicon.svg")`) and are served as they are. Files Vite should
 * fingerprint must be listed in the yerd plugin's `client` option, or the
 * production call throws.
 *
 * ```tsx
 * <head>
 *   <link rel="icon" href={assetUrl("src/favicon.svg")} />
 * </head>
 * <img src={assetUrl("src/hero.jpg")} alt="" width={1200} height={600} fetchpriority="high" />
 * ```
 */
export function assetUrl(path: string): string {
  const key = normalize(path);
  if (!manifest) {
    checkDev(key);
    return `/${key}`;
  }
  const entry = manifest[key];
  if (entry) return base + entry.file;
  // Not built, but copied from public/ into the client build: served as is.
  if (clientDir && existsSync(join(clientDir, key))) return base + key;
  throw new Error(`${key} isn't in the Vite manifest (add it to the yerd plugin's \`client\` option) or the client build's public files`);
}

/**
 * `<link rel="stylesheet">` for a source stylesheet, hashed in production.
 * `href` is a source path, as for assetUrl().
 *
 * ```tsx
 * function RootLayout({ children }: LayoutProps) {
 *   return (
 *     <html lang="en">
 *       <head>
 *         <Stylesheet href="src/styles.css" />
 *         <Scripts />
 *       </head>
 *       <body>{children}</body>
 *     </html>
 *   );
 * }
 * ```
 */
export function Stylesheet({ href }: { href: string }) {
  return raw(`<link rel="stylesheet" href="${escapeHtml(assetUrl(href))}">`);
}
