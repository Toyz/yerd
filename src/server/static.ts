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
 * - A served file costs one stat: its symlink check and missing siblings are
 *   remembered while it's unchanged. Build output (an immutable mount) isn't
 *   stat'd again at all.
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

/**
 * The Content-Type yerd serves for a file, by extension (case-insensitive);
 * application/octet-stream when unknown. Text types carry `charset=utf-8`.
 * Handy when a route sends files itself:
 *
 * ```ts
 * @route("/uploads/:name")
 * class Upload {
 *   @param("name") accessor name!: string;
 *
 *   @get async file() {
 *     const bytes = await readFile(join(uploads, this.name));
 *     return res(bytes, { headers: { "content-type": mimeType(this.name) } }); // "image/png" for a .png
 *   }
 * }
 * ```
 */
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

/**
 * Options for app.static().
 *
 * ```ts
 * yerd()
 *   .static("/src", "src", { extensions: [".css", ".svg"] })
 *   .static("/downloads", "files", { index: false, cacheControl: () => "public, max-age=3600" });
 * ```
 */
export interface StaticOptions {
  /**
   * Serve files and folders whose name starts with "." (default false). Only
   * names inside the directory count: a `/.well-known` mount prefix doesn't
   * need it. Turning it on serves every dotfile there, so keep secrets out.
   *
   * ```ts
   * app.static("/", "public", { dotfiles: true }); // public/.well-known/security.txt
   * ```
   */
  dotfiles?: boolean;
  /** Serve `index.html` for a request to a directory (`/`, `/docs/`). Default true. */
  index?: boolean;
  /**
   * Only serve these extensions (lower case, with the dot), e.g. [".css"]
   * when pointing at a source folder.
   *
   * ```ts
   * app.static("/src", "src", { extensions: [".css", ".svg"] }); // never the .ts next to them
   * ```
   */
  extensions?: string[];
  /**
   * Cache-Control for files, given each file's path on disk. Default: a year
   * + immutable for hashed names, "no-cache" (revalidate with the ETag) for
   * the rest.
   *
   * ```ts
   * app.static("/", "public", { cacheControl: (path) => (path.endsWith(".html") ? "no-cache" : "public, max-age=86400") });
   * ```
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
  /** Files never change while the process runs (a production build): what's found once is kept. */
  immutable: boolean;
  /** What's been found out about files served, by path on disk. */
  files: Map<string, FileEntry>;
}

/** A file as last seen: enough to tell it changed, and whether it's inside the mount. */
interface Probe {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  mtime: Date;
  /** Symlinks resolved, still inside the mount. */
  inside: boolean;
}

interface FileEntry {
  file: Probe;
  /** Precompressed siblings: what was found, null for none, missing for not looked yet. */
  ".br"?: Probe | null;
  ".gz"?: Probe | null;
  /** When the siblings were last looked for. */
  checked: number;
}

/** Most files remembered per mount; past it, the oldest are forgotten. */
const FILES_MAX = 4096;
/** How long a missing sibling stays missing, unless the file itself changes (mutable mounts). */
const SIBLING_TTL = 2000;

/**
 * A mount for app.static(). `immutable` is for build output that can't
 * change while the process runs: files are stat'd once, not per request.
 */
export function createMount(prefix: string, dir: string, options: StaticOptions = {}, immutable = false): StaticMount {
  const normalized = prefix === "/" ? "/" : `/${prefix.replace(/^\/+|\/+$/g, "")}/`;
  return { prefix: normalized, root: resolve(dir), options, immutable, files: new Map() };
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
  if (rest.includes("\0")) return undefined;
  if (rest === "" || rest.endsWith("/")) {
    if (mount.options.index === false) return undefined;
    rest += "index.html";
  }
  const segments = rest.split(/[/\\]/);
  if (segments.some((s) => s === ".." || s === ".")) return undefined;
  if (!mount.options.dotfiles && segments.some((s) => s.startsWith("."))) return undefined;
  if (mount.options.extensions && !mount.options.extensions.includes(extname(rest).toLowerCase())) return undefined;
  const file = join(mount.root, ...segments);
  if (!within(mount.root, file)) return undefined;
  return file;
}

