/**
 * Requests answered in this process, with no HTTP server: a fetch Request
 * goes through the app's whole pipeline (middleware, sessions, guards,
 * actions, error pages, streaming) and comes back as a fetch Response.
 *
 * The pipeline is written against node:http's request and response; this
 * gives it stand-ins with just what it uses. The Response resolves as soon as
 * the status and headers are written, so a long-lived stream (SSE, NDJSON)
 * can be read as it goes; cancelling its body is the client hanging up.
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

/** Statuses whose responses can't have a body (the Response constructor refuses one). */
const NULL_BODY = new Set([101, 204, 205, 304]);

/** Bytes buffered for the reader before write() asks the app to wait, like a socket's 16 KiB. */
const HIGH_WATER = 16 * 1024;

const encoder = new TextEncoder();

type HeaderValue = string | number | readonly string[];

/** The response side: collects status and headers, streams the body into a ReadableStream. */
class Collector extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  destroyed = false;
  writableFinished = false;
  readonly #headers = new Map<string, HeaderValue>();
  readonly #method: string;
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  /** write() returned false: the app waits for "drain" before writing more. */
  #full = false;
  readonly #body: ReadableStream<Uint8Array>;
  readonly #ready: Promise<Response>;
  #resolve!: (response: Response) => void;
  #reject!: (error: unknown) => void;

  constructor(method: string) {
    super();
    this.#method = method;
    this.#body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
      // The reader took some: room again for an app waiting to write.
      pull: () => {
        if (!this.#full) return;
        this.#full = false;
        this.emit("drain");
      },
      // The reader gave up: for the app, the client went away.
      cancel: () => this.#hangUp(),
    }, new ByteLengthQueuingStrategy({ highWaterMark: HIGH_WATER }));
    this.#ready = new Promise<Response>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  get response(): Promise<Response> {
    return this.#ready;
  }

  setHeader(name: string, value: HeaderValue): this {
    this.#headers.set(name.toLowerCase(), value);
    return this;
  }

  getHeader(name: string): HeaderValue | undefined {
    return this.#headers.get(name.toLowerCase());
  }

  removeHeader(name: string): void {
    this.#headers.delete(name.toLowerCase());
  }

  writeHead(status: number, headers?: Record<string, HeaderValue | undefined>): this {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers ?? {})) if (value !== undefined) this.setHeader(name, value);
    this.#commit();
    return this;
  }

  flushHeaders(): void {
    this.#commit();
  }

  /** Like a socket's write(): false once the reader is behind, then "drain" when it catches up. */
  write(chunk: string | Uint8Array): boolean {
    // After the reader cancelled there's no one to write to; the app finds out through "close".
    if (this.destroyed) return true;
    this.#commit();
    if (this.#bodiless()) return true;
    this.#controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : new Uint8Array(chunk));
    if ((this.#controller.desiredSize ?? 0) > 0) return true;
    this.#full = true;
    return false;
  }

  end(chunk?: string | Uint8Array): this {
    if (this.writableFinished || this.destroyed) return this;
    if (chunk !== undefined && chunk !== null) this.write(chunk);
    this.#commit();
    this.writableFinished = true;
    this.#controller.close();
    this.emit("finish");
    this.emit("close");
    return this;
  }

  destroy(error?: Error): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (!this.headersSent) this.#reject(error ?? new Error("The response was destroyed before it started"));
    else this.#controller.error(error ?? new Error("The response was cut off"));
    this.emit("close");
    return this;
  }

  #bodiless(): boolean {
    return this.#method === "HEAD" || NULL_BODY.has(this.statusCode);
  }

  #commit(): void {
    if (this.headersSent) return;
    this.headersSent = true;
    const headers = new Headers();
    for (const [name, value] of this.#headers) {
      if (Array.isArray(value)) for (const v of value) headers.append(name, String(v));
      else headers.set(name, String(value));
    }
    this.#resolve(new Response(this.#bodiless() ? null : this.#body, { status: this.statusCode, headers }));
  }

  #hangUp(): void {
    if (this.writableFinished || this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

/** The request side: a readable body plus the fields the pipeline reads. */
function incoming(request: Request, url: URL): IncomingMessage {
  const body = request.body ? Readable.fromWeb(request.body as import("node:stream/web").ReadableStream) : Readable.from([]);
  const headers: Record<string, string | string[]> = {};
  request.headers.forEach((value, name) => {
    if (name === "set-cookie") return;
    headers[name] = value;
  });
  headers.host ??= url.host;
  // How the pipeline knows there's a body: a Request has neither header, so
  // its body goes as a chunked one (streamed, not buffered).
  if (request.body && headers["content-length"] === undefined) headers["transfer-encoding"] ??= "chunked";
  return Object.assign(body, {
    method: request.method.toUpperCase(),
    url: url.pathname + url.search,
    headers,
    httpVersion: "1.1",
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    // https: URLs count as TLS, like an encrypted socket would.
    socket: { encrypted: url.protocol === "https:", remoteAddress: "127.0.0.1", remotePort: 0 },
  }) as unknown as IncomingMessage;
}

/** Run a Node-style handler for one fetch Request; resolves when the response starts. */
export function answer(handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const req = incoming(request, url);
  const res = new Collector(req.method!);
  handle(req, res as unknown as ServerResponse).then(
    () => {
      // A handler that returned without answering: an empty 404, like a server with no route.
      if (!res.headersSent) res.writeHead(404).end();
    },
    (error: unknown) => res.destroy(error instanceof Error ? error : new Error(String(error))),
  );
  return res.response;
}

/**
 * A browser-ish caller for tests: remembers cookies between requests (so
 * sessions and sign-in carry over) and sends an Origin on writes, like a
 * same-origin form post, so actions pass the cross-site check.
 */
export class TestClient {
  /** The cookies it holds, by name. */
  readonly cookies = new Map<string, string>();

  constructor(
    readonly fetch: (request: Request) => Promise<Response>,
    readonly base = "http://localhost",
  ) {}

  /** Like app.request(), with this client's cookies. */
  async request(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input, this.base);
    const headers = new Headers(init.headers);
    if (this.cookies.size && !headers.has("cookie")) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD" && !headers.has("origin")) headers.set("origin", url.origin);
    const response = await this.fetch(new Request(url, { ...init, headers }));
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";");
      const at = pair!.indexOf("=");
      const name = pair!.slice(0, at).trim();
      // Max-Age=0 (or a date in the past) is the server deleting it.
      const gone = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a)) || attributes.some((a) => /^\s*expires=/i.test(a) && Date.parse(a.split("=")[1]!) < Date.now());
      if (gone) this.cookies.delete(name);
      else this.cookies.set(name, pair!.slice(at + 1).trim());
    }
    return response;
  }

  /** GET a page and return its text. */
  async page(path: string, init?: RequestInit): Promise<string> {
    return (await this.request(path, init)).text();
  }

  /**
   * Submit the action form a page rendered: fetches `page`, takes the
   * `index`-th action token on it, and posts it to `to` (default: the page)
   * with `fields`, as the runtime would (`yx` header: JSON answers, no
   * redirects). `script: false` posts like a browser without JavaScript
   * (`Accept: text/html`: redirects, and error pages for failures).
   */
  async action(page: string, fields: Record<string, string> = {}, options: { index?: number; to?: string; script?: boolean } = {}): Promise<Response> {
    const html = await this.page(page);
    const tokens = [...html.matchAll(/name="_yx" value="([^"]+)"|data-yx-token="([^"]+)"/g)].map((m) => (m[1] ?? m[2])!.replace(/&amp;/g, "&").replace(/&quot;/g, '"'));
    const token = tokens[options.index ?? 0];
    if (!token) throw new Error(`No action on ${page} at index ${options.index ?? 0} (found ${tokens.length})`);
    const headers: Record<string, string> = options.script === false ? { accept: "text/html,application/xhtml+xml" } : { yx: "1" };
    return this.request(options.to ?? page, { method: "POST", body: new URLSearchParams({ _yx: token, ...fields }), headers });
  }
}
