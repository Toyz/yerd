/**
 * `answer` blocks: what a request to the code above them gets back (see
 * docs/WRITING.md). One block holds one or more exchanges, split by a line
 * with `---`:
 *
 *     POST /cart              request line
 *     {"id":7}                request body (optional) ...
 *     >>>                     ... ended by >>>
 *     200 OK                  status line
 *     content-type: ...       the headers worth showing
 *                             a blank line
 *     {"items":1}             the body
 *
 * Rendered as escaped text plus this file's own markup. An HTML body is shown
 * as highlighted source; its preview is built on demand by prose.ts, inside a
 * sandboxed iframe, from the raw text kept in a data attribute.
 */

import { escape as escapeHtml, highlight } from "./highlight";

export interface Exchange {
  method: string;
  path: string;
  requestHeaders: string[];
  requestBody: string;
  status: number;
  reason: string;
  headers: Array<[string, string]>;
  body: string;
}

const HEADER = /^([A-Za-z][\w-]*):\s?(.*)$/;

export function parseAnswer(source: string): Exchange[] {
  const blocks: string[][] = [[]];
  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^---+\s*$/.test(line)) blocks.push([]);
    else blocks[blocks.length - 1]!.push(line);
  }
  return blocks.map(parseExchange).filter((e): e is Exchange => e !== undefined);
}

function parseExchange(lines: string[]): Exchange | undefined {
  while (lines.length && lines[0]!.trim() === "") lines.shift();
  if (!lines.length) return undefined;
  const [method = "", ...rest] = lines.shift()!.trim().split(/\s+/);
  const path = rest.filter((part) => !/^HTTP\/\d/.test(part)).join(" ");

  // A request with a body: everything up to the >>> line. Leading header lines
  // followed by a blank line are its headers.
  let requestHeaders: string[] = [];
  let requestBody = "";
  const split = lines.findIndex((l) => l.trim() === ">>>");
  if (split !== -1) {
    const request = lines.splice(0, split + 1).slice(0, -1);
    const blank = request.findIndex((l) => l.trim() === "");
    if (blank > 0 && request.slice(0, blank).every((l) => HEADER.test(l))) {
      requestHeaders = request.slice(0, blank);
      requestBody = request.slice(blank + 1).join("\n");
    } else requestBody = request.join("\n");
    requestBody = requestBody.replace(/^\n+|\s+$/g, "");
  }

  while (lines.length && lines[0]!.trim() === "") lines.shift();
  const statusLine = (lines.shift() ?? "").trim().replace(/^HTTP\/[\d.]+\s+/, "");
  const status = /^(\d{3})\s*(.*)$/.exec(statusLine);
  const headers: Array<[string, string]> = [];
  while (lines.length && lines[0]!.trim() !== "") {
    const header = HEADER.exec(lines.shift()!.trim());
    if (header) headers.push([header[1]!, header[2]!]);
  }
  return {
    method: method.toUpperCase(),
    path,
    requestHeaders,
    requestBody,
    status: status ? Number(status[1]) : 0,
    reason: status ? status[2]! : statusLine,
    headers,
    body: lines.join("\n").replace(/^\n+|\s+$/g, ""),
  };
}

type BodyKind = "json" | "html" | "text" | "empty";

function contentType(headers: Array<[string, string]>): string {
  return headers.find(([name]) => name.toLowerCase() === "content-type")?.[1].toLowerCase() ?? "";
}

