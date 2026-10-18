import type { IncomingMessage } from "node:http";
import { HttpError } from "../respond/response.js";

/**
 * Text fields from a form body, by name. A name sent more than once becomes
 * an array, in order, so check for both:
 *
 * ```ts
 * function tagsOf(fields: FormFields): string[] {
 *   const tags = fields.tag ?? []; // several <input name="tag">: an array once two are sent
 *   return Array.isArray(tags) ? tags : [tags];
 * }
 * ```
 */
export type FormFields = Record<string, string | string[]>;
/**
 * Uploaded files from a multipart form, by field name (a field can carry
 * several). In a route, @file / @files (or `is.file()` in a DTO) are the
 * validated way to read them; this is the raw shape on `ctx.body()`.
 *
 * ```ts
 * @post async upload() {
 *   const parsed = await currentContext().body();
 *   if (parsed.kind !== "form") return 415;
 *   const files: FormFiles = parsed.files;
 *   const photos = files.photo ?? []; // <input type="file" name="photo" multiple>
 *   return { uploaded: photos.map((f) => ({ name: f.name, bytes: f.size })) };
 * }
 * ```
 */
export type FormFiles = Record<string, File[]>;

/**
 * A request body, parsed by its Content-Type: JSON (`application/json`,
 * `+json`), NDJSON, url-encoded or multipart forms, `text/*`, else raw bytes.
 * `none` when the request has no body. Malformed JSON is a 400. Switch on
 * `kind` to narrow `value`:
 *
 * ```ts
 * @post async receive() {
 *   const parsed: ParsedBody = await currentContext().body();
 *   switch (parsed.kind) {
 *     case "json": return { got: "json", value: parsed.value };
 *     case "form": return { got: "form", fields: Object.keys(parsed.value) };
 *     case "none": return 400;
 *     default: return 415;
 *   }
 * }
 * ```
 */
export type ParsedBody =
  | { kind: "none"; value: undefined }
  | { kind: "json"; value: unknown }
  | { kind: "form"; value: FormFields; files: FormFiles }
  | { kind: "text"; value: string }
  | { kind: "ndjson"; value: unknown[] }
  | { kind: "bytes"; value: Uint8Array };

export const DEFAULT_BODY_LIMIT = 1024 * 1024;

const NDJSON_TYPES = new Set(["application/x-ndjson", "application/jsonl", "application/jsonlines", "application/ndjson"]);

function parseLine(line: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new HttpError(400, `Line ${lineNumber} is not valid JSON`);
  }
}

/**
 * Stream a newline-delimited JSON request body, one parsed value per line,
 * as it arrives. Blank lines are skipped. No whole-body limit; each line is
 * capped at `maxLine` bytes (413 beyond that), and a line that isn't JSON is
 * a 400 naming it (both thrown as HttpError). Inside a yerd route use
 * ctx.lines() or `@args(ndjsonBody(Dto))`; this is for a plain node:http
 * handler.
 *
 * ```ts
 * createServer(async (req, res) => {
 *   let count = 0;
 *   for await (const row of readNdjson(req)) {
 *     await db.rows.insert(row);
 *     count++;
 *   }
 *   res.end(`imported ${count}`);
 * }).listen(3001);
 * ```
 */
export async function* readNdjson(req: IncomingMessage, maxLine = DEFAULT_BODY_LIMIT): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let carry = "";
  let lineNumber = 0;
  for await (const chunk of req) {
    carry += decoder.decode(chunk as Buffer, { stream: true });
    let newline: number;
    while ((newline = carry.indexOf("\n")) !== -1) {
      const line = carry.slice(0, newline);
      carry = carry.slice(newline + 1);
      lineNumber++;
      if (line.length * 3 > maxLine && Buffer.byteLength(line) > maxLine) {
        throw new HttpError(413, `Line ${lineNumber} is longer than ${maxLine} bytes`);
      }
      if (line.trim() !== "") yield parseLine(line, lineNumber);
    }
    if (Buffer.byteLength(carry) > maxLine) throw new HttpError(413, `Line ${lineNumber + 1} is longer than ${maxLine} bytes`);
  }
  carry += decoder.decode();
  if (carry.trim() !== "") yield parseLine(carry, lineNumber + 1);
}

