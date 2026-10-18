/**
 * What makes rendered markdown interactive, by delegation from the element
 * holding it (the HTML comes from markdown.ts as one string): copy buttons,
 * tab strips (code variants and an answer's exchanges), and the HTML preview
 * of an answer's body. Plus the styles for those pieces.
 */

import { css } from "@toyz/loom";

// ── tab memory ──

/** The label chosen per tab group (keyed by its labels), for this visit. */
const chosen = new Map<string, string>();

export function chosenTab(key: string): string | undefined {
  return chosen.get(key);
}

// ── events ──

function rootOf(el: Element): Document | ShadowRoot {
  return el.getRootNode() as Document | ShadowRoot;
}

/** Selects one tab of a tablist and shows its panel. */
function select(tab: HTMLElement, focus = false): void {
  const list = tab.closest('[role="tablist"]');
  if (!list) return;
  const root = rootOf(tab);
  for (const other of list.querySelectorAll<HTMLElement>(':scope > [role="tab"]')) {
    const on = other === tab;
    other.setAttribute("aria-selected", String(on));
    other.tabIndex = on ? 0 : -1;
    const panel = root.getElementById(other.getAttribute("aria-controls") ?? "");
    if (panel) panel.hidden = !on;
  }
  if (focus) tab.focus();
}

/** A code-variant tab: every group on the page with the same labels follows, and the choice is kept. */
function selectVariant(tab: HTMLElement, focus = false): void {
  const group = tab.closest<HTMLElement>(".tabbed");
  const label = tab.dataset.label;
  if (!group || label === undefined) return select(tab, focus);
  const key = group.dataset.tabs ?? "";
  chosen.set(key, label);
  // Groups above this one can change height: keep the tab you clicked where it is.
  const before = tab.getBoundingClientRect().top;
  for (const other of rootOf(group).querySelectorAll<HTMLElement>(".tabbed")) {
    if (other.dataset.tabs !== key) continue;
    const match = [...other.querySelectorAll<HTMLElement>('.tab-strip > [role="tab"]')].find((t) => t.dataset.label === label);
    if (match) select(match, focus && match === tab);
  }
  const shift = tab.getBoundingClientRect().top - before;
  if (shift) window.scrollBy(0, shift);
}

function choose(tab: HTMLElement, focus = false): void {
  if (tab.closest(".tab-strip")) selectVariant(tab, focus);
  else select(tab, focus);
}

function copy(button: HTMLElement): void {
  const holder = button.closest(".code-wrap, .exchange");
  const code = holder?.querySelector(holder.classList.contains("exchange") ? ".ex-body code" : "pre code");
  void navigator.clipboard?.writeText(code?.textContent ?? "").then(() => {
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = "Copy"), 1200);
  });
}

function prefersDark(): boolean {
  const pinned = document.documentElement.dataset.theme;
  return pinned ? pinned === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * The preview's document: the guide's HTML with neutral styles, in the
 * page's theme. The iframe is sandboxed without scripts, and the CSP keeps it
 * from loading anything, so nothing in it can reach the page.
 */
function previewDoc(html: string): string {
  const [bg, text, faint, border, link] = prefersDark()
    ? ["#211d18", "#efe6d6", "#968b79", "#3a332a", "#f08263"]
    : ["#fffdf8", "#2b241c", "#6f6355", "#e0d5c0", "#a8381f"];
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">` +
    `<style>html{color-scheme:${prefersDark() ? "dark" : "light"}}` +
    `body{margin:0;padding:14px 16px;background:${bg};color:${text};font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}` +
    `h1,h2,h3{line-height:1.2;margin:.2em 0 .5em}h1{font-size:1.4em}h2{font-size:1.2em}p{margin:.5em 0}` +
    `a{color:${link};pointer-events:none}img{max-width:100%}small,.muted{color:${faint}}` +
    `table{border-collapse:collapse}td,th{border:1px solid ${border};padding:4px 8px;text-align:left}` +
    `button,input,select,textarea{font:inherit;color:inherit}button{padding:4px 12px;border:1px solid ${border};border-radius:5px;background:transparent}` +
    `input,select,textarea{padding:4px 8px;border:1px solid ${border};border-radius:5px;background:transparent}` +
    `form{margin:.5em 0}ul,ol{padding-left:1.3em}</style></head><body>${html}</body></html>`
  );
}

