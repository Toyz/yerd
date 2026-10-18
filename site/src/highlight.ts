/**
 * A small syntax highlighter for the docs' code blocks: TypeScript / TSX /
 * JavaScript / JSON / shell. One pass of a sticky regex per language; output
 * is escaped text wrapped in <span class="tok-..."> and nothing else.
 *
 * The palette for those classes lives here too (codeStyles), one pair of
 * colors per token: paper first, soil second. Every color clears WCAG AA
 * (4.5:1) on the code background and on the raised surface in its theme.
 * Decorators get the terracotta: they're what a yerd file is made of.
 */

import { css } from "@toyz/loom";

/** [light, dark] per token class. */
export const CODE_PALETTE = {
  comment: ["#6c6152", "#948973"],
  string: ["#476628", "#b7cb91"],
  keyword: ["#86386a", "#d9a6c8"],
  decorator: ["#a8381f", "#f08a68"],
  number: ["#7d5508", "#e6bb62"],
  type: ["#2d5a73", "#93c3d8"],
  fn: ["#6e4613", "#e3c38f"],
  tag: ["#9a3a1c", "#f2957a"],
} as const;

const tokenRules = Object.entries(CODE_PALETTE)
  .map(([token, [light, dark]]) => `.tok-${token} { color: light-dark(${light}, ${dark}); }`)
  .join("\n");

/** Token colors and the code surface, for any shadow root that shows code. */
export const codeStyles = css`
  :host {
    --code-bg: light-dark(#ede5d5, #15120f);
    --code-text: light-dark(#2b241c, #e9e0cf);
  }
  ${tokenRules}
  .tok-comment { font-style: italic; }
  .tok-decorator { font-weight: 600; }
`;

const KEYWORDS = new Set(
  ("abstract as async await break case catch class const continue declare default delete do else enum export extends " +
    "false finally for from function get if implements import in infer instanceof interface keyof let new null of " +
    "private protected public readonly return satisfies set static super switch this throw true try type typeof " +
    "undefined unique var void while yield accessor").split(" "),
);

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const TS =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(@[A-Za-z_$][\w$.]*)|(\b\d[\d_]*(?:\.\d+)?(?:e[-+]?\d+)?n?\b)|(<\/?[A-Za-z][\w.-]*|\/?>)|([A-Za-z_$][\w$]*)|(\s+|[\s\S])/gy;

const SH = /(#[^\n]*)|("(?:\\.|[^"\\])*"|'[^']*')|(\$\w+|\$\{[^}]*\})|(^|\s)(npm|npx|node|git|vite|cd|yerd)(?=\s|$)|(\s+|[\s\S])/gmy;

/**
 * Turns a name in code into an API page id when it should link: `decorator`
 * for `@route` / `@is.string`, `word` for any other identifier.
 */
export type CodeLinker = (name: string, kind: "decorator" | "word") => string | undefined;

function linked(html: string, id: string | undefined): string {
  return id ? `<a class="api-ref" href="#/api/${escape(id)}" data-api="${escape(id)}">${html}</a>` : html;
}

export function highlight(code: string, lang: string, link?: CodeLinker): string {
  const language = lang.toLowerCase();
  if (["ts", "tsx", "typescript", "js", "jsx", "javascript", "mjs", "json", "jsonc"].includes(language)) return highlightTs(code, link);
  if (["sh", "bash", "shell", "console", "fish"].includes(language)) return highlightSh(code);
  return escape(code);
}

function highlightTs(code: string, link?: CodeLinker): string {
  let out = "";
  TS.lastIndex = 0;
  for (let m = TS.exec(code); m; m = TS.exec(code)) {
    const [text, comment, string, decorator, number, tag, word] = m;
    if (comment) out += `<span class="tok-comment">${escape(text)}</span>`;
    else if (string) out += `<span class="tok-string">${escape(text)}</span>`;
    else if (decorator) out += linked(`<span class="tok-decorator">${escape(text)}</span>`, link?.(text.slice(1), "decorator"));
    else if (number) out += `<span class="tok-number">${escape(text)}</span>`;
    else if (tag) out += `<span class="tok-tag">${escape(text)}</span>`;
    else if (word) {
      // `get` / `set` are keywords in getters but also yerd's verb decorators,
      // so a keyword the block imports from yerd still links.
      const keywordLink = KEYWORDS.has(word) && code[TS.lastIndex - word.length - 1] !== "." ? link?.(word, "word") : undefined;
      if (KEYWORDS.has(word)) out += linked(`<span class="tok-keyword">${word}</span>`, keywordLink);
      else {
        // A property access (`.word`) is never an export of its own.
        const id = code[TS.lastIndex - word.length - 1] === "." ? undefined : link?.(word, "word");
        if (/^[A-Z]/.test(word)) out += linked(`<span class="tok-type">${word}</span>`, id);
        else if (code[TS.lastIndex] === "(") out += linked(`<span class="tok-fn">${word}</span>`, id);
        else out += linked(word, id);
      }
    } else out += escape(text);
    if (TS.lastIndex >= code.length) break;
  }
  return out;
}

function highlightSh(code: string): string {
  let out = "";
  SH.lastIndex = 0;
  for (let m = SH.exec(code); m; m = SH.exec(code)) {
    const [text, comment, string, variable, lead, command] = m;
    if (comment) out += `<span class="tok-comment">${escape(text)}</span>`;
    else if (string) out += `<span class="tok-string">${escape(text)}</span>`;
    else if (variable) out += `<span class="tok-type">${escape(text)}</span>`;
    else if (command) out += `${escape(lead ?? "")}<span class="tok-keyword">${command}</span>`;
    else out += escape(text);
    if (SH.lastIndex >= code.length) break;
  }
  return out;
}
