/**
 * The shell: sidebar (brand, versions, search, guide groups, API sections)
 * and the routed outlet. Groups collapse; the one holding the current page
 * always opens, and what you collapse is remembered between visits.
 */

import { LoomElement, component, css, mount, on, reactive, styles } from "@toyz/loom";
import { RouteChanged } from "@toyz/loom/router";
import { entryId, loadApi, loadGuides, sectionId, type Api, type GuideInfo } from "./data";
import { pageStyles } from "./shared";

const sheet = css`
  :host { display: block; min-height: 100vh; }
  .layout { display: flex; min-height: 100vh; }

  aside {
    position: fixed;
    inset: 0 auto 0 0;
    width: var(--sidebar);
    display: flex;
    flex-direction: column;
    background: var(--bg-raised);
    border-right: 1px solid var(--border);
    z-index: 20;
  }
  .brand { padding: 20px 20px 14px; }
  .brand-row { display: flex; align-items: center; gap: 10px; }
  .brand-row a { display: flex; align-items: center; gap: 10px; color: var(--text); text-decoration: none; }
  .mark {
    width: 30px; height: 30px; border-radius: 7px;
    display: grid; place-items: center;
    background: var(--accent); color: var(--bg);
    font: 700 16px var(--mono);
  }
  .name { font-weight: 700; font-size: 1.15rem; letter-spacing: -0.02em; }
  .versions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; font-family: var(--mono); font-size: 0.7rem; }
  .pill { padding: 3px 7px; border-radius: 999px; border: 1px solid var(--border-strong); color: var(--text-dim); }
  .pill.main { color: var(--accent); border-color: var(--accent-dim); }

  .search { padding: 4px 14px 12px; border-bottom: 1px solid var(--border); }
  input {
    width: 100%;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--border-strong);
    background: var(--bg-sunken);
    color: var(--text);
    font: inherit;
    font-size: 0.88rem;
  }
  input:focus { outline: none; border-color: var(--accent-dim); }

  nav { flex: 1; overflow-y: auto; padding: 10px 0 32px; scrollbar-width: thin; }

  .home-link loom-link::part(anchor) {
    display: flex; align-items: center; gap: 8px;
    margin: 0 12px 6px; padding: 8px 10px; border-radius: 6px;
    color: var(--text); text-decoration: none; font-size: 0.9rem; font-weight: 600;
  }
  .home-link loom-link::part(anchor):hover { background: var(--bg-hover); }
  .home-link.active loom-link::part(anchor) { background: var(--accent-bg); color: var(--accent); }

  .group { margin: 4px 0; }
  .group.divided { margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--border); }
  button.group-title {
    display: flex; align-items: center; justify-content: space-between; width: 100%;
    padding: 7px 20px; border: 0; background: none; cursor: pointer;
    font: 700 0.72rem var(--font); letter-spacing: 0.07em; text-transform: uppercase;
    color: var(--text-faint);
  }
  button.group-title:hover { color: var(--text-dim); }
  button.group-title.current { color: var(--text-dim); }
  .chevron { font-size: 0.8rem; transition: transform 0.15s ease; }
  .closed .chevron { transform: rotate(-90deg); }
  .items { padding-bottom: 4px; }
  .closed .items { display: none; }

  .nav-link loom-link::part(anchor) {
    display: block;
    margin: 0 12px;
    padding: 5px 10px 5px 12px;
    border-radius: 6px;
    color: var(--text-dim);
    text-decoration: none;
    font-size: 0.9rem;
    line-height: 1.4;
  }
  .nav-link loom-link::part(anchor):hover { color: var(--text); background: var(--bg-hover); }
  .nav-link.active loom-link::part(anchor) { color: var(--accent); background: var(--accent-bg); font-weight: 600; }
  .nav-link.featured loom-link::part(anchor)::after { content: " ✦"; color: var(--accent); font-size: 0.75em; }

  .result loom-link::part(anchor) { font-family: var(--mono); font-size: 0.84rem; }
  .result .module { color: var(--text-faint); font-size: 0.72rem; padding: 0 22px 4px; margin-top: -3px; font-family: var(--mono); }
  .hint { padding: 6px 22px; font-size: 0.8rem; color: var(--text-faint); }

  .foot { padding: 12px 20px; border-top: 1px solid var(--border); font-size: 0.78rem; color: var(--text-faint); }
  .foot a { color: var(--text-dim); text-decoration: none; }
  .foot a:hover { color: var(--accent); }

  main { flex: 1; margin-left: var(--sidebar); min-width: 0; }

  .menu {
    display: none;
    position: fixed; top: 12px; left: 12px; z-index: 30;
    width: 38px; height: 38px; border-radius: 8px;
    border: 1px solid var(--border-strong); background: var(--bg-raised); color: var(--text);
    font-size: 18px; cursor: pointer;
  }
  @media (max-width: 900px) {
    aside { transform: translateX(-100%); transition: transform 0.2s ease; box-shadow: 0 0 40px rgba(0, 0, 0, 0.5); }
    aside.open { transform: none; }
    main { margin-left: 0; padding-top: 48px; }
    .menu { display: block; }
  }
`;

