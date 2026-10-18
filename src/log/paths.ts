/**
 * Field paths with wildcards, for @instrument's `skip` and logging's
 * `redact`: dot-separated keys (array indexes are keys too), where `*` is
 * any one key and `**` any number of them, none included.
 *
 *   "card.number"     that field
 *   "card.*"          every field of card
 *   "*.password"      password, one level down from anything
 *   "**.cvc"          cvc, at any depth
 *   "items.*.secret"  secret in every item
 */

/** A path as segments; checked once, so a typo fails where it's written. */
export function compilePath(path: string): string[] {
  const segments = path.split(".");
  if (segments.some((s) => s === "")) throw new TypeError(`Invalid field path "${path}": empty segment`);
  if (segments.some((s) => s.includes("*") && s !== "*" && s !== "**")) {
    throw new TypeError(`Invalid field path "${path}": a wildcard is a whole segment ("*" or "**"), not part of one`);
  }
  return segments;
}

/** The patterns that still apply under `key`, and whether one of them ends exactly there. */
function step(patterns: readonly string[][], key: string): { rest: string[][]; hit: boolean } {
  const rest: string[][] = [];
  let hit = false;
  const visit = (p: readonly string[]) => {
    const [head, ...tail] = p;
    if (head === undefined) return;
    if (head === "**") {
      // ** matches nothing (try the rest here) or this key (and stays for deeper keys).
      visit(tail);
      rest.push(p as string[]);
      return;
    }
    if (head !== "*" && head !== key) return;
    if (tail.length === 0) hit = true;
    else rest.push(tail);
  };
  for (const p of patterns) visit(p);
  return { rest, hit };
}

/**
 * A copy of `value` with what `patterns` match removed (`remove`) or masked
 * (`replace`). The original is never touched; values the patterns don't reach
 * are shared, not copied.
 */
function isBuiltIn(value: object): boolean {
  return (
    value instanceof Date || value instanceof Map || value instanceof Set || value instanceof Error || value instanceof URL ||
    value instanceof RegExp || value instanceof Promise || value instanceof ArrayBuffer || ArrayBuffer.isView(value)
  );
}

export function prunePaths(value: unknown, patterns: readonly string[][], replace?: string, depth = 0): unknown {
  if (patterns.length === 0 || typeof value !== "object" || value === null || depth > 32) return value;
  // Built-ins the serializer formats itself (a Date as a string, a Map as an object...) are left to it.
  if (isBuiltIn(value)) return value;
  const isArray = Array.isArray(value);
  const proto = Object.getPrototypeOf(value) as object | null;
  // A class instance (a parsed DTO, say) is pruned like an object, into a copy
  // with the same prototype, so the log still names its class.
  const out: Record<string, unknown> | unknown[] = isArray
    ? [...(value as unknown[])]
    : proto === Object.prototype || proto === null
      ? { ...(value as Record<string, unknown>) }
      : Object.assign(Object.create(proto) as Record<string, unknown>, value);
  for (const key of Object.keys(out)) {
    const { rest, hit } = step(patterns, key);
    const target = out as Record<string, unknown>;
    if (hit) {
      if (replace !== undefined) target[key] = replace;
      else if (isArray) target[key] = "[skipped]";
      else delete target[key];
    } else if (rest.length) target[key] = prunePaths(target[key], rest, replace, depth + 1);
  }
  return out;
}
