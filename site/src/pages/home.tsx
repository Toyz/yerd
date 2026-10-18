/** Overview: what yerd is (the README), plus where the reference stands. */

import { LoomElement, component, css, mount, reactive, styles } from "@toyz/loom";
import { route } from "@toyz/loom/router";
import { entryId, linkContext, loadApi, loadGuide, loadGuides, type Api, type GuideInfo } from "../data";
import { Code, Markdown, SinceBadge } from "../ui";

const sheet = css`
  .hero { margin-bottom: 28px; }
  .tagline { font-size: 1.15rem; color: var(--text-dim); max-width: 640px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 24px 0 8px; }
  .stat { border: 1px solid var(--border); background: var(--bg-raised); border-radius: var(--radius); padding: 14px 16px; }
  .stat b { display: block; font-size: 1.5rem; color: var(--text); font-family: var(--mono); letter-spacing: -0.02em; }
  .stat span { font-size: 0.8rem; color: var(--text-faint); }
  .unreleased { margin: 20px 0 0; padding: 14px 16px; border: 1px solid rgba(232, 196, 106, 0.35); background: var(--warn-bg); border-radius: var(--radius); }
  .unreleased p { margin: 0 0 8px; color: var(--text); }
  .unreleased a { margin-right: 10px; font-family: var(--mono); font-size: 0.85rem; }
`;

@route("/")
@component("page-home")
@styles(sheet)
export class PageHome extends LoomElement {
  @reactive accessor api: Api | undefined = undefined;
  @reactive accessor guides: GuideInfo[] = [];
  @reactive accessor readme = "";
  @reactive accessor error = "";

  @mount async load() {
    window.scrollTo(0, 0);
    try {
      const [api, guides, readme] = await Promise.all([loadApi(), loadGuides(), loadGuide("overview")]);
      this.api = api;
      this.guides = guides;
      // The hero already says what the README's title, badges and first paragraph say.
      this.readme = readme.replace(/^#[^\n]*\n+(\[!\[[^\n]*\n)*\n*[^\n#`][\s\S]*?\n\n/, "");
    } catch (error) {
      this.error = String(error);
    }
  }

  update() {
    if (this.error) return <p class="error">{this.error}</p>;
    const api = this.api;
    if (!api) return <p class="loading">Loading…</p>;
    const unreleased = api.entries.filter((e) => e.since === null);
    const newMembers = api.entries.flatMap((e) => (e.members ?? []).filter((m) => m.since === null).map((m) => ({ e, m })));
    return (
      <div>
        <div class="hero">
          <h1>yerd</h1>
          <p class="tagline">
            A TypeScript web server for Node where routes are decorated classes, TSX is the template engine, and a handler can return
            anything. Zero runtime dependencies.
          </p>
          <Code code={"npm install @toyz/yerd"} lang="sh" />
          <div class="stats">
            <div class="stat">
              <b>{api.entries.length}</b>
              <span>public exports</span>
            </div>
            <div class="stat">
              <b>{api.sections.length}</b>
              <span>reference sections</span>
            </div>
            <div class="stat">
              <b>{api.latest ? `v${api.latest}` : "none"}</b>
              <span>latest on npm</span>
            </div>
            <div class="stat">
              <b>{unreleased.length + newMembers.length}</b>
              <span>unreleased on main</span>
            </div>
          </div>
          {unreleased.length + newMembers.length > 0 ? (
            <div class="unreleased">
              <p>
                On main, not released yet <SinceBadge since={null} />
              </p>
              {unreleased.map((e) => (
                <a href={`#/api/${entryId(e)}`}>{e.name}</a>
              ))}
              {newMembers.map(({ e, m }) => (
                <a href={`#/api/${entryId(e)}`}>
                  {e.name}.{m.name}
                </a>
              ))}
            </div>
          ) : null}
        </div>
        <Markdown class="prose readme" text={this.readme} ctx={linkContext(api, this.guides, "overview")} />
      </div>
    );
  }
}
