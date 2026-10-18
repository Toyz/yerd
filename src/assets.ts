/**
 * Asset URLs that work the same in dev and production.
 *
 * Write source paths (relative to the Vite root): `assetUrl("src/styles.css")`.
 * In dev (and raw mode) that's `/src/styles.css`, which Vite (or a static
 * mount) serves directly. After `vite build`, the app reads Vite's manifest and
 * the same call returns the hashed file, `/assets/styles-AbC123xy.css`.
 */

import { readFileSync } from "node:fs";
import { raw } from "./render/escape.js";

interface ManifestEntry {
  file: string;
  css?: string[];
}

type Manifest = Record<string, ManifestEntry>;

let manifest: Manifest | undefined;
let base = "/";

function normalize(path: string): string {
  return path.replace(/^\.?\//, "");
}

/**
 * Load a Vite manifest (`.vite/manifest.json` from the client build). After
 * this, assetUrl() returns hashed build output. `publicBase` is where the
 * client build is served from (default "/").
 */
export function useManifest(file: string | URL, publicBase = "/"): void {
  manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
  base = publicBase.endsWith("/") ? publicBase : `${publicBase}/`;
}

/** Forget the manifest (dev servers, tests). */
export function resetManifest(): void {
  manifest = undefined;
  base = "/";
}

/** The URL for a source asset: the hashed build file in production, the source path otherwise. */
export function assetUrl(path: string): string {
  const key = normalize(path);
  if (!manifest) return `/${key}`;
  const entry = manifest[key];
  if (!entry) throw new Error(`${key} isn't in the Vite manifest; add it to the yerd plugin's \`client\` option`);
  return base + entry.file;
}

/** `<link rel="stylesheet">` for a source stylesheet, hashed in production. */
export function Stylesheet({ href }: { href: string }) {
  const url = assetUrl(href).replace(/"/g, "&quot;");
  return raw(`<link rel="stylesheet" href="${url}">`);
}
