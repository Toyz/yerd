/**
 * Stylesheets every page adopts (through the outlet), so prose, code,
 * badges and tags look the same everywhere.
 */

import { css } from "@toyz/loom";
import { codeStyles } from "./highlight";

/**
 * Kind tags are shaped like the plant labels you push into a flower bed: a
 * pointed end with a hole punched in it. Version badges are round pills, so
 * "what it is" and "when it shipped" never look alike.
 */
export const tagStyles = css`
  .tag {
    --tag-ink: var(--text-dim);
    --tag-bg: var(--bg-sunken);
    position: relative;
    display: inline-flex;
    align-items: center;
    height: 20px;
    padding: 0 8px 0 14px;
    font: 700 0.7rem/1 var(--font);
    letter-spacing: 0.01em;
    white-space: nowrap;
    color: var(--tag-ink);
    background: var(--tag-bg);
    border-radius: 0 3px 3px 0;
    clip-path: polygon(7px 0, 100% 0, 100% 100%, 7px 100%, 0 50%);
    vertical-align: middle;
    flex: none;
  }
  .tag::before {
    content: "";
    position: absolute;
    left: 6px;
    top: 50%;
    width: 4px;
    height: 4px;
    margin-top: -2px;
    border-radius: 50%;
    background: var(--hole, var(--bg));
  }
  .tag.function { --tag-ink: var(--moss); --tag-bg: var(--moss-bg); }
  .tag.class { --tag-ink: var(--accent); --tag-bg: var(--accent-bg); }
  .tag.interface, .tag.type, .tag.enum { --tag-ink: var(--slate); --tag-bg: var(--slate-bg); }
  .tag.const { --tag-ink: var(--ochre); --tag-bg: var(--ochre-bg); }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font: 700 0.7rem/1 var(--font);
    padding: 3px 8px 4px;
    border-radius: 999px;
    border: 1px solid var(--border-strong);
    color: var(--text-dim);
    white-space: nowrap;
    vertical-align: middle;
  }
  .badge.since { color: var(--moss); border-color: color-mix(in srgb, var(--moss) 35%, transparent); }
  .badge.unreleased { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); background: var(--warn-bg); }
  .badge.deprecated { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, transparent); }
`;