function mediaType(req: IncomingMessage): string {
  return (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
}

function hasBody(req: IncomingMessage): boolean {
  const length = req.headers["content-length"];
  if (length !== undefined) return Number(length) > 0;
  return req.headers["transfer-encoding"] !== undefined;
}

async function readAll(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, `Request body is larger than ${limit} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.byteLength;
      if (size > limit) throw new HttpError(413, `Request body is larger than ${limit} bytes`);
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // The client hung up mid-upload: theirs to retry, not a crash to log as one.
    throw new HttpError(400, "The request body was cut off", { cause: error });
  }
  return Buffer.concat(chunks, size);
}

/**
 * Multipart bodies, parsed by the platform's own FormData (the fetch
 * implementation built into Node), so there's no hand-rolled boundary parser.
 * The body limit has already been applied; raise `bodyLimit` for uploads.
 */
async function parseMultipart(raw: Buffer, contentType: string): Promise<ParsedBody> {
  let data: FormData;
  try {
    data = await new Response(new Blob([new Uint8Array(raw)]), { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new HttpError(400, "Request body is not valid multipart/form-data");
  }
  const fields: FormFields = Object.create(null);
  const files: FormFiles = Object.create(null);
  for (const [key, value] of data) {
    if (typeof value === "string") {
      const existing = fields[key];
      if (existing === undefined) fields[key] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else fields[key] = [existing, value];
    } else {
      (files[key] ??= []).push(value);
    }
  }
  return { kind: "form", value: fields, files };
}

/**
 * A form's fields and its uploads in one object, for DTO parsing: a field
 * with one file holds the File, with several an array. Empty file inputs
 * (no name, no bytes) count as not sent.
 */
export function withFiles(fields: FormFields, files: FormFiles): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(fields)) out[key] = fields[key];
  for (const key of Object.keys(files)) {
    const sent = files[key]!.filter((f) => f.size > 0 || f.name !== "");
    if (sent.length > 0) out[key] = sent.length === 1 ? sent[0] : sent;
  }
  return out;
}

export function formFields(params: URLSearchParams): FormFields {
  const fields: FormFields = Object.create(null);
  for (const [key, value] of params) {
    const existing = fields[key];
    if (existing === undefined) fields[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else fields[key] = [existing, value];
  }
  return fields;
}

/**
 * Read and parse a request body by content type: JSON, NDJSON, URL-encoded or
 * multipart form, any text/* as a string, anything else as bytes. Bodies over
 * `limit` bytes (default 1 MiB) are a 413; malformed JSON is a 400 (both
 * thrown as HttpError). Inside a yerd route use ctx.body() or @body; this is
 * for a plain node:http handler.
 *
 * ```ts
 * createServer(async (req, res) => {
 *   const body = await readBody(req, 64 * 1024);
 *   res.end(body.kind === "json" ? "thanks" : "send JSON");
 * }).listen(3001);
 * ```
 */
export async function readBody(req: IncomingMessage, limit = DEFAULT_BODY_LIMIT): Promise<ParsedBody> {
  if (!hasBody(req)) return { kind: "none", value: undefined };
  const raw = await readAll(req, limit);
  // A chunked request that sends no bytes is no body, like Content-Length: 0.
  if (raw.byteLength === 0) return { kind: "none", value: undefined };
  const type = mediaType(req);

  if (type === "application/json" || type.endsWith("+json")) {
    try {
      // RFC 8259 lets a parser ignore a leading byte order mark; some clients send one.
      return { kind: "json", value: JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, "")) };
    } catch {
      throw new HttpError(400, "Request body is not valid JSON");
    }
  }
  if (NDJSON_TYPES.has(type)) {
    const values: unknown[] = [];
    raw.toString("utf8").split("\n").forEach((line, i) => {
      if (line.trim() === "") return;
      values.push(parseLine(line, i + 1));
    });
    return { kind: "ndjson", value: values };
  }
  if (type === "application/x-www-form-urlencoded") {
    return { kind: "form", value: formFields(new URLSearchParams(raw.toString("utf8"))), files: Object.create(null) as FormFiles };
  }
  if (type === "multipart/form-data") return parseMultipart(raw, req.headers["content-type"]!);
  if (type.startsWith("text/")) return { kind: "text", value: raw.toString("utf8") };
  return { kind: "bytes", value: new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) };
}