const STORE = "yerd-docs:collapsed";
/** Collapsed until opened: the long, less-travelled lists. */
const COLLAPSED_BY_DEFAULT = ["API reference"];

function readCollapsed(): Set<string> {
  try {
    const saved = localStorage.getItem(STORE);
    if (saved) return new Set(JSON.parse(saved) as string[]);
  } catch {
    // storage blocked: fall back to the defaults
  }
  return new Set(COLLAPSED_BY_DEFAULT);
}

function saveCollapsed(collapsed: Set<string>): void {
  try {
    localStorage.setItem(STORE, JSON.stringify([...collapsed]));
  } catch {
    // not remembered this time; harmless
  }
}

@component("yerd-docs")
@styles(sheet)
export class YerdDocs extends LoomElement {
  @reactive accessor path = currentPath();
  @reactive accessor api: Api | undefined = undefined;
  @reactive accessor guides: GuideInfo[] = [];
  @reactive accessor query = "";
  @reactive accessor open = false;
  @reactive accessor collapsed: Set<string> = readCollapsed();

  @mount async load() {
    const [api, guides] = await Promise.all([loadApi(), loadGuides()]);
    this.api = api;
    this.guides = guides;
  }

  @on(RouteChanged) onRoute(event: RouteChanged) {
    this.path = event.path;
    this.open = false;
  }

