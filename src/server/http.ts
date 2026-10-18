/**
 * Small HTTP helpers shared by the server, the session manager, auth and
 * logging, so each rule (what a forwarded header means, how Vary adds up,
 * which requests count as page loads) is written once.
 */

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { Body } from "../respond/coerce.js";

/** Split a request target into path and search without building a URL object. */
export function splitTarget(target: string): { path: string; search: string } {
  const q = target.indexOf("?");
  return q === -1 ? { path: target, search: "" } : { path: target.slice(0, q), search: target.slice(q) };
}

/** `existing` plus the names in `added` it doesn't list yet (case-insensitive). */
export function mergeVary(existing: string | undefined, added: string): string {
  if (!existing) return added;
  const have = existing.toLowerCase().split(/\s*,\s*/);
  const extra = added.split(/\s*,\s*/).filter((name) => name && !have.includes(name.toLowerCase()));
  return extra.length === 0 ? existing : `${existing}, ${extra.join(", ")}`;
}

/**
 * The first value of an X-Forwarded-* header, trimmed, or undefined when
 * there is none. Proxies chain them ("https, http"): the first is what the
 * client itself sent.
 */
export function forwarded(value: string | string[] | undefined): string | undefined {
  return (Array.isArray(value) ? value[0] : value)?.split(",")[0]!.trim() || undefined;
}

/**
 * Whether the request came over HTTPS: a TLS socket always counts, so a
 * header can never downgrade an encrypted connection (or its Secure
 * cookie). Otherwise, with `trustProxy`, X-Forwarded-Proto in any case
 * ("https", "HTTPS"). Anyone can send that header, so it's believed only
 * when we were told a proxy sets it. ctx.url and the session cookie both
 * read this, so they never disagree.
 */
export function requestIsHttps(req: IncomingMessage, trustProxy: boolean): boolean {
  if ((req.socket as { encrypted?: boolean } | undefined)?.encrypted === true) return true;
  return trustProxy && forwarded(req.headers["x-forwarded-proto"])?.toLowerCase() === "https";
}

/**
 * The origin a request was sent to ("https://shop.example"), by the same
 * rules as ctx.url: https per requestIsHttps, the host from X-Forwarded-Host
 * under `trustProxy`, else Host. Undefined for a malformed host.
 */
export function requestOrigin(req: IncomingMessage, trustProxy: boolean): string | undefined {
  const host = (trustProxy ? forwarded(req.headers["x-forwarded-host"]) : undefined) ?? req.headers.host ?? "localhost";
  try {
    return new URL(`${requestIsHttps(req, trustProxy) ? "https" : "http"}://${host}`).origin;
  } catch {
    return undefined;
  }
}

const REQUEST_ID = /^[\w.:@-]{1,128}$/;

/** A well-formed `x-request-id` the client sent, else undefined (the caller makes one up). */
export function requestIdFrom(req: IncomingMessage): string | undefined {
  const given = req.headers["x-request-id"];
  return typeof given === "string" && REQUEST_ID.test(given) ? given : undefined;
}

/**
 * An AbortController that aborts when the client goes away before the
 * response finished: on "close" without a finished write, or right away if
 * the response is already gone.
 */
export function abortOnClose(res: ServerResponse): AbortController {
  const abort = new AbortController();
  if (res.destroyed && !res.writableFinished) abort.abort(new Error("client disconnected"));
  else
    res.once("close", () => {
      if (!res.writableFinished) abort.abort(new Error("client disconnected"));
    });
  return abort;
}

/** A body sent in pieces (rendered page, SSE, NDJSON) rather than all at once. */
export function isStreamBody(body: Body): body is AsyncIterable<string | Uint8Array> {
  return body !== null && typeof body !== "string" && !(body instanceof Uint8Array);
}

/**
 * A browser page load or one of yerd's runtime's own requests (`yx`,
 * `yx-dynamic`): the requests that get HTML pages, error pages and login
 * redirects rather than JSON, text or a 401. The runtime sends
 * `accept: text/html` with those headers anyway; they're checked too so a
 * scripted client that leaves Accept out is still treated as the runtime.
 */
export function wantsPage(headers: IncomingHttpHeaders): boolean {
  return (headers.accept ?? "").includes("text/html") || headers["yx"] !== undefined || headers["yx-dynamic"] !== undefined;
}

/** NODE_ENV is "development" or unset: the dev server, or a plain `node app.js` on a laptop. */
export function isDevelopment(): boolean {
  const env = process.env.NODE_ENV;
  return env === undefined || env === "development";
}
