/**
 * Static files from a directory, hand-rolled on node:fs.
 *
 * - Paths are resolved inside the directory or not at all: `..`, encoded
 *   traversal, NUL bytes and (by default) dotfiles are refused.
 * - ETag + If-None-Match gives 304s; Last-Modified is sent too.
 * - Hashed filenames (Vite's `name-AbC123xy.css`) are cached for a year as
 *   immutable; everything else revalidates.
 * - Precompressed siblings (`file.css.br`, `file.css.gz`) are served when the
 *   client accepts them.
 */

import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep, isAbsolute } from "node:path";
import type { Outgoing } from "../respond/coerce.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
};

export function mimeType(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Vite (Rollup/Rolldown) content hashes: `name-[8+ url-safe chars].ext`.
 * A hash is random base64url, so it has a letter and (almost always) a digit
 * or capital; requiring both keeps ordinary hyphenated names like
 * `user-settings.json` or `report-20261017.pdf` out of year-long caching.
 */
const HASHED = /[-.](?=[\w-]*[A-Za-z])(?=[\w-]*[A-Z0-9])[\w-]{8,}\.[a-z0-9]+$/;

export interface StaticOptions {
  /** Serve files whose name starts with "." (default false). */
  dotfiles?: boolean;
  /** Only serve these extensions, e.g. [".css"] when pointing at a source folder. */
  extensions?: string[];
  /**
   * Cache-Control for files. Default: a year + immutable for hashed names,
   * "no-cache" (revalidate with the ETag) for the rest.
   */
  cacheControl?: (path: string) => string;
  /** Serve files that are symlinks pointing outside the mount's directory (default false). */
  followSymlinks?: boolean;
}

export interface StaticMount {
  prefix: string;
  root: string;
  options: StaticOptions;
  /** The root with symlinks resolved, found on first use. */
  realRoot?: Promise<string | undefined>;
}

export function createMount(prefix: string, dir: string, options: StaticOptions = {}): StaticMount {
  const normalized = prefix === "/" ? "/" : `/${prefix.replace(/^\/+|\/+$/g, "")}/`;
  return { prefix: normalized, root: resolve(dir), options };
}

function defaultCacheControl(path: string): string {
  return HASHED.test(path) ? "public, max-age=31536000, immutable" : "no-cache";
}

/** Map a URL path to a file inside the mount, or undefined if it isn't allowed. */
function locate(mount: StaticMount, pathname: string): string | undefined {
  if (!pathname.startsWith(mount.prefix) && `${pathname}/` !== mount.prefix) return undefined;
  let rest: string;
  try {
    rest = decodeURIComponent(pathname.slice(mount.prefix.length));
  } catch {
    return undefined;
  }
  if (rest === "" || rest.includes("\0")) return undefined;
  const segments = rest.split(/[/\\]/);
  if (segments.some((s) => s === ".." || s === ".")) return undefined;
  if (!mount.options.dotfiles && segments.some((s) => s.startsWith("."))) return undefined;
  if (mount.options.extensions && !mount.options.extensions.includes(extname(rest).toLowerCase())) return undefined;
  const file = join(mount.root, ...segments);
  const rel = relative(mount.root, file);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) return undefined;
  return file;
}

/** True when `file`, symlinks resolved, is still inside the mount. */
async function insideRoot(mount: StaticMount, file: string): Promise<boolean> {
  if (mount.options.followSymlinks) return true;
  mount.realRoot ??= realpath(mount.root).catch(() => undefined);
  const root = await mount.realRoot;
  if (!root) return false;
  let real: string;
  try {
    real = await realpath(file);
  } catch {
    return false;
  }
  const rel = relative(root, real);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Whether Accept-Encoding allows `encoding` (listed, or via *, and not with q=0). */
export function acceptsEncoding(header: string, encoding: string): boolean {
  let wildcard: boolean | undefined;
  for (const part of header.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const allowed = q === undefined || Number(q.slice(2)) > 0;
    if (name === encoding) return allowed;
    if (name === "*") wildcard = allowed;
  }
  return wildcard ?? false;
}

async function fileStat(path: string) {
  try {
    const s = await stat(path);
    return s.isFile() ? s : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Try to answer a GET/HEAD from a mount. Returns undefined when there's no
 * such file, so the caller can carry on (404, next mount, ...).
 */
export async function serveStatic(
  mount: StaticMount,
  pathname: string,
  headers: { "if-none-match"?: string | undefined; "accept-encoding"?: string | undefined },
): Promise<Outgoing | undefined> {
  const file = locate(mount, pathname);
  if (!file) return undefined;
  const info = await fileStat(file);
  if (!info || !(await insideRoot(mount, file))) return undefined;

  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const base: Record<string, string> = {
    "content-type": mimeType(file),
    "cache-control": (mount.options.cacheControl ?? defaultCacheControl)(file),
    etag,
    "last-modified": info.mtime.toUTCString(),
    vary: "accept-encoding",
  };

  const inm = headers["if-none-match"];
  if (inm && inm.split(",").some((tag) => tag.trim() === etag || tag.trim() === "*")) {
    return { status: 304, headers: base, body: null };
  }

  // Precompressed sibling, if the client takes it and it exists.
  const accept = headers["accept-encoding"] ?? "";
  for (const [encoding, suffix] of [["br", ".br"], ["gzip", ".gz"]] as const) {
    if (!acceptsEncoding(accept, encoding)) continue;
    const compressed = await fileStat(file + suffix);
    if (compressed && (await insideRoot(mount, file + suffix))) {
      return {
        status: 200,
        headers: { ...base, "content-encoding": encoding, "content-length": String(compressed.size) },
        body: createReadStream(file + suffix),
      };
    }
  }

  return { status: 200, headers: { ...base, "content-length": String(info.size) }, body: createReadStream(file) };
}