  #toggle(group: string) {
    const next = new Set(this.collapsed);
    if (next.has(group)) next.delete(group);
    else next.add(group);
    this.collapsed = next;
    saveCollapsed(next);
  }

  #link(to: string, label: string, active = this.path === to, extra = "") {
    return (
      <div class={`nav-link ${active ? "active" : ""} ${extra}`}>
        <loom-link to={to}>{label}</loom-link>
      </div>
    );
  }

  /** A collapsible group; it opens by itself while it holds the current page. */
  #group(title: string, current: boolean, items: unknown[], divided = false) {
    const closed = this.collapsed.has(title) && !current;
    return (
      <div class={`group ${closed ? "closed" : ""} ${divided ? "divided" : ""}`} loom-key={title}>
        <button class={`group-title ${current ? "current" : ""}`} aria-expanded={closed ? "false" : "true"} onClick={() => this.#toggle(title)}>
          <span>{title}</span>
          <span class="chevron">▾</span>
        </button>
        <div class="items">{items}</div>
      </div>
    );
  }

  #results() {
    const q = this.query.trim().toLowerCase();
    const api = this.api!;
    const matches = api.entries
      .filter((e) => e.name.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
      .slice(0, 40);
    const guides = this.guides.filter((g) => g.title.toLowerCase().includes(q)).slice(0, 6);
    if (matches.length === 0 && guides.length === 0) return <div class="hint">Nothing matches “{this.query.trim()}”.</div>;
    return (
      <>
        {guides.length ? (
          <div class="group">
            <div class="hint">Guides</div>
            {guides.map((g) => this.#link(g.slug === "overview" ? "/" : `/guide/${g.slug}`, g.title))}
          </div>
        ) : null}
        {matches.length ? (
          <div class="group">
            <div class="hint">{matches.length === 40 ? "API: first 40 matches" : `API: ${matches.length}`}</div>
            {matches.map((e) => (
              <div class="result" loom-key={entryId(e)}>
                {this.#link(`/api/${entryId(e)}`, e.name)}
                {e.module !== "@toyz/yerd" ? <div class="module">{e.module}</div> : null}
              </div>
            ))}
          </div>
        ) : null}
      </>
    );
  }

  #nav() {
    const api = this.api;
    // Design notes are reachable from the guides that cite them and the footer, not the sidebar.
    const groups = [...new Set(this.guides.map((g) => g.group))].filter((g) => g !== "Design notes");
    const inApi = this.path === "/api" || this.path.startsWith("/api/");
    return (
      <>
        <div class={`home-link ${this.path === "/" ? "active" : ""}`}>
          <loom-link to="/">Home</loom-link>
        </div>
        {groups.map((group) => {
          const items = this.guides.filter((g) => g.group === group && g.slug !== "overview");
          if (items.length === 0) return null;
          const current = items.some((g) => this.path === `/guide/${g.slug}` || this.path.startsWith(`/guide/${g.slug}/`));
          return this.#group(
            group,
            current,
            items.map((g) =>
              this.#link(
                `/guide/${g.slug}`,
                g.title,
                this.path === `/guide/${g.slug}` || this.path.startsWith(`/guide/${g.slug}/`),
                g.slug === "your-first-app" ? "featured" : "",
              ),
            ),
          );
        })}
        {api
          ? this.#group(
              "API reference",
              inApi,
              [this.#link("/api", "All exports"), ...api.sections.map((s) => this.#link(`/api/section/${sectionId(s)}`, s, this.path === `/api/section/${sectionId(s)}`))],
              true,
            )
          : null}
      </>
    );
  }

  update() {
    const api = this.api;
    return (
      <div class="layout">
        <button class="menu" aria-label="Menu" onClick={() => (this.open = !this.open)}>
          ≡
        </button>
        <aside class={this.open ? "open" : ""}>
          <div class="brand">
            <div class="brand-row">
              <a href="#/">
                <div class="mark">y</div>
                <div class="name">yerd</div>
              </a>
            </div>
            {api ? (
              <div class="versions">
                {api.latest ? <span class="pill" title="Latest release on npm">v{api.latest}</span> : null}
                <span class="pill main" title={`These docs were generated from main at ${api.commit}`}>
                  main @ {api.commit}
                </span>
              </div>
            ) : null}
          </div>
          <div class="search">
            <input
              type="search"
              placeholder="Search guides and API…"
              value={this.query}
              onInput={(e: Event) => (this.query = (e.target as HTMLInputElement).value)}
            />
          </div>
          <nav>{api && this.query.trim() ? this.#results() : this.#nav()}</nav>
          <div class="foot">
            <a href="https://github.com/Toyz/yerd" target="_blank" rel="noopener">GitHub</a> ·{" "}
            <a href="https://www.npmjs.com/package/@toyz/yerd" target="_blank" rel="noopener">npm</a> ·{" "}
            <a href="#/guide/design">design notes</a> · built with{" "}
            <a href="https://github.com/Toyz/loom" target="_blank" rel="noopener">loom</a>
          </div>
        </aside>
        <main>
          <loom-outlet styles={[pageStyles]}></loom-outlet>
        </main>
      </div>
    );
  }
}

function currentPath(): string {
  return location.hash.replace(/^#/, "").split("?")[0] || "/";
}
