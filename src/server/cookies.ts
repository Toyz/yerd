/** Cookie parsing and Set-Cookie serialization (RFC 6265), by hand. */

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(name in out)) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  return out;
}

/** Attributes for a Set-Cookie header (ctx.setCookie(), @setCookie, serializeCookie()). */
export interface CookieOptions {
  /** Lifetime in seconds (rounded down). Unset: a session cookie. */
  maxAge?: number;
  /** Absolute expiry. Max-Age wins in browsers when both are set. */
  expires?: Date;
  /** Default "/". */
  path?: string;
  /** Unset: host-only (this exact host, no subdomains). */
  domain?: string;
  /** Send only over HTTPS. Default false; browsers require it with sameSite "None". */
  secure?: boolean;
  /** Hide the cookie from client-side JavaScript. Default true. */
  httpOnly?: boolean;
  /** Default "Lax". */
  sameSite?: "Strict" | "Lax" | "None";
}

const NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Build a Set-Cookie header value. The value is percent-encoded; the
 * defaults are Path=/, HttpOnly and SameSite=Lax. Throws a TypeError for a
 * name that isn't an RFC 6265 token.
 *
 * ```ts
 * serializeCookie("theme", "dark", { maxAge: 31536000 });
 * // "theme=dark; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax"
 * ```
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!NAME.test(name)) throw new TypeError(`Invalid cookie name: ${JSON.stringify(name)}`);
  let cookie = `${name}=${encodeURIComponent(value)}`;
  if (options.maxAge !== undefined) cookie += `; Max-Age=${Math.floor(options.maxAge)}`;
  if (options.expires) cookie += `; Expires=${options.expires.toUTCString()}`;
  cookie += `; Path=${options.path ?? "/"}`;
  if (options.domain) cookie += `; Domain=${options.domain}`;
  if (options.httpOnly ?? true) cookie += "; HttpOnly";
  if (options.secure) cookie += "; Secure";
  cookie += `; SameSite=${options.sameSite ?? "Lax"}`;
  return cookie;
}
