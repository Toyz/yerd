/**
 * app.compression(): responses compressed on the fly, for deploys without a
 * compressing proxy in front. A body sent in one piece is compressed off the
 * event loop and keeps a Content-Length; a streamed page goes through a
 * compressor that flushes after every chunk, so the browser still gets the
 * top of the page as soon as it's rendered.
 */

import { promisify } from "node:util";
import { brotliCompress, constants, createBrotliCompress, createGzip, gzip, type BrotliCompress, type Gzip } from "node:zlib";
import { acceptsEncoding } from "../server/static.js";
import { mergeVary } from "../server/http.js";
import type { Outgoing } from "./coerce.js";

/**
 * Options for app.compression().
 *
 * ```ts
 * yerd().compression({ threshold: 2048, encodings: ["gzip"] });
 * ```
 */
export interface CompressionOptions {
  /** Smallest body compressed, in bytes; smaller ones aren't worth it. Default 1024. Streams are always compressed. */
  threshold?: number;
  /** Encodings to offer, preferred first. Default ["br", "gzip"]. */
  encodings?: readonly ("br" | "gzip")[];
  /** Brotli quality, 0 to 11. Default 4: most of the gain at a fraction of 11's cost per response. */
  brotliQuality?: number;
  /** Gzip level, 1 to 9. Default 6. */
  gzipLevel?: number;
}

/** CompressionOptions checked, with defaults filled in. */
export interface Compression {
  threshold: number;
  encodings: readonly ("br" | "gzip")[];
  brotliQuality: number;
  gzipLevel: number;
}

export function compileCompression(options: CompressionOptions = {}): Compression {
  const { threshold = 1024, encodings = ["br", "gzip"], brotliQuality = 4, gzipLevel = 6 } = options;
  if (!Number.isInteger(threshold) || threshold < 0) throw new TypeError(`compression: threshold must be a whole number of bytes, not ${threshold}`);
  if (encodings.length === 0 || encodings.some((e) => e !== "br" && e !== "gzip")) throw new TypeError(`compression: encodings are "br" and "gzip", not ${JSON.stringify(encodings)}`);
  if (!Number.isInteger(brotliQuality) || brotliQuality < 0 || brotliQuality > 11) throw new TypeError(`compression: brotliQuality is 0 to 11, not ${brotliQuality}`);
  if (!Number.isInteger(gzipLevel) || gzipLevel < 1 || gzipLevel > 9) throw new TypeError(`compression: gzipLevel is 1 to 9, not ${gzipLevel}`);
  return { threshold, encodings, brotliQuality, gzipLevel };
}

/** Text that compresses: HTML, CSS, JS, JSON, XML, SVG, plain text. Images, video, fonts and archives are compressed already. */
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml|x-ndjson|manifest\+json|[\w.+-]+\+(?:json|xml))|image\/svg\+xml)/i;

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

/**
 * `out` compressed for a client that sent `accept` as Accept-Encoding, or
 * as it was: already encoded, bodiless, not text, under the threshold,
 * marked no-transform, or not accepted. Any text response gets Vary:
 * Accept-Encoding, compressed or not, since it could have been.
 */
export function compressOutgoing(out: Outgoing, accept: string | undefined, settings: Compression): Outgoing | Promise<Outgoing> {
  const { body } = out;
  if (body === null || out.status === 204 || out.status === 304 || out.headers["content-encoding"] !== undefined) return out;
  if (!COMPRESSIBLE.test(String(out.headers["content-type"] ?? ""))) return out;
  if (/\bno-transform\b/i.test(String(out.headers["cache-control"] ?? ""))) return out;
  const headers: Outgoing["headers"] = { ...out.headers, vary: mergeVary(out.headers.vary as string | undefined, "accept-encoding") };
  const encoding = settings.encodings.find((e) => acceptsEncoding(accept ?? "", e));
  const buffered = typeof body === "string" || body instanceof Uint8Array;
  const size = typeof body === "string" ? Buffer.byteLength(body) : body instanceof Uint8Array ? body.byteLength : Infinity;
  if (!encoding || size < settings.threshold) return { ...out, headers };
  headers["content-encoding"] = encoding;
  delete headers["content-length"];
  if (buffered) {
    const work = encoding === "br"
      ? brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: settings.brotliQuality, [constants.BROTLI_PARAM_SIZE_HINT]: size } })
      : gzipped(body, { level: settings.gzipLevel });
    return work.then((compressed) => ({ ...out, headers, body: compressed }));
  }
  return { ...out, headers, body: compressStream(body, encoding, settings) };
}

/**
 * A stream compressed chunk by chunk, each flushed: the compressed bytes for
 * a chunk come out before the next one is rendered. Stopping early (the
 * client went away) stops the source too.
 */
async function* compressStream(body: AsyncIterable<string | Uint8Array>, encoding: "br" | "gzip", settings: Compression): AsyncGenerator<Uint8Array> {
  const zip: BrotliCompress | Gzip = encoding === "br"
    ? createBrotliCompress({ flush: constants.BROTLI_OPERATION_FLUSH, params: { [constants.BROTLI_PARAM_QUALITY]: settings.brotliQuality } })
    : createGzip({ flush: constants.Z_SYNC_FLUSH, level: settings.gzipLevel });
  const feeding = (async () => {
    try {
      for await (const chunk of body) {
        if (zip.destroyed) break;
        // A compressor destroyed meanwhile (the client went away) never drains: its close ends the wait too.
        if (!zip.write(chunk)) await new Promise((resolve) => {
          zip.once("drain", resolve);
          zip.once("close", resolve);
        });
      }
      zip.end();
    } catch (error) {
      zip.destroy(error as Error);
    }
  })();
  try {
    for await (const compressed of zip) yield compressed as Uint8Array;
  } finally {
    zip.destroy();
    await feeding;
  }
}
