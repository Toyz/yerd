/**
 * A small syntax highlighter for the docs' code blocks: TypeScript / TSX /
 * JavaScript / JSON / shell. One pass of a sticky regex per language; output
 * is escaped text wrapped in <span class="tok-..."> and nothing else.
 */

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

export function highlight(code: string, lang: string): string {
  const language = lang.toLowerCase();
  if (["ts", "tsx", "typescript", "js", "jsx", "javascript", "mjs", "json", "jsonc"].includes(language)) return highlightTs(code);
  if (["sh", "bash", "shell", "console", "fish"].includes(language)) return highlightSh(code);
  return escape(code);
}

function highlightTs(code: string): string {
  let out = "";
  TS.lastIndex = 0;
  for (let m = TS.exec(code); m; m = TS.exec(code)) {
    const [text, comment, string, decorator, number, tag, word] = m;
    if (comment) out += `<span class="tok-comment">${escape(text)}</span>`;
    else if (string) out += `<span class="tok-string">${escape(text)}</span>`;
    else if (decorator) out += `<span class="tok-decorator">${escape(text)}</span>`;
    else if (number) out += `<span class="tok-number">${escape(text)}</span>`;
    else if (tag) out += `<span class="tok-tag">${escape(text)}</span>`;
    else if (word) {
      if (KEYWORDS.has(word)) out += `<span class="tok-keyword">${word}</span>`;
      else if (/^[A-Z]/.test(word)) out += `<span class="tok-type">${word}</span>`;
      else if (code[TS.lastIndex] === "(") out += `<span class="tok-fn">${word}</span>`;
      else out += word;
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
