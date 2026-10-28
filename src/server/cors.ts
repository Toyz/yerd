/**
 * CORS for routes that other origins may call: the `cors` option on @route
 * and @group. A preflight (OPTIONS with Access-Control-Request-Method) is
 * answered from the options; any other request from an allowed origin gets
 * the Access-Control-* headers, and gets past the cross-site check, which
 * otherwise refuses unsafe requests from other origins.
 */

import type { IncomingHttpHeaders } from "node:http";
import type { Outgoing } from "../respond/coerce.js";

/**
 * Who may call a route from another origin, and how.
 *
 * ```ts
 * @group("/api", { session: false, cors: { origins: ["https://app.example"], headers: ["authorization", "content-type"] } })
 * class Api {}
 * ```
 */
export interface CorsOptions {
  /**
   * Allowed origins: a list ("https://app.example", no path), `"*"` for
   * any (only without `credentials`), or a function given the request's
   * Origin.
   */
  origins: readonly string[] | "*" | ((origin: string) => boolean);
  /** Send cookies and Authorization with the request (Access-Control-Allow-Credentials). Default false. */
  credentials?: boolean;
  /** Methods a preflight allows. Default: the route's own verbs. */
  methods?: readonly string[];
  /** Request headers a preflight allows. Default: whichever the browser asks for. */
  headers?: readonly string[];
  /** Response headers the page's script may read beyond the simple ones (Access-Control-Expose-Headers). */
  expose?: readonly string[];
  /** How long a browser may keep a preflight's answer, in seconds. Default 600. */
  maxAge?: number;
}

/** CorsOptions checked and worked out once, at boot. */
export interface CorsPolicy {
  allows(origin: string): boolean;
  /** Any origin, without credentials: `*`, and no Vary on Origin. */
  readonly any: boolean;
  readonly options: CorsOptions;
}

/** Check `options` and build the policy. Throws on an origin that isn't one, or `*` with credentials. */
export function compileCors(options: CorsOptions): CorsPolicy {
  const { origins } = options;
  if (origins === "*") {
    if (options.credentials) throw new TypeError(`cors: origins "*" can't be used with credentials; list the origins`);
    return { allows: () => true, any: true, options };
  }
  if (typeof origins === "function") return { allows: (origin) => origin !== "null" && origins(origin), any: false, options };
  const allowed = new Set(
    origins.map((origin) => {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        throw new TypeError(`cors: ${JSON.stringify(origin)} isn't an origin (like "https://app.example")`);
      }
      if (parsed.origin === "null" || parsed.origin !== origin.replace(/\/$/, "")) {
        throw new TypeError(`cors: ${JSON.stringify(origin)} isn't an origin (like "https://app.example"): no path, query or trailing parts`);
      }
      return parsed.origin;
    }),
  );
  return { allows: (origin) => allowed.has(origin), any: false, options };
}

/** The headers for a response to an allowed origin (both preflights and the real request). */
export function corsHeaders(policy: CorsPolicy, origin: string): Record<string, string> {
  const headers: Record<string, string> = { "access-control-allow-origin": policy.any ? "*" : origin };
  if (policy.options.credentials) headers["access-control-allow-credentials"] = "true";
  if (policy.options.expose?.length) headers["access-control-expose-headers"] = policy.options.expose.join(", ");
  return headers;
}

/**
 * The answer to a preflight: 204, with the allow headers when the origin is
 * allowed, without them (so the browser refuses the real request) when it
 * isn't. `verbs` are the route's own, for the default `methods`.
 */
export function preflight(policy: CorsPolicy, request: IncomingHttpHeaders, verbs: readonly string[]): Outgoing {
  const origin = request.origin!;
  const headers: Record<string, string> = policy.any ? {} : { vary: "origin" };
  if (policy.allows(origin)) {
    Object.assign(headers, corsHeaders(policy, origin));
    headers["access-control-allow-methods"] = (policy.options.methods ?? verbs).join(", ");
    const asked = request["access-control-request-headers"];
    const allowedHeaders = policy.options.headers?.join(", ") ?? asked;
    if (allowedHeaders) headers["access-control-allow-headers"] = allowedHeaders;
    headers["access-control-max-age"] = String(policy.options.maxAge ?? 600);
    // The answer depends on what was asked for, when it echoes it.
    if (!policy.options.headers && asked) headers.vary = headers.vary ? `${headers.vary}, access-control-request-headers` : "access-control-request-headers";
  }
  return { status: 204, headers, body: null };
}
