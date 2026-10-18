/**
 * The shell: sidebar (brand, version, search, guides, API sections) and the
 * routed outlet.
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
  .brand { padding: 22px 20px 16px; border-bottom: 1px solid var(--border); }
  .brand-row { display: flex; align-items: center; gap: 10px; }
  .mark {
    width: 30px; height: 30px; border-radius: 7px;
    display: grid; place-items: center;
    background: var(--accent); color: var(--bg);
    font: 700 16px var(--mono);
  }
  .name { font-weight: 700; font-size: 1.15rem; letter-spacing: -0.02em; }
  .name a { color: var(--text); text-decoration: none; }
  .versions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; font-family: var(--mono); font-size: 0.72rem; }
  .pill { padding: 3px 7px; border-radius: 999px; border: 1px solid var(--border-strong); color: var(--text-dim); }
  .pill.main { color: var(--accent); border-color: var(--accent-dim); }

  .search { padding: 12px 14px; border-bottom: 1px solid var(--border); }
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

  nav { flex: 1; overflow-y: auto; padding: 8px 0 32px; scrollbar-width: thin; }
  .group { margin-top: 14px; }
  .group-title {
    padding: 4px 20px;
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .nav-link loom-link::part(anchor) {
    display: block;
    padding: 5px 20px;
    color: var(--text-dim);
    text-decoration: none;
    font-size: 0.9rem;
    border-left: 2px solid transparent;
  }
  .nav-link loom-link::part(anchor):hover { color: var(--text); background: var(--bg-hover); }
  .nav-link.active loom-link::part(anchor) { color: var(--accent); border-left-color: var(--accent); background: var(--accent-bg); }
  .result loom-link::part(anchor) { font-family: var(--mono); font-size: 0.84rem; }
  .result .module { color: var(--text-faint); font-size: 0.72rem; padding: 0 20px 4px; margin-top: -3px; }

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

@component("yerd-docs")
@styles(sheet)
export class YerdDocs extends LoomElement {
  @reactive accessor path = currentPath();
  @reactive accessor api: Api | undefined = undefined;
  @reactive accessor guides: GuideInfo[] = [];
  @reactive accessor query = "";
  @reactive accessor open = false;

  @mount async load() {
    const [api, guides] = await Promise.all([loadApi(), loadGuides()]);
    this.api = api;
    this.guides = guides;
  }

  @on(RouteChanged) onRoute(event: RouteChanged) {
    this.path = event.path;
    this.open = false;
  }

  #link(to: string, label: string, active = this.path === to) {
    return (
      <div class={`nav-link ${active ? "active" : ""}`}>
        <loom-link to={to}>{label}</loom-link>
      </div>
    );
  }

  #results() {
    const q = this.query.trim().toLowerCase();
    const matches = this.api!.entries
      .filter((e) => e.name.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
      .slice(0, 40);
    if (matches.length === 0) return <div class="group-title">No matches</div>;
    return (
      <div class="group">
        <div class="group-title">{matches.length === 40 ? "First 40 matches" : `${matches.length} matches`}</div>
        {matches.map((e) => (
          <div class="result" loom-key={entryId(e)}>
            {this.#link(`/api/${entryId(e)}`, e.name)}
            <div class="module">{e.module}</div>
          </div>
        ))}
      </div>
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
              <div class="mark">y</div>
              <div class="name">
                <a href="#/">yerd</a>
              </div>
            </div>
            {api ? (
              <div class="versions">
                <span class="pill main" title={`Generated from main at ${api.commit}`}>
                  main @ {api.commit}
                </span>
                {api.latest ? <span class="pill" title="Latest release on npm">npm v{api.latest}</span> : null}
              </div>
            ) : null}
          </div>
          <div class="search">
            <input
              type="search"
              placeholder="Search the API…"
              value={this.query}
              onInput={(e: Event) => (this.query = (e.target as HTMLInputElement).value)}
            />
          </div>
          <nav>
            {api && this.query.trim() ? (
              this.#results()
            ) : (
              <>
                {(["Start", "Guides", "Design notes"] as const).map((group) => {
                  const items = this.guides.filter((g) => g.group === group);
                  if (items.length === 0) return null;
                  return (
                    <div class="group" loom-key={group}>
                      {group === "Start" ? null : <div class="group-title">{group}</div>}
                      {items.map((g) =>
                        g.slug === "overview"
                          ? this.#link("/", g.title)
                          : this.#link(`/guide/${g.slug}`, g.title, this.path === `/guide/${g.slug}` || this.path.startsWith(`/guide/${g.slug}/`)),
                      )}
                    </div>
                  );
                })}
                {api ? (
                  <div class="group">
                    <div class="group-title">API reference</div>
                    {this.#link("/api", "All exports")}
                    {api.sections.map((s) => this.#link(`/api/section/${sectionId(s)}`, s))}
                  </div>
                ) : null}
              </>
            )}
          </nav>
          <div class="foot">
            <a href="https://github.com/Toyz/yerd" target="_blank" rel="noopener">GitHub</a> ·{" "}
            <a href="https://www.npmjs.com/package/@toyz/yerd" target="_blank" rel="noopener">npm</a> · built with{" "}
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
