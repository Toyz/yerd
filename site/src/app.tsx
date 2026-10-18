/**
 * The shell: a top bar (brand, Guides / API / Benchmarks, search, theme,
 * GitHub), a sidebar only where one helps (the guides on guide pages, the
 * API sections on API pages), the routed outlet and the footer. On narrow
 * screens the sidebar and the top links move into a drawer.
 */

import { LoomElement, component, css, dialog, mount, on, persist, reactive, styles } from "@toyz/loom";
import { RouteChanged } from "@toyz/loom/router";
import { loadApi, loadGuides, moduleShort, sectionId, type Api, type GuideInfo } from "./data";
import { OpenPalette, PALETTE_HOTKEY } from "./palette";
import { pageStyles } from "./shared";
import { GnomeMark } from "./ui";

type Theme = "system" | "light" | "dark";
const THEME_NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const THEME_LABEL: Record<Theme, string> = { system: "Theme: follows your system", light: "Theme: light", dark: "Theme: dark" };

const sheet = css`
  :host { display: block; min-height: 100vh; }
  .skip {
    position: absolute; left: 12px; top: -48px; z-index: 50;
    padding: 8px 14px; border-radius: 5px; background: var(--text); color: var(--bg); text-decoration: none;
  }
  .skip:focus { top: 10px; }
  main:focus { outline: none; }

  /* ── top bar ── */
  header {
    position: sticky; top: 0; z-index: 40;
    height: var(--top);
    display: flex; align-items: center; gap: 28px;
    padding: 0 24px;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--border);
  }
  .brand { display: flex; align-items: center; gap: 10px; color: var(--text); text-decoration: none; flex: none; }
  .brand .gnome { margin-top: -3px; }
  .brand span { font: 400 1.45rem/1 var(--display); letter-spacing: -0.01em; }
  .brand:hover .gnome { transform: rotate(-6deg); }
  .gnome { transition: transform 0.2s ease; }

  nav.primary { display: flex; gap: 4px; }
  nav.primary a {
    position: relative;
    padding: 6px 10px; border-radius: 5px;
    color: var(--text-dim); text-decoration: none; font-size: 0.95rem;
  }
  nav.primary a:hover { color: var(--text); background: var(--bg-hover); }
  nav.primary a.on { color: var(--text); font-weight: 700; }
  nav.primary a.on::after {
    content: ""; position: absolute; left: 10px; right: 10px; bottom: -13px; height: 3px;
    background: var(--hat); border-radius: 2px 2px 0 0;
  }

  .tools { margin-left: auto; display: flex; align-items: center; gap: 6px; }
  button.search {
    display: flex; align-items: center; gap: 10px;
    width: 230px; padding: 6px 8px 6px 12px;
    border-radius: 6px; border: 1px solid var(--border-strong);
    background: var(--bg-raised); color: var(--text-faint);
    font: inherit; font-size: 0.9rem; cursor: pointer; text-align: left;
  }
  button.search:hover { border-color: var(--accent-dim); color: var(--text-dim); }
  button.search .label { flex: 1; }
  kbd {
    font: 600 0.72rem var(--mono); padding: 2px 6px; border-radius: 4px;
    border: 1px solid var(--border); background: var(--bg-sunken); color: var(--text-dim);
  }
  .icon-btn {
    display: grid; place-items: center; width: 36px; height: 36px; flex: none;
    border-radius: 6px; border: 1px solid transparent; background: none; color: var(--text-dim); cursor: pointer;
  }
  .icon-btn:hover { color: var(--text); background: var(--bg-hover); }
  .tools .link { color: var(--text-dim); text-decoration: none; font-size: 0.9rem; padding: 6px 8px; border-radius: 5px; }
  .tools .link:hover { color: var(--text); background: var(--bg-hover); }
  .tools .version { font: 0.78rem var(--mono); color: var(--text-faint); }
  .only-narrow { display: none; }

  /* ── body ── */
  .body { display: flex; align-items: flex-start; }
  main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: calc(100vh - var(--top)); }
  loom-outlet { display: block; flex: 1; }

  aside.side {
    position: sticky; top: var(--top);
    width: var(--sidebar); flex: none;
    height: calc(100vh - var(--top));
    overflow-y: auto; scrollbar-width: thin;
    padding: 28px 12px 40px 20px;
    border-right: 1px solid var(--border);
  }

  .group + .group { margin-top: 14px; }
  button.group-title {
    display: flex; align-items: center; gap: 6px; width: 100%;
    padding: 4px 8px; border: 0; background: none; cursor: pointer; border-radius: 4px;
    font: 700 0.84rem var(--font); color: var(--text); text-align: left;
  }
  button.group-title:hover { background: var(--bg-hover); }
  .chevron { width: 10px; height: 10px; color: var(--text-faint); transition: transform 0.15s ease; flex: none; }
  .closed .chevron { transform: rotate(-90deg); }
  .closed .items { display: none; }
  .items { margin: 4px 0 0; padding: 0; list-style: none; }

  .items a {
    position: relative; display: block;
    padding: 4px 8px 4px 24px; border-radius: 4px;
    color: var(--text-dim); text-decoration: none; font-size: 0.92rem; line-height: 1.4;
  }
  .items a:hover { color: var(--text); background: var(--bg-hover); }
  /* You are here: the gnome's hat. */
  .items a.on { color: var(--text); font-weight: 700; }
  .items a.on::before {
    content: ""; position: absolute; left: 9px; top: 50%; margin-top: -6px;
    border-left: 4.5px solid transparent; border-right: 4.5px solid transparent; border-bottom: 10px solid var(--hat);
  }
  .side-head { font: 400 1.05rem var(--display); color: var(--text); padding: 0 8px 10px; }
  .side-head a { color: inherit; text-decoration: none; }
  .side-head a:hover { color: var(--accent); }

  /* ── footer ── */
  footer {
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px 24px;
    padding: 22px 48px 28px; border-top: 1px solid var(--border);
    font-size: 0.85rem; color: var(--text-faint);
  }
  footer .grow { flex: 1; min-width: 220px; display: flex; align-items: center; gap: 10px; }
  footer a { color: var(--text-dim); text-decoration: none; }
  footer a:hover { color: var(--accent); text-decoration: underline; }
  footer code { font: 0.8rem var(--mono); }

  /* ── drawer (narrow screens) ── */
  dialog.drawer {
    margin: 0 0 0 auto; height: 100dvh; max-height: none; width: min(320px, 86vw);
    padding: 0; border: 0; border-left: 1px solid var(--border);
    background: var(--bg); color: var(--text);
    box-shadow: var(--shadow);
  }
  dialog.drawer[open] { animation: slide 0.18s ease-out; }
  dialog.drawer::backdrop { background: rgba(30, 20, 10, 0.35); }
  @keyframes slide { from { transform: translateX(24px); opacity: 0; } }
  .drawer-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 12px 12px 20px; border-bottom: 1px solid var(--border); }
  .drawer-body { padding: 16px 12px 40px 16px; overflow-y: auto; }
  .drawer-links { display: grid; gap: 2px; margin-bottom: 20px; }
  .drawer-links a { padding: 8px 10px; border-radius: 5px; color: var(--text); text-decoration: none; font: 400 1.15rem var(--display); }
  .drawer-links a.on { background: var(--accent-bg); color: var(--accent); }
  .drawer-meta { margin: 20px 10px 0; font-size: 0.85rem; color: var(--text-faint); display: flex; flex-wrap: wrap; gap: 6px 16px; }
  .drawer-meta a { color: var(--text-dim); }

  @media (max-width: 1080px) {
    button.search { width: auto; }
    button.search .label { display: none; }
    .tools .version { display: none; }
  }
  @media (max-width: 900px) {
    header { padding: 0 12px 0 16px; gap: 12px; }
    nav.primary, aside.side, .tools .link, .only-wide { display: none; }
    .only-narrow { display: grid; }
    button.search kbd { display: none; }
    button.search { border: 0; background: none; padding: 8px; }
    footer { padding: 20px 16px 28px; }
  }
`;

