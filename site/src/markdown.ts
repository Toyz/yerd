/**
 * Markdown to HTML, by hand, for the guides (docs/*.md) and JSDoc text.
 *
 * Covers what the docs use: headings, paragraphs, fenced code, inline code,
 * bold, italics, links, lists (nested by indentation), tables, blockquotes,
 * horizontal rules. Every piece of text is escaped; the only markup in the
 * output is what this file writes, so a doc can't inject script.
 *
 * And the guide extensions docs/WRITING.md describes: `answer` blocks
 * (answer.ts) drawn as one card with the code above them, `> [!TAKE]`
 * callouts, diagram blocks by name (diagrams.tsx), and runs of code blocks
 * labelled tab="..." grouped behind one tab strip. prose.ts makes the cards
 * interactive.
 *
 * Links: `api:yerd.res` goes to an API page, `OTHER.md` and `docs/OTHER.md`
 * become routes to that guide,
 * `#section` a route to the heading, repository paths (`src/...`,
 * `examples/...`) links to GitHub, and anything else that isn't http(s) or
 * mailto is dropped to plain text.
 */

import { renderAnswer } from "./answer";
import { hasDiagram } from "./diagrams";
import { highlight, type CodeLinker } from "./highlight";
import { chosenTab } from "./prose";

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

/**
 * Links inside a code block: decorators (`@route`, `@is.string`) always, and
 * other identifiers only when the block imports them from yerd, so a local
 * variable that happens to share an export's name stays plain.
 */
