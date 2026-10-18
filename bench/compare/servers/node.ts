// Baseline, not a framework: plain node:http with a hand-rolled router and template strings.
// The ceiling the frameworks are measured against.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BEARER, HOST, PORT, ROWS, checkEcho, userReply } from "./shared.js";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

function page(): string {
  let rows = "";
  for (const row of ROWS) {
    rows += `<li class="row" data-id="${row.id}"><span class="title">${escape(row.title)}</span><a href="/rows/${row.id}">open</a></li>`;
  }
  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bench page</title></head>` +
    `<body><header><nav><a href="/">Home</a><a href="/about">About</a><a href="/contact">Contact</a></nav></header>` +
    `<main><h1>Rows</h1><ul class="rows">${rows}</ul></main><footer>bench footer</footer></body></html>`
  );
}

function send(res: ServerResponse, status: number, type: string, body: string) {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, value: unknown) =>
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

createServer(async (req, res) => {
  const url = req.url ?? "/";
  const q = url.indexOf("?");
  const path = q === -1 ? url : url.slice(0, q);
  const query = new URLSearchParams(q === -1 ? "" : url.slice(q + 1));

  if (req.method === "GET" && path === "/json") return json(res, 200, { hello: "world" });
  if (req.method === "GET" && path.startsWith("/users/")) return json(res, 200, userReply(path.slice(7), query.get("fields")));
  if (req.method === "POST" && path === "/echo") {
    let input: unknown;
    try {
      input = await readJson(req);
    } catch {
      return json(res, 400, { error: "Invalid JSON" });
    }
    const issue = checkEcho(input);
    if (issue) return json(res, 400, { error: issue });
    const { name, age } = input as { name: string; age: number };
    return json(res, 200, { ok: true, name, age });
  }
  if (req.method === "GET" && path === "/secure") {
    if (req.headers.authorization !== BEARER) return json(res, 401, { error: "Unauthorized" });
    return json(res, 200, { ok: true, user: "bench" });
  }
  if (req.method === "GET" && path === "/page") return send(res, 200, "text/html; charset=utf-8", page());
  json(res, 404, { error: "Not found" });
}).listen(PORT, HOST, () => console.log("ready"));
