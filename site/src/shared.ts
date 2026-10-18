/**
 * Stylesheets every page adopts (through the outlet), so prose, code,
 * badges and cards look the same everywhere.
 */

import { css } from "@toyz/loom";

export const pageStyles = css`
  :host {
    display: block;
    max-width: 1120px;
    margin: 0 auto;
    padding: 40px 48px 96px;
  }
  @media (max-width: 760px) {
    :host { padding: 24px 18px 72px; }
  }

  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  a.external::after { content: " ↗"; font-size: 0.8em; color: var(--text-faint); }

  h1 { font-size: 2rem; line-height: 1.2; letter-spacing: -0.02em; margin: 0 0 12px; }
  h2 { font-size: 1.35rem; margin: 2.2em 0 0.6em; padding-top: 0.4em; border-top: 1px solid var(--border); letter-spacing: -0.01em; }
  h3 { font-size: 1.08rem; margin: 1.8em 0 0.5em; }
  h4 { font-size: 0.98rem; margin: 1.4em 0 0.4em; color: var(--text-dim); }
  p, li { color: var(--text-dim); }
  strong { color: var(--text); }
  hr { border: 0; border-top: 1px solid var(--border); margin: 2em 0; }
  ul, ol { padding-left: 1.4em; }
  li { margin: 0.25em 0; }

  code {
    font-family: var(--mono);
    font-size: 0.86em;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.1em 0.35em;
    color: var(--text);
  }
  pre.code, pre.signature {
    font-family: var(--mono);
    font-size: 0.84rem;
    line-height: 1.55;
    background: var(--bg-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
    overflow-x: auto;
    margin: 1em 0;
  }
  pre code { background: none; border: 0; padding: 0; font-size: inherit; color: var(--text); }
  pre.signature { border-left: 3px solid var(--accent-dim); white-space: pre-wrap; word-break: break-word; }

  .tok-comment { color: var(--tok-comment); font-style: italic; }
  .tok-string { color: var(--tok-string); }
  .tok-keyword { color: var(--tok-keyword); }
  .tok-decorator { color: var(--tok-decorator); }
  .tok-number { color: var(--tok-number); }
  .tok-type { color: var(--tok-type); }
  .tok-fn { color: var(--tok-fn); }
  .tok-tag { color: var(--tok-tag); }

  blockquote {
    margin: 1.2em 0;
    padding: 4px 16px;
    border-left: 3px solid var(--info);
    background: var(--info-bg);
    border-radius: 0 var(--radius) var(--radius) 0;
  }
  blockquote p { color: var(--text); }

  .table { overflow-x: auto; margin: 1.4em 0; border: 1px solid var(--border); border-radius: var(--radius); }
  table { border-collapse: collapse; width: 100%; font-size: 0.92rem; line-height: 1.55; }
  th, td { text-align: left; padding: 11px 16px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th {
    background: var(--bg-raised); color: var(--text-faint); font-weight: 700; white-space: nowrap;
    font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.06em;
  }
  td { color: var(--text-dim); }
  tbody tr:nth-child(even) td { background: rgba(255, 255, 255, 0.015); }
  tbody tr:hover td { background: var(--bg-hover); }
  tr:last-child td { border-bottom: 0; }
  /* The first column is usually the name (an option, a decorator, a value): keep it on one line. */
  td:first-child { white-space: nowrap; color: var(--text); }
  td code { white-space: nowrap; }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--mono);
    font-size: 0.72rem;
    font-weight: 600;
    line-height: 1;
    padding: 4px 7px;
    border-radius: 999px;
    border: 1px solid var(--border-strong);
    color: var(--text-dim);
    white-space: nowrap;
    vertical-align: middle;
  }
  .badge.since { color: var(--accent); border-color: var(--accent-dim); background: var(--accent-bg); }
  .badge.unreleased { color: var(--warn); border-color: rgba(232, 196, 106, 0.45); background: var(--warn-bg); }
  .badge.deprecated { color: var(--danger); border-color: rgba(240, 139, 139, 0.45); }
  .badge.kind { text-transform: lowercase; }
  .badge.kind.class { color: var(--tok-type); }
  .badge.kind.function { color: var(--tok-fn); }
  .badge.kind.interface, .badge.kind.type { color: var(--tok-keyword); }
  .badge.kind.const { color: var(--tok-decorator); }

  .prose { max-width: 90ch; }
  .prose p, .prose li { line-height: 1.7; }
  .prose h2 { margin-top: 2.6em; }
  .prose h2:first-child, .prose h1 + h2 { margin-top: 1.2em; }
  .prose hr + h2 { border-top: 0; padding-top: 0; margin-top: 1em; }
  .prose img { vertical-align: middle; max-height: 22px; }
  .prose h1 .anchor, .prose h2 .anchor, .prose h3 .anchor, .prose h4 .anchor {
    margin-left: 8px; color: var(--text-faint); opacity: 0; font-weight: 400; text-decoration: none;
  }
  .prose h2:hover .anchor, .prose h3:hover .anchor, .prose h4:hover .anchor { opacity: 1; }
  .prose h2:hover .anchor:hover, .prose h3:hover .anchor:hover { color: var(--accent); }

  .code-wrap { position: relative; }
  .code-wrap .copy {
    position: absolute; top: 8px; right: 8px;
    font: 600 0.7rem var(--mono); text-transform: lowercase;
    padding: 4px 8px; border-radius: 5px; cursor: pointer;
    border: 1px solid var(--border-strong); background: var(--bg-raised); color: var(--text-faint);
    opacity: 0; transition: opacity 0.15s ease;
  }
  .code-wrap:hover .copy, .code-wrap .copy:focus { opacity: 1; }
  .code-wrap .copy:hover { color: var(--accent); border-color: var(--accent-dim); }

  .callout {
    margin: 1.4em 0; padding: 10px 16px 4px;
    border: 1px solid var(--border); border-left-width: 3px; border-radius: var(--radius);
    background: var(--bg-raised);
  }
  .callout p { color: var(--text); margin: 0.4em 0 0.6em; }
  .callout-title { font: 700 0.72rem var(--mono); text-transform: uppercase; letter-spacing: 0.08em; }
  .callout.note { border-left-color: var(--info); }
  .callout.note .callout-title { color: var(--info); }
  .callout.tip { border-left-color: var(--accent); }
  .callout.tip .callout-title { color: var(--accent); }
  .callout.warning, .callout.caution { border-left-color: var(--warn); }
  .callout.warning .callout-title, .callout.caution .callout-title { color: var(--warn); }
  .callout.important { border-left-color: var(--tok-keyword); }
  .callout.important .callout-title { color: var(--tok-keyword); }

  .muted { color: var(--text-faint); }
  .lede { font-size: 1.08rem; color: var(--text-dim); margin: 0 0 24px; }
  .loading { color: var(--text-faint); padding: 40px 0; }
  .error { color: var(--danger); }
`;
