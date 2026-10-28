/**
 * Small responses yerd keeps in memory and serves itself (the client runtime
 * and its chunks, sitemaps, robots.txt): the bytes with a weak ETag, and
 * their brotli and gzip copies, each made the first time a client asks for
 * that encoding, off the event loop, then kept.
 */

import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { promisify } from "node:util";
import { brotliCompress, gzip } from "node:zlib";
import { etagMatches } from "../server/http.js";
import { acceptsEncoding } from "../server/static.js";
import type { Outgoing } from "./coerce.js";

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);

/** Bytes to serve, their validator, and their compressed copies once made. */
export interface MemoryAsset {
  readonly raw: Buffer;
  /** Weak: one validator for the identity, gzip and brotli bytes alike. */
  readonly etag: string;
  br?: Promise<Buffer>;
  gzip?: Promise<Buffer>;
}

export function memoryAsset(text: string): MemoryAsset {
  const raw = Buffer.from(text);
  return { raw, etag: `W/"${createHash("sha256").update(raw).digest("base64url").slice(0, 16)}"` };
}

/**
 * The asset as a response to a request with these headers: 304 for a
 * matching If-None-Match, else br or gzip when accepted, else the bytes.
 * `headers` are the response's own (content-type, cache-control).
 */
export async function assetResponse(request: IncomingHttpHeaders, asset: MemoryAsset, headers: Record<string, string>): Promise<Outgoing> {
  const out = { ...headers, etag: asset.etag, vary: "accept-encoding" };
  if (etagMatches(request["if-none-match"], asset.etag)) return { status: 304, headers: out, body: null };
  const accept = request["accept-encoding"] ?? "";
  if (acceptsEncoding(accept, "br")) return { status: 200, headers: { ...out, "content-encoding": "br" }, body: await (asset.br ??= compressBrotli(asset.raw)) };
  if (acceptsEncoding(accept, "gzip")) return { status: 200, headers: { ...out, "content-encoding": "gzip" }, body: await (asset.gzip ??= compressGzip(asset.raw)) };
  return { status: 200, headers: out, body: asset.raw };
}
