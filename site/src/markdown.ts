/**
 * Markdown to HTML, by hand, for the guides (docs/*.md) and JSDoc text.
 *
 * Covers what the docs use: headings, paragraphs, fenced code, inline code,
 * bold, italics, links, lists (nested by indentation), tables, blockquotes,
 * horizontal rules. Every piece of text is escaped; the only markup in the
 * output is what this file writes, so a doc can't inject script.
 *
 * Links: `api:yerd.res` goes to an API page, `OTHER.md` and `docs/OTHER.md`
 * become routes to that guide,
 * `#section` a route to the heading, repository paths (`src/...`,
 * `examples/...`) links to GitHub, and anything else that isn't http(s) or
 * mailto is dropped to plain text.
 */

import { highlight } from "./highlight";

export interface Heading {
  level: number;
  id: string;
  text: string;
}

export interface Rendered {
  html: string;
  headings: Heading[];
}

export interface LinkContext {
  /** The guide being rendered, for in-page heading links. */
  slug?: string;
  /** docs/X.md -> guide slug */
  guideFor: (file: string) => string | undefined;
  repoUrl: string;
  /** `res`, `ActionForm.parse` -> an API page ("yerd.res", "yerd.ActionForm/parse"), for cross-references. */
  resolveApi?: (name: string) => string | undefined;
  /** The API page being rendered, so it doesn't link to itself. */
  self?: string;
}

/**
 * The API page a code span names, if any: `res()`, `@layout`, `new YerdApp()`,
 * `ActionForm.parse`, `Session.flash(key)`.
 */
function apiTarget(code: string, ctx: LinkContext): string | undefined {
  if (!ctx.resolveApi) return undefined;
  const name = code
    .trim()
    .replace(/^@|^new\s+/, "")
    .replace(/\(.*\)$/, "")
    .replace(/<.*>$/, "");
  if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)?$/.test(name)) return undefined;
  const id = ctx.resolveApi(name);
  return id && id !== ctx.self && !id.startsWith(`${ctx.self}/`) ? id : undefined;
}

function apiLink(id: string, inner: string): string {
  return `<a class="api-ref" href="#/api/${escapeHtml(id)}" data-api="${escapeHtml(id)}">${inner}</a>`;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function href(target: string, ctx: LinkContext): string | undefined {
  const url = target.trim();
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (url.startsWith("api:")) return `#/api/${url.slice(4).replace(".", "\u0001").replace(".", "/").replace("\u0001", ".")}`;
  if (url.startsWith("#")) return ctx.slug ? `#/guide/${ctx.slug}/${slugify(url.slice(1))}` : undefined;
  const [path, hash] = url.split("#");
  const file = path!.replace(/^\.\//, "");
  const guide = ctx.guideFor(file.includes("/") ? file : `docs/${file}`) ?? ctx.guideFor(file);
  if (guide) return `#/guide/${guide}${hash ? `/${slugify(hash)}` : ""}`;
  if (/^(src|examples|test|docs|bench|site|\.github)\//.test(file) || /^[\w.-]+\.(json|ts|md|yml)$/.test(file)) {
    return `${ctx.repoUrl}/blob/main/${file}${hash ? `#${hash}` : ""}`;
  }
  return undefined;
}

/**
 * Inline markup. Pieces that must not be reinterpreted are swapped for
 * markers (which escaping leaves alone) as they're rendered: code spans
 * first (their contents are literal), then images, then links (whose labels
 * may hold code or an image, as `[\`@route\`](api:...)` and README badges
 * do), then emphasis on what's left; markers are put back at the end.
 */
export function inline(text: string, ctx: LinkContext): string {
  const held: string[] = [];
  const hold = (html: string) => `\u0000${held.push(html) - 1}\u0000`;
  // Markers can nest (a link label holding code), so restore until none are left.
  const restore = (html: string) => {
    while (html.includes("\u0000")) html = html.replace(/\u0000(\d+)\u0000/g, (_, i: string) => held[Number(i)]!);
    return html;
  };
  // JSDoc cross-references: {@link name}, {@link name | text}, {@link name text}.
  text = text.replace(/\{@link(?:code|plain)?\s+([^}\s|]+)\s*(?:\|\s*|\s+)?([^}]*)\}/g, (_, target: string, label: string) => {
    const id = ctx.resolveApi?.(target.replace(/\(\)$/, ""));
    const shown = label.trim() ? escapeHtml(label.trim()) : `<code>${escapeHtml(target)}</code>`;
    if (id) return hold(apiLink(id, shown));
    const url = href(target, ctx);
    return url ? hold(`<a href="${escapeHtml(url)}">${shown}</a>`) : hold(shown);
  });
  text = text.replace(/(`+)([\s\S]*?)\1/g, (_, _ticks: string, code: string) => {
    const body = /^ .* $/.test(code) ? code.slice(1, -1) : code;
    const html = `<code>${escapeHtml(body)}</code>`;
    // A code span naming an export links to its page (a hover shows a summary).
    const id = apiTarget(body, ctx);
    return hold(id ? apiLink(id, html) : html);
  });
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt: string, src: string) =>
    hold(/^https:\/\//.test(src) ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">` : escapeHtml(alt)),
  );
  text = text.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (whole, label: string, target: string) => {
    const url = href(target, ctx);
    if (!url) return label;
    const web = /^https?:/.test(url);
    const external = web && !url.startsWith(ctx.repoUrl);
    // A link label that's already an API link (a code span) keeps just one link.
    const inner = restore(styled(label)).replace(/<a class="api-ref"[^>]*>|<\/a>/g, "");
    const api = url.startsWith("#/api/") ? ` class="api-ref" data-api="${escapeHtml(url.slice(6))}"` : "";
    return hold(`<a href="${escapeHtml(url)}"${web ? ' target="_blank" rel="noopener"' : ""}${external ? ' class="external"' : api}>${inner}</a>`);
  });
  return restore(styled(text));
}