export const pageStyles = css`
  ${codeStyles}
  ${tagStyles}

  :host {
    display: block;
    padding: 44px 48px 96px;
    min-width: 0;
  }
  @media (max-width: 760px) {
    :host { padding: 28px 16px 72px; }
  }

  :focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; border-radius: 2px; }
  a { color: var(--accent); text-decoration: underline; text-decoration-color: var(--accent-dim); text-decoration-thickness: 1px; text-underline-offset: 3px; }
  a:hover { text-decoration-color: currentColor; }
  a.external::after { content: "↗"; margin-left: 2px; font-size: 0.75em; color: var(--text-faint); }
  /* Anything with data-api links to an API page and has a hover card: a
     dotted underline says so, in prose and inside code alike. */
  [data-api] {
    text-decoration: underline dotted var(--accent-dim);
    text-decoration-thickness: 1.5px;
    text-underline-offset: 4px;
    cursor: help;
  }
  [data-api]:hover { text-decoration-style: solid; text-decoration-color: var(--accent); }
  [data-api] code { color: var(--accent); }
  pre [data-api] { text-decoration-color: color-mix(in srgb, currentColor 28%, transparent); text-decoration-thickness: 1px; text-underline-offset: 4px; color: inherit; }
  pre [data-api]:hover { text-decoration-color: currentColor; }

  h1, h2 { font-family: var(--display); font-weight: 400; color: var(--text); }
  h1 { font-size: clamp(2rem, 1.6rem + 1.6vw, 2.6rem); line-height: 1.12; letter-spacing: -0.01em; margin: 0 0 14px; }
  h2 { font-size: 1.55rem; line-height: 1.25; margin: 2.2em 0 0.6em; }
  h3 { font-size: 1.1rem; line-height: 1.35; margin: 1.9em 0 0.5em; color: var(--text); }
  h4 { font-size: 1rem; margin: 1.5em 0 0.4em; color: var(--text-dim); }
  p, li { color: var(--text-dim); }
  strong { color: var(--text); }
  em { color: var(--text); }
  hr { border: 0; border-top: 1px solid var(--border); margin: 2.4em 0; }
  ul, ol { padding-left: 1.3em; }
  li { margin: 0.3em 0; }
  li::marker { color: var(--text-faint); }

  code {
    font-family: var(--mono);
    font-size: 0.88em;
    background: var(--bg-sunken);
    border-radius: 4px;
    padding: 0.08em 0.36em;
    color: var(--text);
  }
  pre.code, pre.signature {
    font-family: var(--mono);
    font-size: 0.86rem;
    line-height: 1.6;
    background: var(--code-bg);
    color: var(--code-text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 18px;
    overflow-x: auto;
    margin: 1.2em 0;
    tab-size: 2;
    scrollbar-width: thin;
  }
  pre code { background: none; border: 0; padding: 0; font-size: inherit; color: inherit; }
  pre.signature { white-space: pre-wrap; word-break: break-word; }

  blockquote {
    margin: 1.4em 0;
    padding: 2px 18px;
    border-left: 3px solid var(--border-strong);
    color: var(--text-dim);
  }
  blockquote p { color: var(--text-dim); }

  .table { overflow-x: auto; margin: 1.6em 0; border-top: 2px solid var(--text); border-bottom: 1px solid var(--border-strong); }
  table { border-collapse: collapse; width: 100%; font-size: 0.93rem; line-height: 1.55; }
  th, td { text-align: left; padding: 10px 14px 10px 0; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--text); font-weight: 700; white-space: nowrap; font-size: 0.86rem; }
  td { color: var(--text-dim); }
  tr:last-child td { border-bottom: 0; }
  /* The first column is usually the name (an option, a decorator, a value): keep it on one line. */
  td:first-child { white-space: nowrap; color: var(--text); }
  td code { white-space: nowrap; }

  .prose { font-size: 1.04rem; }
  .prose p, .prose li { line-height: 1.72; }
  .prose > h2:first-child, .prose h1 + h2 { margin-top: 1.2em; }
  .prose h1 + p { font-size: 1.12rem; color: var(--text-dim); }
  .prose img { vertical-align: middle; max-height: 22px; }
  .prose h1 .anchor, .prose h2 .anchor, .prose h3 .anchor, .prose h4 .anchor {
    margin-left: 8px; color: var(--text-faint); opacity: 0; font-family: var(--font); font-weight: 400; text-decoration: none;
  }
  .prose h2:hover .anchor, .prose h3:hover .anchor, .prose h4:hover .anchor, .prose .anchor:focus { opacity: 1; }
  .prose h2:hover .anchor:hover, .prose h3:hover .anchor:hover { color: var(--accent); }

  .code-wrap { position: relative; }
  .code-wrap .copy {
    position: absolute; top: 8px; right: 8px;
    font: 700 0.72rem var(--font);
    padding: 4px 9px; border-radius: 4px; cursor: pointer;
    border: 1px solid var(--border-strong); background: var(--bg-raised); color: var(--text-dim);
    opacity: 0; transition: opacity 0.15s ease;
  }
  .code-wrap:hover .copy, .code-wrap .copy:focus-visible { opacity: 1; }
  .code-wrap .copy:hover { color: var(--accent); border-color: var(--accent-dim); }
  @media (hover: none) { .code-wrap .copy { opacity: 1; } }

  .callout {
    margin: 1.6em 0; padding: 12px 18px 6px;
    border-radius: var(--radius);
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-left: 4px solid var(--border-strong);
  }
  .callout p { color: var(--text); margin: 0.3em 0 0.6em; }
  .callout-title { font: 700 0.86rem var(--font); text-transform: capitalize; }
  .callout.note { border-left-color: var(--slate); }
  .callout.note .callout-title { color: var(--slate); }
  .callout.tip { border-left-color: var(--moss-fill); }
  .callout.tip .callout-title { color: var(--moss); }
  .callout.warning, .callout.caution { border-left-color: var(--warn); }
  .callout.warning .callout-title, .callout.caution .callout-title { color: var(--warn); }
  .callout.important { border-left-color: var(--brand); }
  .callout.important .callout-title { color: var(--accent); }

  .muted { color: var(--text-faint); }
  .lede { font-size: 1.12rem; line-height: 1.6; color: var(--text-dim); margin: 0 0 24px; max-width: var(--measure); }
  .loading { color: var(--text-faint); padding: 40px 0; }
  .error { color: var(--danger); }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
`;
