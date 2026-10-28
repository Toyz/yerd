/**
 * app.securityHeaders(): the response headers a browser app should send,
 * worked out once and set on every response (pages, errors, static files,
 * yerd's own endpoints). A header a handler sets itself wins, so one route
 * can loosen its own CSP without touching the rest.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { requestIsHttps } from "./http.js";

/** CSP directives yerd knows by name; any other is accepted as a string. */
export type CspDirective =
  | "default-src" | "script-src" | "script-src-elem" | "script-src-attr" | "style-src" | "style-src-elem" | "style-src-attr"
  | "img-src" | "font-src" | "connect-src" | "media-src" | "object-src" | "frame-src" | "child-src" | "worker-src"
  | "manifest-src" | "base-uri" | "form-action" | "frame-ancestors" | "upgrade-insecure-requests" | "report-uri" | "report-to"
  | "require-trusted-types-for" | "trusted-types" | "sandbox";

/**
 * CSP directives by name, merged over yerd's defaults: a list (or one
 * string) replaces that directive's sources, `true` writes a directive that
 * takes none (`upgrade-insecure-requests`), `false` drops one.
 *
 * ```ts
 * app.securityHeaders({ csp: { "img-src": ["'self'", "https://images.example"], "upgrade-insecure-requests": true } });
 * ```
 */
export type CspDirectives = Partial<Record<CspDirective | (string & {}), string | readonly string[] | boolean>>;

/** HSTS: how long browsers should insist on HTTPS. */
export interface HstsOptions {
  /** Seconds. Default 31536000 (a year). */
  maxAge?: number;
  /** Cover every subdomain too. Default false: turn it on once they all serve HTTPS. */
  includeSubDomains?: boolean;
  /** Ask to be on browsers' built-in HTTPS list (needs includeSubDomains and a long maxAge). Default false. */
  preload?: boolean;
}

/**
 * Options for app.securityHeaders(). Every header is on by default; `false`
 * leaves one out.
 *
 * ```ts
 * yerd().securityHeaders({
 *   csp: { "connect-src": ["'self'", "https://api.example"] },
 *   hsts: { includeSubDomains: true },
 *   frame: "deny",
 * });
 * ```
 */
export interface SecurityHeadersOptions {
  /**
   * Content-Security-Policy, as directives merged over the defaults:
   *
   * ```
   * default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
   * img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self';
   * object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'
   * ```
   *
   * yerd's runtime and islands load as same-origin scripts, so `script-src
   * 'self'` holds. Styles need `'unsafe-inline'`: css() writes `<style>`
   * elements into the page. <Local> handlers compile in the browser and need
   * `'unsafe-eval'` added to script-src. `false` sends no CSP.
   */
  csp?: CspDirectives | false;
  /** Send the CSP as Content-Security-Policy-Report-Only: violations are reported, nothing is blocked. Default false. */
  cspReportOnly?: boolean;
  /** Strict-Transport-Security, sent on HTTPS responses only (browsers ignore it over HTTP). */
  hsts?: HstsOptions | false;
  /**
   * Who may put pages in a frame: "sameorigin" (default) or "deny". Sets
   * X-Frame-Options and, unless the CSP names its own, frame-ancestors.
   */
  frame?: "sameorigin" | "deny" | false;
  /** Referrer-Policy. Default "strict-origin-when-cross-origin". */
  referrerPolicy?:
    | "no-referrer" | "no-referrer-when-downgrade" | "origin" | "origin-when-cross-origin"
    | "same-origin" | "strict-origin" | "strict-origin-when-cross-origin" | "unsafe-url" | false;
  /** Cross-Origin-Opener-Policy. Default "same-origin": a page opened from another site can't reach back through window.opener. */
  crossOriginOpenerPolicy?: "same-origin" | "same-origin-allow-popups" | "unsafe-none" | false;
}

const DEFAULT_CSP: CspDirectives = {
  "default-src": "'self'",
  "script-src": "'self'",
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "blob:"],
  "font-src": ["'self'", "data:"],
  "connect-src": "'self'",
  "object-src": "'none'",
  "base-uri": "'self'",
  "form-action": "'self'",
};

/** The headers, worked out from the options: what every response gets, and what only HTTPS ones do. */
export interface SecurityHeaders {
  always: [string, string][];
  https: [string, string][];
}

/** Turn options into header lines. Throws on a directive name or source that would break the header. */
export function compileSecurityHeaders(options: SecurityHeadersOptions = {}): SecurityHeaders {
  const always: [string, string][] = [];
  const https: [string, string][] = [];
  const frame = options.frame ?? "sameorigin";

  if (options.csp !== false) {
    const directives: CspDirectives = { ...DEFAULT_CSP, ...options.csp };
    if (frame && directives["frame-ancestors"] === undefined) directives["frame-ancestors"] = frame === "deny" ? "'none'" : "'self'";
    const parts: string[] = [];
    for (const [name, value] of Object.entries(directives)) {
      if (value === false || value === undefined) continue;
      if (!/^[a-z][a-z-]*$/.test(name)) throw new TypeError(`CSP directive ${JSON.stringify(name)} isn't a directive name`);
      if (value === true) {
        parts.push(name);
        continue;
      }
      const sources = typeof value === "string" ? [value] : value;
      for (const source of sources) {
        // A ; or , would end the directive (or the policy) early; control characters can't go in a header.
        if (source === "" || /[;,\s\x00-\x1f\x7f]/.test(source)) throw new TypeError(`CSP source ${JSON.stringify(source)} in ${name} isn't a single source`);
      }
      parts.push(sources.length ? `${name} ${sources.join(" ")}` : name);
    }
    always.push([options.cspReportOnly ? "content-security-policy-report-only" : "content-security-policy", parts.join("; ")]);
  }
  if (frame) always.push(["x-frame-options", frame === "deny" ? "DENY" : "SAMEORIGIN"]);
  const referrer = options.referrerPolicy ?? "strict-origin-when-cross-origin";
  if (referrer) always.push(["referrer-policy", referrer]);
  const coop = options.crossOriginOpenerPolicy ?? "same-origin";
  if (coop) always.push(["cross-origin-opener-policy", coop]);

  if (options.hsts !== false) {
    const { maxAge = 31_536_000, includeSubDomains = false, preload = false } = options.hsts ?? {};
    if (!Number.isInteger(maxAge) || maxAge < 0) throw new TypeError(`hsts.maxAge must be a whole number of seconds, not ${maxAge}`);
    https.push(["strict-transport-security", `max-age=${maxAge}${includeSubDomains ? "; includeSubDomains" : ""}${preload ? "; preload" : ""}`]);
  }
  return { always, https };
}

/**
 * Set the headers on `res` before anything answers. They're only defaults:
 * headers given to writeHead (a handler's, a static file's) replace them.
 */
export function applySecurityHeaders(headers: SecurityHeaders, req: IncomingMessage, res: ServerResponse, trustProxy: boolean): void {
  for (const [name, value] of headers.always) res.setHeader(name, value);
  if (headers.https.length && requestIsHttps(req, trustProxy)) for (const [name, value] of headers.https) res.setHeader(name, value);
}
