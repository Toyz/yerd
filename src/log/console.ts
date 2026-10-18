/**
 * The built-in sink. Pretty (aligned, colored, indented by span depth) on a
 * terminal outside production; one JSON object per line otherwise.
 * `YERD_LOG_FORMAT=pretty|json` overrides. Info and below go to stdout in
 * batches; warnings and errors go to stderr straight away.
 */

import type { ILogger, Level, LogRecord } from "./ilogger.js";

export interface ConsoleLoggerOptions {
  format?: "pretty" | "json";
  /** ANSI colors in pretty mode. Default: stdout is a terminal and NO_COLOR isn't set. */
  color?: boolean;
}

const COLORS: Record<Level, string> = { trace: "\x1b[90m", debug: "\x1b[36m", info: "\x1b[32m", warn: "\x1b[33m", error: "\x1b[31m" };
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export class ConsoleLogger implements ILogger {
  readonly format: "pretty" | "json";
  readonly #color: boolean;
  #batch: string[] = [];
  #scheduled = false;

  constructor(options: ConsoleLoggerOptions = {}) {
    const fromEnv = process.env.YERD_LOG_FORMAT;
    this.format =
      options.format ??
      (fromEnv === "pretty" || fromEnv === "json" ? fromEnv : process.stdout.isTTY && process.env.NODE_ENV !== "production" ? "pretty" : "json");
    this.#color = options.color ?? (this.format === "pretty" && !!process.stdout.isTTY && !process.env.NO_COLOR);
  }

  write(record: LogRecord): void {
    const line = this.format === "json" ? jsonLine(record) : this.#prettyLine(record);
    if (record.level === "warn" || record.level === "error") {
      this.flush();
      process.stderr.write(line + "\n");
      return;
    }
    this.#batch.push(line);
    if (this.#batch.length >= 256) this.flush();
    else if (!this.#scheduled) {
      this.#scheduled = true;
      setImmediate(() => this.flush());
    }
  }

  flush(): void {
    this.#scheduled = false;
    if (this.#batch.length === 0) return;
    const text = this.#batch.join("\n") + "\n";
    this.#batch = [];
    process.stdout.write(text);
  }

  #prettyLine(r: LogRecord): string {
    const time = new Date(r.time);
    const clock = `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}.${String(time.getMilliseconds()).padStart(3, "0")}`;
    const level = r.level.toUpperCase().padStart(5);
    // Events sit inside their spans; a span's own lines sit at its parent's depth.
    const depth = r.kind === "event" ? r.spans.length : Math.max(r.spans.length - 1, 0);
    const span = r.spans[r.spans.length - 1];
    let body: string;
    if (r.kind === "span-enter") body = `${r.message}${braces(span?.fields)}`;
    else if (r.kind === "span-exit") {
      // A root span (the request) shows its fields on exit: it has no enter line.
      const own = r.spans.length === 1 ? braces(span?.fields) : "";
      body = `${r.message}${own}${pairs(r.fields)}${r.durationMs !== undefined ? ` ${r.durationMs}ms` : ""}`;
    } else body = `${r.message}${pairs(r.fields)}`;
    if (r.target && !r.target.startsWith("yerd::request") && r.kind === "event") body = `${body} ${this.#dim(`(${r.target})`)}`;
    let line = `${this.#dim(clock)} ${this.#paint(r.level, level)} ${"  ".repeat(depth)}${body}`;
    if (r.error) line += `\n${indent(r.error.stack ?? `${r.error.name}: ${r.error.message}`, depth + 1)}`;
    return line;
  }

  #paint(level: Level, text: string): string {
    return this.#color ? `${COLORS[level]}${text}${RESET}` : text;
  }

  #dim(text: string): string {
    return this.#color ? `${DIM}${text}${RESET}` : text;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function pairs(fields: Record<string, unknown> | undefined): string {
  if (!fields) return "";
  let out = "";
  for (const key of Object.keys(fields)) out += ` ${key}=${show(fields[key])}`;
  return out;
}

function braces(fields: Record<string, unknown> | undefined): string {
  if (!fields || Object.keys(fields).length === 0) return "";
  return `{${pairs(fields).slice(1)}}`;
}

function show(value: unknown): string {
  if (typeof value === "string") return /^[^\s"=]+$/.test(value) ? value : JSON.stringify(value);
  return value === undefined ? "undefined" : JSON.stringify(value);
}

function indent(text: string, depth: number): string {
  const pad = "  ".repeat(depth + 7);
  return text.split("\n").map((l) => pad + l).join("\n");
}

function jsonLine(r: LogRecord): string {
  const out: Record<string, unknown> = { t: new Date(r.time).toISOString(), level: r.level, target: r.target, msg: r.message };
  if (r.kind !== "event") out.kind = r.kind;
  if (Object.keys(r.fields).length > 0) out.fields = r.fields;
  if (r.spans.length > 0) out.spans = r.spans;
  if (r.durationMs !== undefined) out.ms = r.durationMs;
  if (r.error) out.error = r.error;
  if (r.traceId) out.trace = r.traceId;
  return JSON.stringify(out);
}