function showView(button: HTMLElement): void {
  const exchange = button.closest(".exchange");
  const source = exchange?.querySelector<HTMLElement>(".ex-body");
  const preview = exchange?.querySelector<HTMLElement>(".ex-preview");
  if (!exchange || !source || !preview) return;
  const wantPreview = button.dataset.view === "preview";
  for (const b of exchange.querySelectorAll<HTMLElement>(".ex-view-btn")) b.setAttribute("aria-pressed", String(b === button));
  source.hidden = wantPreview;
  preview.hidden = !wantPreview;
  if (!wantPreview) return;
  // Built each time it's shown, so it follows the theme.
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.title = "Preview of the HTML response";
  frame.addEventListener("load", () => {
    // The body's own height: the document's is never less than the frame's.
    const height = frame.contentDocument?.body.getBoundingClientRect().height;
    if (height) frame.style.height = `${Math.min(Math.ceil(height) + 2, 480)}px`;
  });
  frame.srcdoc = previewDoc(preview.dataset.html ?? "");
  preview.replaceChildren(frame);
}

/** Click handler for an element holding rendered markdown. */
export function onProseClick(event: Event): void {
  const target = event.target as Element;
  const button = target.closest?.<HTMLElement>("button");
  if (!button) return;
  if (button.classList.contains("copy")) copy(button);
  else if (button.getAttribute("role") === "tab") choose(button);
  else if (button.classList.contains("ex-view-btn")) showView(button);
}

/** Arrow keys, Home and End move between tabs (the tablist pattern). */
export function onProseKeydown(event: KeyboardEvent): void {
  const tab = (event.target as Element).closest?.<HTMLElement>('[role="tab"]');
  const list = tab?.closest('[role="tablist"]');
  if (!tab || !list) return;
  const tabs = [...list.querySelectorAll<HTMLElement>(':scope > [role="tab"]')];
  const at = tabs.indexOf(tab);
  const to = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: tabs.length - 1 }[event.key];
  if (to === undefined) return;
  event.preventDefault();
  choose(tabs[(to + tabs.length) % tabs.length]!, true);
}

// ── styles ──

