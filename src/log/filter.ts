/**
 * `YERD_LOG` directives, like Rust's `RUST_LOG`:
 *
 * ```
 * info                       everything at info and above
 * warn,UserRepo=debug        quiet, except one class
 * info,yerd::router=debug    yerd's own targets start with yerd::
 * info,[charge]=trace        a span named charge, and everything inside it
 * ```
 *
 * A target directive matches the target or anything under it (`yerd` covers
 * `yerd::request`); the longest match wins. Span directives win over target
 * ones for anything inside a matching span.
 */

import { LEVELS, type Level } from "./ilogger.js";

type Threshold = number;

/**
 * A parsed set of YERD_LOG directives that decides which records are written.
 * The app builds one from YERD_LOG / `app.logging({ filter })`; build your own
 * when a sink should be choosier than the app, like one that only forwards
 * alerts.
 *
 * ```ts
 * class AlertSink implements ILogger {
 *   readonly #filter = new LogFilter("error,Billing=warn,[checkout]=warn");
 *   readonly #pending: LogRecord[] = [];
 *
 *   write(record: LogRecord) {
 *     const spans = record.spans.map((s) => s.name);
 *     if (this.#filter.enabled(record.level, record.target, spans)) this.#pending.push(record);
 *   }
 * }
 * ```
 */
export class LogFilter {
  readonly #base: Threshold;
  readonly #targets: Array<[prefix: string, threshold: Threshold]>;
  readonly #spans: Map<string, Threshold>;
  /** target -> threshold, so the per-call decision is one Map lookup. */
  readonly #cache = new Map<string, Threshold>();

  /**
   * Parse `source` (the directive string). Throws on an unknown level; with no bare level, the base is info.
   *
   * ```ts
   * new LogFilter("warn,Billing=debug");
   * new LogFilter("info,Billing=chatty"); // throws: Unknown log level "chatty" in YERD_LOG
   * ```
   */
  constructor(readonly source: string) {
    let base: Threshold = LEVELS.info;
    // Maps, so a later directive for the same name replaces an earlier one
    // (`$DEFAULTS,UserRepo=trace`), as a later bare level does.
    const targets = new Map<string, Threshold>();
    const spans = new Map<string, Threshold>();
    for (const raw of source.split(",")) {
      const part = raw.trim();
      if (!part) continue;
      const eq = part.lastIndexOf("=");
      if (eq === -1) {
        base = threshold(part);
        continue;
      }
      const name = part.slice(0, eq).trim();
      const level = threshold(part.slice(eq + 1));
      if (name.startsWith("[") && name.endsWith("]")) spans.set(name.slice(1, -1), level);
      else targets.set(name, level);
    }
    this.#base = base;
    // Longest prefix first, so the most specific directive wins.
    this.#targets = [...targets].sort((a, b) => b[0].length - a[0].length);
    this.#spans = spans;
  }

  /** The lowest level written for `target`, ignoring span directives. */
  #thresholdFor(target: string): Threshold {
    let found = this.#cache.get(target);
    if (found === undefined) {
      found = this.#base;
      for (const [prefix, level] of this.#targets) {
        if (target === prefix || target.startsWith(`${prefix}::`)) {
          found = level;
          break;
        }
      }
      if (this.#cache.size < 1024) this.#cache.set(target, found);
    }
    return found;
  }

  /**
   * Whether a record at `level` for `target`, inside spans named `spans`, is written.
   *
   * ```ts
   * const filter = new LogFilter("warn,Billing=debug,[stripe]=trace");
   * filter.enabled("debug", "Billing"); // true
   * filter.enabled("info", "Orders"); // false
   * filter.enabled("trace", "Orders", ["request", "stripe"]); // true: inside a stripe span
   * ```
   */
  enabled(level: Level, target: string, spans?: Iterable<string>): boolean {
    const value = LEVELS[level];
    // Inside a span with a directive, the innermost such span decides, louder
    // or quieter than the target's level (`debug,[noisy]=warn` quiets noisy).
    if (this.#spans.size > 0 && spans) {
      let decided: Threshold | undefined;
      for (const name of spans) {
        const spanLevel = this.#spans.get(name);
        if (spanLevel !== undefined) decided = spanLevel;
      }
      if (decided !== undefined) return value >= decided;
    }
    return value >= this.#thresholdFor(target);
  }

  /**
   * True when span directives exist (callers then need to pass span names).
   * Lets a caller skip collecting span names when they can't matter.
   *
   * ```ts
   * const spans = filter.hasSpanDirectives ? record.spans.map((s) => s.name) : undefined;
   * ```
   */
  get hasSpanDirectives(): boolean {
    return this.#spans.size > 0;
  }
}

function threshold(text: string): Threshold {
  const level = text.trim().toLowerCase();
  if (Object.hasOwn(LEVELS, level)) return LEVELS[level as Level | "off"];
  throw new Error(`Unknown log level "${text}" in YERD_LOG (use trace, debug, info, warn, error or off)`);
}

/** YERD_LOG, else warn under tests and info otherwise. */
export function defaultFilter(): string {
  return process.env.YERD_LOG ?? (process.env.NODE_ENV === "test" ? "warn" : "info");
}