/** True when `path` is strictly inside `root` ("..env" is a name, not a way out). */
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
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
  return within(root, real);
}

/** Whether Accept-Encoding allows `encoding` (listed, or via *, and not with q=0). */
export function acceptsEncoding(header: string, encoding: string): boolean {
  let wildcard: boolean | undefined;
  for (const part of header.split(",")) {
    const [coding, ...params] = part.toLowerCase().split(";");
    // Whitespace is allowed before the ";" too (`gzip ;q=0`).
    const name = coding!.trim();
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
 * `path` as it is now, reusing `cached` (and its symlink check) while the
 * file is unchanged; on an immutable mount, anything already looked up.
 * Null when there's no such file.
 */
async function probe(mount: StaticMount, path: string, cached: Probe | null | undefined): Promise<Probe | null> {
  if (cached !== undefined && mount.immutable) return cached;
  const info = await fileStat(path);
  if (!info) return null;
  if (cached && cached.ino === info.ino && cached.dev === info.dev && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached;
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, mtime: info.mtime, inside: await insideRoot(mount, path) };
}

/** The file's entry, refreshed: a changed file starts over, siblings included. */
async function lookup(mount: StaticMount, file: string): Promise<FileEntry | undefined> {
  const { files } = mount;
  let entry = files.get(file);
  const found = await probe(mount, file, entry?.file);
  if (!found) {
    files.delete(file);
    return undefined;
  }
  if (entry?.file !== found) {
    entry = { file: found, checked: Date.now() };
    files.delete(file);
    files.set(file, entry);
    if (files.size > FILES_MAX) files.delete(files.keys().next().value!);
  }
  return entry;
}

/** A precompressed sibling inside the mount, or null. A missing one isn't looked for on every request. */
async function sibling(mount: StaticMount, file: string, entry: FileEntry, suffix: ".br" | ".gz"): Promise<Probe | null> {
  const now = Date.now();
  if (!mount.immutable && now - entry.checked > SIBLING_TTL) {
    entry[".br"] = entry[".gz"] = undefined;
    entry.checked = now;
  }
  // A sibling that's there is checked again (unless immutable): its size is the Content-Length.
  if (entry[suffix] !== null) entry[suffix] = await probe(mount, file + suffix, entry[suffix]);
  const found = entry[suffix];
  return found?.inside ? found : null;
}

/**
 * Try to answer a GET/HEAD from a mount. Returns undefined when there's no
 * such file, so the caller can carry on (404, next mount, ...). `headOnly`
 * (a HEAD) answers with the headers and no body, so the file isn't opened.
 */
export async function serveStatic(
  mount: StaticMount,
  pathname: string,
  headers: { "if-none-match"?: string | undefined; "accept-encoding"?: string | undefined },
  headOnly = false,
): Promise<Outgoing | undefined> {
  const file = locate(mount, pathname);
  if (!file) return undefined;
  const entry = await lookup(mount, file);
  if (!entry?.file.inside) return undefined;
  const info = entry.file;

  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const base: Record<string, string> = {
    "content-type": mimeType(file),
    "cache-control": (mount.options.cacheControl ?? defaultCacheControl)(file),
    etag,
    "last-modified": info.mtime.toUTCString(),
    vary: "accept-encoding",
  };

  // If-None-Match compares weakly (RFC 9110 13.1.2): `"x"` matches `W/"x"`.
  const inm = headers["if-none-match"];
  if (inm && inm.split(",").some((tag) => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === etag.slice(2))) {
    return { status: 304, headers: base, body: null };
  }

  // Precompressed sibling, if the client takes it and it exists.
  const accept = headers["accept-encoding"] ?? "";
  for (const [encoding, suffix] of [["br", ".br"], ["gzip", ".gz"]] as const) {
    if (!acceptsEncoding(accept, encoding)) continue;
    const compressed = await sibling(mount, file, entry, suffix);
    if (compressed) {
      return {
        status: 200,
        headers: { ...base, "content-encoding": encoding, "content-length": String(compressed.size) },
        body: headOnly ? null : createReadStream(file + suffix),
      };
    }
  }

  return { status: 200, headers: { ...base, "content-length": String(info.size) }, body: headOnly ? null : createReadStream(file) };
}