export const proseStyles = css`
  /* An example: a code block and what it answers, as one card. */
  .example {
    margin: 1.4em 0 1.7em;
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    background: var(--bg-raised);
    overflow: hidden;
  }
  .example pre.code { margin: 0; border: 0; border-radius: 0; }
  .code-wrap + .answer { border-top: 1px dashed var(--border-strong); }

  .answer { padding: 12px 18px 16px; font: 0.8rem/1.6 var(--mono); color: var(--text-dim); }
  .exchange[hidden], .ex-body[hidden], .ex-preview[hidden], .tab-panel[hidden] { display: none; }
  /* The tools sit in the corner, beside the first line only, so the lines below keep the full width on a phone. */
  .exchange { position: relative; }
  .ex-tools { position: absolute; top: -1px; right: 0; }
  .ex-lines { overflow-wrap: anywhere; }
  .ex-lines > :first-child { padding-right: 64px; }
  .ex-head.with-view .ex-lines > :first-child { padding-right: 190px; }
  .ex-req { color: var(--text-faint); }
  .ex-method { font-weight: 700; letter-spacing: 0.02em; color: var(--text-dim); }
  .ex-req .ex-path { color: var(--text-dim); }
  .ex-status { margin-top: 4px; font-size: 0.86rem; font-weight: 600; color: var(--text); }
  .ex-req + .ex-status { margin-top: 6px; }
  .ex-lines > .ex-status:first-child { margin-top: 0; }
  .ex-proto { font-weight: 400; color: var(--text-faint); }
  .ex-code { display: inline-block; padding: 0 6px; border-radius: 4px; font-weight: 700; color: var(--text-dim); background: var(--bg-sunken); }
  .ex-code.s2xx { color: var(--moss); background: var(--moss-bg); }
  .ex-code.s3xx { color: var(--slate); background: var(--slate-bg); }
  .ex-code.s4xx { color: var(--ochre); background: var(--ochre-bg); }
  .ex-code.s5xx { color: var(--danger); background: var(--danger-bg); }
  .hdr { color: var(--text-dim); }
  .hdr-name { color: var(--text-faint); }
  .ex-sent { margin: 6px 0 8px; padding: 2px 0 2px 12px; border-left: 2px solid var(--border-strong); }
  .ex-sent-body { margin: 0; padding: 0; background: none; border: 0; font: inherit; color: var(--code-text); white-space: pre-wrap; overflow-wrap: anywhere; }
  .ex-body {
    margin: 10px 0 0; padding: 0; background: none; border: 0;
    font: 0.84rem/1.6 var(--mono); color: var(--code-text);
    white-space: pre-wrap; overflow-wrap: anywhere;
    max-height: 28rem; overflow: auto; scrollbar-width: thin;
  }
  .ex-body.html { white-space: pre; overflow-wrap: normal; }
  .ex-empty { margin-top: 8px; font: italic 0.88rem var(--font); color: var(--text-faint); }
  .ex-preview iframe { display: block; width: 100%; height: 160px; margin-top: 10px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg); }

  .ex-tools { display: flex; align-items: center; gap: 6px; }
  .answer .copy {
    font: 700 0.72rem var(--font); padding: 3px 9px; border-radius: 4px; cursor: pointer;
    border: 1px solid var(--border-strong); background: var(--bg-raised); color: var(--text-dim);
    opacity: 0; transition: opacity 0.15s ease;
  }
  .exchange:hover .copy, .answer .copy:focus-visible { opacity: 1; }
  .answer .copy:hover { color: var(--accent); border-color: var(--accent-dim); }
  @media (hover: none) { .answer .copy { opacity: 1; } }
  .ex-view { display: flex; gap: 2px; padding: 2px; border-radius: 6px; background: var(--bg-sunken); }
  .ex-view-btn { font: 600 0.72rem var(--font); padding: 3px 9px; border: 0; border-radius: 4px; cursor: pointer; background: none; color: var(--text-dim); }
  .ex-view-btn:hover { color: var(--text); }
  .ex-view-btn[aria-pressed="true"] { background: var(--bg-raised); color: var(--text); box-shadow: 0 1px 2px rgba(60, 40, 20, 0.18); }

  /* Several exchanges: one small tab per request. */
  .ex-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 12px; }
  .ex-tabs [role="tab"] {
    display: inline-flex; align-items: center; gap: 6px;
    font: 0.76rem var(--mono); padding: 3px 5px 3px 9px; border-radius: 5px; cursor: pointer;
    border: 1px solid var(--border); background: none; color: var(--text-faint);
  }
  .ex-tabs [role="tab"] .ex-method { color: inherit; }
  .ex-tabs [role="tab"]:hover { color: var(--text); border-color: var(--border-strong); }
  .ex-tabs [role="tab"][aria-selected="true"] { color: var(--text); background: var(--bg-sunken); border-color: var(--border-strong); }
  .ex-tabs .ex-code { font-size: 0.7rem; padding: 0 5px; }

  /* Variants of one example behind a tab strip. */
  .tab-bar { padding: 8px 10px; border-bottom: 1px solid var(--border); }
  .tab-strip { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 3px; border-radius: 7px; background: var(--bg-sunken); max-width: 100%; }
  .tab-strip [role="tab"] {
    font: 600 0.84rem var(--font); padding: 5px 11px; border-radius: 5px; border: 0; cursor: pointer;
    background: none; color: var(--text-dim);
  }
  .tab-strip [role="tab"]:hover { color: var(--text); }
  .tab-strip [role="tab"][aria-selected="true"] { background: var(--bg-raised); color: var(--text); box-shadow: 0 1px 2px rgba(60, 40, 20, 0.18); }

  @media (max-width: 560px) {
    .answer { padding: 10px 12px 14px; }
    .example pre.code { padding: 14px 12px; }
  }

  /* yerd's take: an opinion, set apart from notes and warnings. */
  .callout.take {
    border: 0;
    border-left: 3px solid var(--brand);
    border-radius: 0 var(--radius) var(--radius) 0;
    background: var(--accent-bg);
    padding: 14px 20px 6px;
  }
  .callout.take .callout-title {
    display: flex; align-items: center; gap: 9px;
    font: 400 1.1rem/1.2 var(--display); color: var(--accent); text-transform: none;
    margin-bottom: 4px;
  }
  .callout.take .take-mark { flex: none; }
  .callout.take p { color: var(--text); }

  /* Diagrams (diagrams.tsx); the fallback is what an unknown name shows. */
  yerd-diagram { display: block; margin: 1.8em 0; }
  .diagram-fallback {
    margin: 1.4em 0; padding: 14px 16px; border-radius: var(--radius);
    background: var(--bg-sunken); border: 1px dashed var(--border-strong);
    font: 0.84rem/1.6 var(--mono); color: var(--text-dim); white-space: pre-wrap;
  }
`;