export function codeLinker(source: string, ctx: LinkContext): CodeLinker | undefined {
  const resolve = ctx.resolveApi;
  if (!resolve) return undefined;
  const imported = new Set<string>();
  for (const m of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@toyz\/yerd(?:\/[\w-]+)?["']/g)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim();
      if (name) imported.add(name);
    }
  }
  return (name, kind) => {
    if (kind === "word" && !imported.has(name)) return undefined;
    const id = resolve(name);
    return id && id !== ctx.self ? id : undefined;
  };
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
    .replace(/[`*~]/g, "")
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

/** yerd's mark (ui.tsx's Mark), small, for the take callout's label. */
const TAKE_MARK =
  '<svg class="take-mark" viewBox="0 0 32 32" width="20" height="20" aria-hidden="true"><rect width="32" height="32" rx="7" fill="var(--brand)"/>' +
  `<text x="16" y="22.5" text-anchor="middle" font-family="'Young Serif', Georgia, serif" font-size="22" fill="#fff8ee">y</text></svg>`;

interface Fence {
  /** The language: the info string's first word. */
  lang: string;
  /** The rest of the info string: `tab="..."`, a diagram's name. */
  info: string;
  body: string;
  /** The line the fence closes on. */
  end: number;
}

/** The fenced block opening at line `i`, if one does. It closes on a fence at least as long as its own. */
function readFence(lines: string[], i: number): Fence | undefined {
  const open = /^(\s*)(```+|~~~+)\s*([^\s`]*)\s*(.*?)\s*$/.exec(lines[i]!);
  if (!open) return undefined;
  const [, indent, close, lang, info] = open;
  const body: string[] = [];
  let j = i + 1;
  for (; j < lines.length && !lines[j]!.trimStart().startsWith(close!); j++) body.push(lines[j]!.slice(indent!.length));
  return { lang: lang!.toLowerCase(), info: info!, body: body.join("\n"), end: j };
}

/** The next fenced block when only blank lines come before it. */
function nextFence(lines: string[], from: number): Fence | undefined {
  let j = from;
  while (j < lines.length && lines[j]!.trim() === "") j++;
  return j < lines.length ? readFence(lines, j) : undefined;
}

function tabLabel(info: string): string | undefined {
  const m = /(?:^|\s)tab=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(info);
  return m ? (m[1] ?? m[2] ?? m[3])!.trim() : undefined;
}

function codeBlock(fence: Fence, ctx: LinkContext): string {
  const lang = fence.lang || "text";
  return `<div class="code-wrap"><button class="copy" type="button" aria-label="Copy code">Copy</button><pre class="code" data-lang="${escapeHtml(lang)}"><code>${highlight(fence.body, lang, codeLinker(fence.body, ctx))}</code></pre></div>`;
}

let tabGroups = 0;

/**
 * Consecutive tab="..." blocks: one card with a tab strip. Groups with the
 * same labels share a choice (prose.ts keeps it), so picking "An object" once
 * switches every such group on the page.
 */
function renderTabs(tabs: Array<{ label: string; html: string }>): string {
  const id = `tabs${++tabGroups}`;
  const key = tabs.map((t) => t.label).join("\u0001");
  const chosen = Math.max(0, tabs.findIndex((t) => t.label === chosenTab(key)));
  const strip = tabs
    .map(
      (t, n) =>
        `<button type="button" role="tab" id="${id}-t${n}" aria-controls="${id}-p${n}" aria-selected="${n === chosen}" tabindex="${n === chosen ? 0 : -1}" data-label="${escapeHtml(t.label)}">${escapeHtml(t.label)}</button>`,
    )
    .join("");
  const panels = tabs
    .map((t, n) => `<div class="tab-panel" role="tabpanel" id="${id}-p${n}" aria-labelledby="${id}-t${n}"${n === chosen ? "" : " hidden"}>${t.html}</div>`)
    .join("");
  return `<div class="example tabbed" data-tabs="${escapeHtml(key)}"><div class="tab-bar"><div class="tab-strip" role="tablist" aria-label="Variants">${strip}</div></div>${panels}</div>`;
}

/** A named diagram (diagrams.tsx), or its fallback text as a plain block when the name is unknown. */
function renderDiagram(name: string, fallback: string): string {
  const text = fallback.trim();
  if (hasDiagram(name)) {
    return `<yerd-diagram class="diagram" name="${escapeHtml(name)}" data-alt="${escapeHtml(text)}"><pre class="diagram-fallback">${escapeHtml(text)}</pre></yerd-diagram>`;
  }
  if (import.meta.env?.DEV) console.warn(`[docs] unknown diagram "${name}"; showing its fallback text`);
  return `<pre class="diagram-fallback">${escapeHtml(text)}</pre>`;
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

    const fence = readFence(lines, i);
    if (fence) {
      flush();
      i = fence.end;
      if (fence.lang === "answer") {
        html += `<div class="example only-answer">${renderAnswer(fence.body)}</div>`;
        continue;
      }
      if (fence.lang === "diagram") {
        html += renderDiagram(fence.info.split(/\s+/)[0] ?? "", fence.body);
        continue;
      }
      // A code block, the answer right after it (blank lines between), and,
      // for blocks labelled tab="...", the tabbed blocks that follow.
      const withAnswer = (block: Fence) => {
        const next = nextFence(lines, block.end + 1);
        if (next?.lang !== "answer") return { block, answer: undefined };
        i = next.end;
        return { block, answer: next };
      };
      const label = tabLabel(fence.info);
      if (label === undefined) {
        const { block, answer } = withAnswer(fence);
        html += answer ? `<div class="example">${codeBlock(block, ctx)}${renderAnswer(answer.body)}</div>` : codeBlock(block, ctx);
        continue;
      }
      const tabs = [{ label, ...withAnswer(fence) }];
      for (let next = nextFence(lines, i + 1); next && tabLabel(next.info) !== undefined; next = nextFence(lines, i + 1)) {
        i = next.end;
        tabs.push({ label: tabLabel(next.info)!, ...withAnswer(next) });
      }
      html += renderTabs(tabs.map((t) => ({ label: t.label, html: codeBlock(t.block, ctx) + (t.answer ? renderAnswer(t.answer.body) : "") })));
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
      // GitHub-style callouts: > [!NOTE], [!TIP], [!WARNING], [!IMPORTANT];
      // and yerd's own, > [!TAKE]: why yerd does something the way it does.
      const callout = /^\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION|TAKE)\]\s*$/i.exec(body[0]!.trim());
      if (callout) {
        const kind = callout[1]!.toLowerCase();
        const inner = renderMarkdown(body.slice(1).join("\n"), ctx).html;
        html +=
          kind === "take"
            ? `<aside class="callout take" aria-label="yerd's take"><div class="callout-title">${TAKE_MARK}<span>yerd's take</span></div>${inner}</aside>`
            : `<div class="callout ${kind}"><div class="callout-title">${kind}</div>${inner}</div>`;
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