const ChevronIcon = () => (
  <svg class="chevron" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="currentColor" stroke-width={1.6} stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

const SearchIcon = () => (
  <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={2.2} stroke-linecap="round" aria-hidden="true">
    <circle cx={11} cy={11} r={7} />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

function ThemeIcon({ theme }: { theme: Theme }) {
  if (theme === "light") {
    return (
      <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={2} stroke-linecap="round" aria-hidden="true">
        <circle cx={12} cy={12} r={4.5} />
        <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
      </svg>
    );
  }
  if (theme === "dark") {
    return (
      <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={2} stroke-linejoin="round" aria-hidden="true">
        <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
      </svg>
    );
  }
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={2} aria-hidden="true">
      <circle cx={12} cy={12} r={8.5} />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" />
    </svg>
  );
}

@component("yerd-docs")
@styles(sheet)
export class YerdDocs extends LoomElement {
  @reactive accessor path = currentPath();
  @reactive accessor api: Api | undefined = undefined;
  @reactive accessor guides: GuideInfo[] = [];
  /** Groups you closed; the one holding the current page opens anyway. */
  @persist("yerd-docs:collapsed") accessor collapsed: string[] = [];
  @persist("yerd-docs:theme") accessor theme: Theme = "system";
  @dialog accessor menuOpen = false;

  @mount async load() {
    applyTheme(this.theme);
    const [api, guides] = await Promise.all([loadApi(), loadGuides()]);
    this.api = api;
    this.guides = guides;
  }

  @on(RouteChanged) onRoute(event: RouteChanged) {
    this.path = event.path;
    this.menuOpen = false;
  }

  #cycleTheme() {
    this.theme = THEME_NEXT[this.theme] ?? "system";
    applyTheme(this.theme);
    this.scheduleUpdate();
  }

  #toggle(group: string) {
    this.collapsed = this.collapsed.includes(group) ? this.collapsed.filter((g) => g !== group) : [...this.collapsed, group];
    this.scheduleUpdate();
  }

  get #area(): "home" | "guide" | "api" | "benchmarks" | "other" {
    if (this.path === "/") return "home";
    if (this.path.startsWith("/guide/")) return "guide";
    if (this.path === "/api" || this.path.startsWith("/api/")) return "api";
    if (this.path === "/benchmarks") return "benchmarks";
    return "other";
  }

  #onGuide(slug: string): boolean {
    return this.path === `/guide/${slug}` || this.path.startsWith(`/guide/${slug}/`);
  }

  #group(title: string, items: Array<{ to: string; label: string; on: boolean }>) {
    const current = items.some((i) => i.on);
    const closed = this.collapsed.includes(title) && !current;
    return (
      <div class={`group ${closed ? "closed" : ""}`} loom-key={title}>
        <button class="group-title" aria-expanded={closed ? "false" : "true"} onClick={() => this.#toggle(title)}>
          <ChevronIcon />
          <span>{title}</span>
        </button>
        <ul class="items">
          {items.map((i) => (
            <li>
              <a href={`#${i.to}`} class={i.on ? "on" : ""} aria-current={i.on ? "page" : undefined}>
                {i.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  /** The guides, by group, in reading order. Design notes show only while you're reading one. */
  #guideNav() {
    const reading = this.guides.find((g) => this.#onGuide(g.slug));
    const groups = [...new Set(this.guides.map((g) => g.group))].filter((g) => g !== "Design notes" || reading?.group === "Design notes");
    return groups.map((group) => {
      const items = this.guides
        .filter((g) => g.group === group && g.slug !== "overview")
        .map((g) => ({ to: `/guide/${g.slug}`, label: g.title, on: this.#onGuide(g.slug) }));
      return items.length ? this.#group(group, items) : null;
    });
  }

  #apiNav() {
    const api = this.api;
    if (!api) return null;
    const entry = this.path.startsWith("/api/") && !this.path.startsWith("/api/section/") ? this.path.slice(5).split("/")[0] : undefined;
    const entrySection = entry ? api.entries.find((e) => `${moduleShort(e.module)}.${e.name}` === entry)?.section : undefined;
    const items = [
      { to: "/api", label: "All exports", on: this.path === "/api" },
      ...api.sections.map((s) => ({
        to: `/api/section/${sectionId(s)}`,
        label: s,
        on: this.path === `/api/section/${sectionId(s)}` || entrySection === s,
      })),
    ];
    return this.#group("API reference", items);
  }

  #sideContent() {
    const area = this.#area;
    if (area === "guide") return this.#guideNav();
    if (area === "api") return this.#apiNav();
    return null;
  }

  #primaryLinks(extra = "") {
    const area = this.#area;
    return [
      <a class={`${area === "guide" ? "on" : ""} ${extra}`} href="#/guide/getting-started" aria-current={area === "guide" ? "true" : undefined}>Guides</a>,
      <a class={`${area === "api" ? "on" : ""} ${extra}`} href="#/api" aria-current={area === "api" ? "true" : undefined}>API</a>,
      <a class={`${area === "benchmarks" ? "on" : ""} ${extra}`} href="#/benchmarks" aria-current={area === "benchmarks" ? "true" : undefined}>Benchmarks</a>,
    ];
  }

  update() {
    const api = this.api;
    const side = this.#sideContent();
    const area = this.#area;
    return (
      <div>
        <a class="skip" href="#main" onClick={(e: Event) => { e.preventDefault(); (this.shadow.querySelector("main") as HTMLElement | null)?.focus(); }}>
          Skip to content
        </a>
        <header>
          <a class="brand" href="#/" aria-label="yerd home">
            <GnomeMark size={30} />
            <span>yerd</span>
          </a>
          <nav class="primary" aria-label="Main">{this.#primaryLinks()}</nav>
          <div class="tools">
            <button class="search" onClick={() => OpenPalette.dispatch()} aria-label="Search the docs">
              <SearchIcon />
              <span class="label">Search</span>
              <kbd>{PALETTE_HOTKEY}</kbd>
            </button>
            {api?.latest ? (
              <a class="link version" href="https://www.npmjs.com/package/@toyz/yerd" target="_blank" rel="noopener" title={`Latest release on npm. These docs are built from main at ${api.commit}.`}>
                v{api.latest}
              </a>
            ) : null}
            <a class="link" href="https://github.com/Toyz/yerd" target="_blank" rel="noopener">GitHub</a>
            <button class="icon-btn" onClick={() => this.#cycleTheme()} aria-label={THEME_LABEL[this.theme]} title={THEME_LABEL[this.theme]}>
              <ThemeIcon theme={this.theme} />
            </button>
            <button class="icon-btn only-narrow" onClick={() => (this.menuOpen = true)} aria-label="Open menu">
              <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={2} stroke-linecap="round" aria-hidden="true">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
          </div>
        </header>
        <div class="body">
          {side ? <aside class="side" aria-label={area === "api" ? "API sections" : "Guides"}>{side}</aside> : null}
          <main id="main" tabIndex={-1}>
            <loom-outlet styles={[pageStyles]}></loom-outlet>
            <footer>
              <span class="grow">
                <GnomeMark size={18} />
                <span>
                  yerd is MIT licensed. {api ? <>These docs were built from main at <code>{api.commit}</code>.</> : null}
                </span>
              </span>
              <a href="https://www.npmjs.com/package/@toyz/yerd" target="_blank" rel="noopener">npm</a>
              <a href="#/guide/design">Design notes</a>
              <a href="https://github.com/Toyz/loom" target="_blank" rel="noopener">Built with loom</a>
            </footer>
          </main>
        </div>
        <dialog class="drawer" aria-label="Menu" onClick={(e: Event) => e.target === e.currentTarget && (this.menuOpen = false)}>
          <div class="drawer-head">
            <a class="brand" href="#/">
              <GnomeMark size={26} />
              <span>yerd</span>
            </a>
            <button class="icon-btn" onClick={() => (this.menuOpen = false)} aria-label="Close menu">
              <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={2} stroke-linecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          <div class="drawer-body">
            <nav class="drawer-links" aria-label="Main">{this.#primaryLinks()}</nav>
            {area === "api" ? this.#apiNav() : this.#guideNav()}
            <div class="drawer-meta">
              <a href="https://github.com/Toyz/yerd" target="_blank" rel="noopener">GitHub</a>
              <a href="https://www.npmjs.com/package/@toyz/yerd" target="_blank" rel="noopener">npm{api?.latest ? ` v${api.latest}` : ""}</a>
            </div>
          </div>
        </dialog>
        <doc-palette></doc-palette>
      </div>
    );
  }
}

function applyTheme(theme: Theme): void {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function currentPath(): string {
  return location.hash.replace(/^#/, "").split("?")[0] || "/";
}
