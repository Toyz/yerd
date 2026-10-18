/** The reference index: every export, by section, with kind and version badges. */

import { LoomElement, component, css, mount, prop, reactive, styles, watch } from "@toyz/loom";
import { route } from "@toyz/loom/router";
import { entryId, loadApi, sectionId, type Api } from "../data";
import { KindBadge, SinceBadge, summary } from "../ui";

const sheet = css`
  .filters { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 24px; }
  .filters button {
    font: inherit; font-size: 0.8rem; cursor: pointer;
    padding: 4px 10px; border-radius: 999px;
    border: 1px solid var(--border-strong); background: transparent; color: var(--text-dim);
  }
  .filters button.on { color: var(--accent); border-color: var(--accent-dim); background: var(--accent-bg); }
  .rows { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .row {
    display: grid; grid-template-columns: minmax(180px, 260px) 1fr; gap: 6px 18px;
    padding: 10px 14px; border-bottom: 1px solid var(--border); align-items: baseline;
  }
  .row:last-child { border-bottom: 0; }
  .row:hover { background: var(--bg-raised); }
  .row a { font-family: var(--mono); font-size: 0.9rem; }
  .meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .meta .module { font-family: var(--mono); font-size: 0.72rem; color: var(--text-faint); }
  .desc { grid-column: 1 / -1; color: var(--text-dim); font-size: 0.86rem; margin: 0; }
  @media (max-width: 640px) { .row { grid-template-columns: 1fr; } }
`;

const KINDS = ["class", "function", "const", "interface", "type"] as const;

@route("/api")
@component("page-api")
@styles(sheet)
export class PageApi extends LoomElement {
  @reactive accessor api: Api | undefined = undefined;
  @reactive accessor kind = "";

  /** Which section to show; "" for all. The section route sets it. */
  get only(): string {
    return "";
  }

  @mount async load() {
    window.scrollTo(0, 0);
    this.api = await loadApi();
  }

  update() {
    const api = this.api;
    if (!api) return <p class="loading">Loading…</p>;
    const sections = this.only ? api.sections.filter((s) => sectionId(s) === this.only) : api.sections;
    if (sections.length === 0) return <p>No such section.</p>;
    const entries = api.entries.filter((e) => !this.kind || e.kind === this.kind);
    return (
      <div>
        <h1>{this.only ? sections[0] : "API reference"}</h1>
        <p class="lede">
          Generated from <code>src/</code> on main ({api.commit}). Badges show the release each export first shipped in, from{" "}
          {api.released.length ? api.released.map((v) => `v${v}`).join(", ") : "no releases yet"}.
        </p>
        <div class="filters">
          <button class={this.kind === "" ? "on" : ""} onClick={() => (this.kind = "")}>all</button>
          {KINDS.map((k) => (
            <button class={this.kind === k ? "on" : ""} onClick={() => (this.kind = k)}>{k}</button>
          ))}
        </div>
        {sections.map((section) => {
          const rows = entries.filter((e) => e.section === section);
          if (rows.length === 0) return null;
          return (
            <section loom-key={section}>
              {this.only ? null : <h2 id={sectionId(section)}>{section}</h2>}
              <div class="rows">
                {rows.map((e) => (
                  <div class="row" loom-key={entryId(e)}>
                    <a href={`#/api/${entryId(e)}`}>{e.name}</a>
                    <div class="meta">
                      <KindBadge kind={e.kind} />
                      <SinceBadge since={e.since} />
                      {e.deprecated ? <span class="badge deprecated">deprecated</span> : null}
                      {e.module !== "@toyz/yerd" ? <span class="module">{e.module}</span> : null}
                    </div>
                    {e.doc ? <p class="desc">{summary(e.doc)}</p> : null}
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    );
  }
}

@route("/api/section/:section")
@component("page-api-section")
export class PageApiSection extends PageApi {
  @prop({ param: "section" }) accessor section = "";

  override get only(): string {
    return this.section;
  }

  @watch("section") onSection() {
    if (this.isConnected) {
      window.scrollTo(0, 0);
      this.scheduleUpdate();
    }
  }
}