function styled(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<em>$2</em>");
}

interface ListItem {
  indent: number;
  ordered: boolean;
  text: string;
}

function renderList(items: ListItem[], ctx: LinkContext): string {
  let html = "";
  let i = 0;
  const walk = (indent: number): string => {
    const ordered = items[i]!.ordered;
    let out = ordered ? "<ol>" : "<ul>";
    while (i < items.length && items[i]!.indent >= indent) {
      if (items[i]!.indent > indent) {
        out = out.replace(/<\/li>$/, "") + walk(items[i]!.indent) + "</li>";
        continue;
      }
      out += `<li>${inline(items[i]!.text, ctx)}</li>`;
      i++;
    }
    return out + (ordered ? "</ol>" : "</ul>");
  };
  while (i < items.length) html += walk(items[i]!.indent);
  return html;
}

function cells(row: string): string[] {
  return row.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

export function renderMarkdown(source: string, ctx: LinkContext): Rendered {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const headings: Heading[] = [];
  const used = new Map<string, number>();
  let html = "";
  let paragraph: string[] = [];
  let list: ListItem[] = [];

  const flushParagraph = () => {
    if (paragraph.length) html += `<p>${inline(paragraph.join(" "), ctx)}</p>`;
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) html += renderList(list, ctx);
    list = [];
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = /^(\s*)(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      const close = fence[2]!;
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith(close); i++) body.push(lines[i]!.slice(fence[1]!.length));
      html += `<div class="code-wrap"><button class="copy" type="button" aria-label="Copy code">copy</button><pre class="code" data-lang="${escapeHtml(fence[3] || "text")}"><code>${highlight(body.join("\n"), fence[3] || "text")}</code></pre></div>`;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      const text = heading[2]!;
      let id = slugify(text) || "section";
      const n = used.get(id) ?? 0;
      used.set(id, n + 1);
      if (n > 0) id = `${id}-${n}`;
      headings.push({ level, id, text: text.replace(/`/g, "") });
      const anchor = ctx.slug && level > 1 ? `<a class="anchor" href="#/guide/${ctx.slug}/${id}" aria-label="Link to this section">#</a>` : "";
      html += `<h${level} id="${id}">${inline(text, ctx)}${anchor}</h${level}>`;
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flush();
      html += "<hr>";
      continue;
    }

    // Tables: a header row, a |---| separator, then rows.
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1]!)) {
      flush();
      const head = cells(line);
      const align = cells(lines[i + 1]!).map((c) => (c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : ""));
      i += 2;
      let rows = "";
      for (; i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== ""; i++) {
        rows += `<tr>${cells(lines[i]!).map((c, j) => `<td${align[j] ? ` style="text-align:${align[j]}"` : ""}>${inline(c, ctx)}</td>`).join("")}</tr>`;
      }
      i--;
      html += `<div class="table"><table><thead><tr>${head.map((c, j) => `<th${align[j] ? ` style="text-align:${align[j]}"` : ""}>${inline(c, ctx)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      const body = [quote[1]!];
      for (; i + 1 < lines.length && /^\s*>/.test(lines[i + 1]!); i++) body.push(lines[i + 1]!.replace(/^\s*>\s?/, ""));
      // GitHub-style callouts: > [!NOTE], [!TIP], [!WARNING], [!IMPORTANT].
      const callout = /^\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\s*$/i.exec(body[0]!.trim());
      if (callout) {
        const kind = callout[1]!.toLowerCase();
        html += `<div class="callout ${kind}"><div class="callout-title">${kind}</div>${renderMarkdown(body.slice(1).join("\n"), ctx).html}</div>`;
      } else html += `<blockquote>${renderMarkdown(body.join("\n"), ctx).html}</blockquote>`;
      continue;
    }

    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      list.push({ indent: item[1]!.length, ordered: /\d/.test(item[2]!), text: item[3]! });
      continue;
    }
    // A list item's continuation line.
    if (list.length && /^\s{2,}\S/.test(line)) {
      list[list.length - 1]!.text += ` ${line.trim()}`;
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flush();
  return { html, headings };
}