function kindOf(body: string, type: string): BodyKind {
  if (!body) return "empty";
  if (type.includes("json")) return "json";
  if (type.includes("html")) return "html";
  if (type) return "text";
  if (/^[[{]/.test(body)) return "json";
  if (/^<[!A-Za-z]/.test(body)) return "html";
  return "text";
}

/** Pretty JSON when it parses (a body elided with `...` doesn't; it's shown as written). */
function prettyJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function highlightJson(text: string): string {
  // Keys in the type color, values keep theirs.
  return highlight(text, "json").replace(/<span class="tok-string">(&quot;(?:[^&<]|&(?!quot;))*&quot;)<\/span>(\s*):/g, '<span class="tok-type">$1</span>$2:');
}

function statusClass(status: number): string {
  return status >= 100 && status < 600 ? `s${Math.floor(status / 100)}xx` : "sunknown";
}

function requestBodyHtml(e: Exchange): string {
  if (!e.requestBody && !e.requestHeaders.length) return "";
  const type = contentType(e.requestHeaders.map((h) => HEADER.exec(h)!).map((m) => [m[1]!, m[2]!]));
  const kind = kindOf(e.requestBody, type);
  const body = kind === "json" ? highlightJson(prettyJson(e.requestBody)) : kind === "html" ? highlight(e.requestBody, "html") : escapeHtml(e.requestBody);
  const headers = e.requestHeaders.map((h) => {
    const [, name, value] = HEADER.exec(h)!;
    return `<div class="hdr"><span class="hdr-name">${escapeHtml(name!)}:</span> ${escapeHtml(value!)}</div>`;
  });
  return `<div class="ex-sent">${headers.join("")}${e.requestBody ? `<pre class="ex-sent-body"><code>${body}</code></pre>` : ""}</div>`;
}

let answerCount = 0;

/**
 * One answer card's markup. Several exchanges get a tab strip labelled by
 * request line; their panels then skip the request line unless they show a
 * request body under it.
 */
export function renderAnswer(source: string): string {
  const exchanges = parseAnswer(source);
  if (!exchanges.length) return "";
  const id = `ans${++answerCount}`;
  const many = exchanges.length > 1;
  let tabs = "";
  if (many) {
    tabs = `<div class="ex-tabs" role="tablist" aria-label="Requests">${exchanges
      .map(
        (e, i) =>
          `<button type="button" role="tab" id="${id}-t${i}" aria-controls="${id}-p${i}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">` +
          `<span class="ex-method">${escapeHtml(e.method)}</span> <span class="ex-path">${escapeHtml(e.path)}</span>` +
          `<span class="ex-code ${statusClass(e.status)}">${e.status || ""}</span></button>`,
      )
      .join("")}</div>`;
  }
  const panels = exchanges.map((e, i) => {
    const kind = kindOf(e.body, contentType(e.headers));
    const request = `<div class="ex-req"><span class="ex-method">${escapeHtml(e.method)}</span> <span class="ex-path">${escapeHtml(e.path)}</span></div>`;
    const status = `<div class="ex-status"><span class="ex-proto">HTTP/1.1</span> <span class="ex-code ${statusClass(e.status)}">${e.status || ""}</span> <span class="ex-reason">${escapeHtml(e.reason)}</span></div>`;
    const headers = e.headers.map(([name, value]) => `<div class="hdr"><span class="hdr-name">${escapeHtml(name)}:</span> ${escapeHtml(value)}</div>`).join("");
    let body = "";
    let tools = "";
    if (kind === "empty") body = `<div class="ex-empty">No body.</div>`;
    else {
      const code = kind === "json" ? highlightJson(prettyJson(e.body)) : kind === "html" ? highlight(e.body, "html") : escapeHtml(e.body);
      body = `<pre class="ex-body ${kind}"><code>${code}</code></pre>`;
      if (kind === "html") {
        body += `<div class="ex-preview" hidden data-html="${escapeHtml(e.body)}"></div>`;
        tools += `<div class="ex-view" role="group" aria-label="Show the body as"><button type="button" class="ex-view-btn" data-view="source" aria-pressed="true">Source</button><button type="button" class="ex-view-btn" data-view="preview" aria-pressed="false">Preview</button></div>`;
      }
      tools += `<button class="copy" type="button" aria-label="Copy the response body">Copy</button>`;
    }
    const attrs = many ? ` role="tabpanel" id="${id}-p${i}" aria-labelledby="${id}-t${i}"${i === 0 ? "" : " hidden"}` : "";
    return (
      `<div class="exchange"${attrs}>` +
      `<div class="ex-head${kind === "html" ? " with-view" : ""}"><div class="ex-lines">${many && !e.requestBody ? "" : request}${requestBodyHtml(e)}${status}${headers}</div>` +
      `<div class="ex-tools">${tools}</div></div>${body}</div>`
    );
  });
  return `<div class="answer" role="group" aria-label="Response">${tabs}${panels.join("")}</div>`;
}
