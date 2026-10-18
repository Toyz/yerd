/** Small pieces several pages render. */

import { renderMarkdown, type LinkContext } from "./markdown";
import { highlight } from "./highlight";

/** "since v0.1.0", "unreleased", or nothing (as old as its owner). */
export function SinceBadge({ since }: { since: string | null | undefined }) {
  if (since === undefined) return null;
  if (since === null) {
    return (
      <span class="badge unreleased" title="On main, not in a release yet">
        unreleased
      </span>
    );
  }
  return (
    <span class="badge since" title={`First shipped in v${since}`}>
      since v{since}
    </span>
  );
}

/** What an export is, as a plant tag (see tagStyles in shared.ts). */
export function KindBadge({ kind }: { kind: string }) {
  return <span class={`tag ${kind}`}>{kind}</span>;
}

/** yerd's mark: a lowercase y in the display face, on a terracotta tile. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg class="mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <rect width={32} height={32} rx={7} fill="var(--brand)" />
      <text x={16} y={22.5} text-anchor="middle" font-family="'Young Serif', Georgia, serif" font-size={22} fill="#fff8ee">y</text>
    </svg>
  );
}

/** Markdown (guides, JSDoc), rendered by markdown.ts: escaped text plus its own markup only. */
export function Markdown({ text, ctx, class: className = "prose" }: { text: string; ctx: LinkContext; class?: string }) {
  return <div class={className} onClick={onCopyClick} rawHTML={renderMarkdown(text, ctx).html}></div>;
}

/**
 * A highlighted code block; the highlighter escapes everything it outputs.
 * With `link`, type names that are exports become links to their pages (a
 * signature's `YerdResponse`, `ResponseInit`).
 */
export function Code({
  code,
  lang = "ts",
  class: className = "code",
  link,
}: {
  code: string;
  lang?: string;
  class?: string;
  link?: (name: string) => string | undefined;
}) {
  let html = highlight(code, lang);
  if (link) {
    html = html.replace(/<span class="tok-type">([A-Za-z_$][\w$]*)<\/span>/g, (whole, name: string) => {
      const id = link(name);
      return id ? `<a class="api-ref" href="#/api/${id}" data-api="${id}"><span class="tok-type">${name}</span></a>` : whole;
    });
  }
  return (
    <pre class={className}>
      <code rawHTML={html}></code>
    </pre>
  );
}

/**
 * Click handler for a container of rendered markdown: the copy buttons the
 * renderer puts on code blocks.
 */
export function onCopyClick(event: Event): void {
  const button = (event.target as Element).closest?.(".copy");
  if (!button) return;
  const code = button.parentElement?.querySelector("code")?.textContent ?? "";
  void navigator.clipboard?.writeText(code).then(() => {
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = "Copy"), 1200);
  });
}

/** The first sentence of a doc comment, for lists. */
export function summary(doc: string | undefined): string {
  if (!doc) return "";
  const text = doc.replace(/```[\s\S]*?```/g, "").replace(/\s+/g, " ").trim();
  const end = text.search(/[.!?](\s|$)/);
  return (end === -1 ? text : text.slice(0, end + 1)).replace(/`/g, "");
}
