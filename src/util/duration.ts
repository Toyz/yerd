/**
 * Durations as people write them ("500ms", "5s", "1m"), shared by everything
 * that takes a time: @every, @on backoff, call and waitFor timeouts, cues.
 */

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Parse "500ms", "5s", "1m", "2h", "1d" (decimals allowed), or a number of ms,
 * into milliseconds. The format @every, `backoff`, call timeouts and cue
 * timings take; throws a TypeError on anything else.
 *
 * ```ts
 * parseDuration("1.5s"); // 1500
 * parseDuration(250); // 250
 * setTimeout(poll, parseDuration(process.env.POLL_EVERY ?? "30s"));
 * ```
 */
export function parseDuration(value: string | number): number {
  if (typeof value === "number") return value;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) throw new TypeError(`Invalid duration: ${JSON.stringify(value)} (use e.g. "500ms", "5s", "1m")`);
  return Number(match[1]) * UNITS[match[2]!]!;
}
