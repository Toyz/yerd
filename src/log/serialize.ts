/**
 * Turn arbitrary values into something safe to log: never throws, bounded in
 * size, and with secrets taken out. Used for every field before it reaches a
 * sink, so a sink can JSON.stringify a record without surprises.
 *
 * Limits: depth 4, strings 256 chars, arrays 20 items, objects 30 keys.
 * Circular references become "[Circular]", binary data its length, class
 * instances `Name{...}`, errors `{ name, message }`.
 */

// Redacted when any word of the key (split on camelCase, _, - and spaces) is
// one of these: `password`, `csrfToken`, `x-api-key`, `sessionId`, but not
// `passengers` or `tokenizer`.
const SECRET_WORDS = new Set([
  "pass", "password", "passwd", "passphrase", "pwd", "secret", "secrets", "token", "tokens", "authorization", "auth",
  "cookie", "cookies", "session", "sessions", "apikey", "apikeys", "credential", "credentials", "privatekey", "privatekeys",
  "signature", "otp",
]);

/**
 * Answers by key: the same few keys (`method`, `path`, `status`...) come up
 * in every record, and splitting one into words costs a few regex passes.
 * Bounded like the filter's target cache; past it, keys are just worked out.
 */
const secretKeys = new Map<string, boolean>();
const SECRET_CACHE_MAX = 1024;

function isSecret(key: string): boolean {
  let secret = secretKeys.get(key);
  if (secret === undefined) {
    secret = isSecretKey(key);
    if (secretKeys.size < SECRET_CACHE_MAX) secretKeys.set(key, secret);
  }
  return secret;
}

function isSecretKey(key: string): boolean {
  // A trailing number doesn't change the word: `password2`, `token0`.
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_\-.]+/)
    .map((word) => word.replace(/(?<=[a-z])\d+$/, ""));
  for (let i = 0; i < words.length; i++) {
    if (SECRET_WORDS.has(words[i]!)) return true;
    // "api key", "private keys" split across two words
    if ((words[i] === "api" || words[i] === "private") && (words[i + 1] === "key" || words[i + 1] === "keys")) return true;
  }
  return false;
}

const MAX_DEPTH = 4;
const MAX_STRING = 256;
const MAX_ITEMS = 20;
const MAX_KEYS = 30;

export function safeFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!fields) return out;
  const seen = new Set<object>();
  for (const key of Object.keys(fields)) out[key] = isSecret(key) ? "[redacted]" : safeValue(fields[key], 1, seen);
  return out;
}

export function safeValue(value: unknown, depth = 1, seen = new Set<object>()): unknown {
  switch (typeof value) {
    case "string":
      return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}... (${value.length} chars)` : value;
    case "number":
    case "boolean":
    case "undefined":
      return value;
    case "bigint":
      return `${value}n`;
    case "symbol":
      return value.toString();
    case "function":
      return `[Function ${value.name || "anonymous"}]`;
  }
  if (value === null) return null;
  try {
    return objectValue(value as object, depth, seen);
  } catch {
    // A revoked Proxy, a throwing trap or constructor getter: describe it rather than break the log call.
    return "[unserializable]";
  }
}

function objectValue(object: object, depth: number, seen: Set<object>): unknown {
  if (seen.has(object)) return "[Circular]";
  if (object instanceof Error) return { name: object.name, message: object.message };
  if (object instanceof Date) return Number.isNaN(object.getTime()) ? "Invalid Date" : object.toISOString();
  if (object instanceof URL) return object.href;
  if (ArrayBuffer.isView(object)) return `[${object.constructor.name} ${object.byteLength} bytes]`;
  if (object instanceof ArrayBuffer) return `[ArrayBuffer ${object.byteLength} bytes]`;
  if (depth > MAX_DEPTH) return Array.isArray(object) ? `[Array(${object.length})]` : "[Object]";
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const items = object.slice(0, MAX_ITEMS).map((v) => safeValue(v, depth + 1, seen));
      if (object.length > MAX_ITEMS) items.push(`... ${object.length - MAX_ITEMS} more`);
      return items;
    }
    if (object instanceof Map) return safeValue(Object.fromEntries([...object].slice(0, MAX_KEYS)), depth, seen);
    if (object instanceof Set) return safeValue([...object], depth, seen);
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const key of Object.keys(object)) {
      if (count++ === MAX_KEYS) {
        out["..."] = `${Object.keys(object).length - MAX_KEYS} more keys`;
        break;
      }
      let v: unknown;
      try {
        v = (object as Record<string, unknown>)[key];
      } catch {
        v = "[getter threw]";
      }
      out[key] = isSecret(key) ? "[redacted]" : safeValue(v, depth + 1, seen);
    }
    const name = object.constructor?.name;
    return name && name !== "Object" ? { [`${name}`]: out } : out;
  } finally {
    seen.delete(object);
  }
}

/** An error, for a record's `error` field. */
export function errorInfo(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return { name: "Error", message: String(safeValue(error)) };
}
