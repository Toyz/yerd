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

export function KindBadge({ kind }: { kind: string }) {
  return <span class={`badge kind ${kind}`}>{kind}</span>;
}

/** Markdown (guides, JSDoc), rendered by markdown.ts: escaped text plus its own markup only. */
export function Markdown({ text, ctx, class: className = "prose" }: { text: string; ctx: LinkContext; class?: string }) {
  return <div class={className} onClick={onCopyClick} rawHTML={renderMarkdown(text, ctx).html}></div>;
}

/** A highlighted code block; the highlighter escapes everything it outputs. */
export function Code({ code, lang = "ts", class: className = "code" }: { code: string; lang?: string; class?: string }) {
  return (
    <pre class={className}>
      <code rawHTML={highlight(code, lang)}></code>
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
    button.textContent = "copied";
    setTimeout(() => (button.textContent = "copy"), 1200);
  });
}

/** The first sentence of a doc comment, for lists. */
export function summary(doc: string | undefined): string {
  if (!doc) return "";
  const text = doc.replace(/```[\s\S]*?```/g, "").replace(/\s+/g, " ").trim();
  const end = text.search(/[.!?](\s|$)/);
  return (end === -1 ? text : text.slice(0, end + 1)).replace(/`/g, "");
}
