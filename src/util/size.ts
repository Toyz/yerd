const UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

/**
 * A size in bytes: a number as it is, or a string like "512kb", "10mb",
 * "1.5gb" (1024-based, case-insensitive). Throws on anything else.
 *
 * ```ts
 * parseSize("10mb"); // 10485760
 * ```
 */
export function parseSize(value: number | string): number {
  const bytes = typeof value === "number" ? value : sizeOf(value);
  if (!Number.isFinite(bytes) || bytes < 0) throw new TypeError(`Invalid size: ${JSON.stringify(value)} (use bytes, or e.g. "512kb", "10mb")`);
  return Math.floor(bytes);
}

function sizeOf(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(value.trim());
  return match ? Number(match[1]) * UNITS[match[2]!.toLowerCase()]! : Number.NaN;
}
