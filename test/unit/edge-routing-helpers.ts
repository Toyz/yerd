/**
 * Shared helpers for the edge-routing-* tests. Not a test file itself (the
 * name doesn't end in .test.ts), so vitest only loads it through imports.
 */

import { connect } from "node:net";
import { yerd, type RunningServer, type YerdApp } from "@toyz/yerd";

export interface RawResponse {
  status: number;
  /** Header names lowercased; repeated headers joined with ", ". */
  headers: Record<string, string>;
  /** Every header line as sent, for checking what's on the wire. */
  lines: string[];
  body: string;
}

/**
 * Send `request` as-is over a socket and read the whole response. fetch()
 * normalizes paths (dot segments, fragments) before sending, so anything about
 * the raw request target needs this instead.
 */
export function raw(base: string, request: string): Promise<RawResponse> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname);
    const chunks: Buffer[] = [];
    socket.on("data", (c) => chunks.push(c));
    socket.on("error", reject);
    socket.on("end", () => {
      const text = Buffer.concat(chunks).toString("latin1");
      const split = text.indexOf("\r\n\r\n");
      const head = split === -1 ? text : text.slice(0, split);
      let body = split === -1 ? "" : text.slice(split + 4);
      const [statusLine = "", ...lines] = head.split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const colon = line.indexOf(":");
        const name = line.slice(0, colon).toLowerCase();
        const value = line.slice(colon + 1).trim();
        headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
      }
      if (headers["transfer-encoding"] === "chunked") body = dechunk(body);
      resolve({ status: Number(statusLine.split(" ")[1]), headers, lines, body });
    });
    socket.write(request);
  });
}

function dechunk(body: string): string {
  let out = "";
  let rest = body;
  while (rest.length > 0) {
    const eol = rest.indexOf("\r\n");
    const size = parseInt(rest.slice(0, eol), 16);
    if (!size) break;
    out += rest.slice(eol + 2, eol + 2 + size);
    rest = rest.slice(eol + 2 + size + 2);
  }
  return out;
}

/** A GET with `target` as the literal request target. */
export function rawGet(base: string, target: string, extra = ""): Promise<RawResponse> {
  return raw(base, `GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n${extra}\r\n`);
}

/** Start an app on a free port with signals off and an isolated route list. */
export async function serve(routes: Function[], configure: (app: YerdApp) => YerdApp = (a) => a): Promise<RunningServer> {
  return configure(yerd({ routes, services: [], handleSignals: false, secret: "e".repeat(32) })).listen(0, "127.0.0.1");
}
