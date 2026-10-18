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

export interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

const NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

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
