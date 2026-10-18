/**
 * The reference index: every export, by section, then by kind, as cards with
 * a signature preview. Version badges only where they say something: newer
 * than the first release, or not released yet.
 */

import { LoomElement, component, css, mount, prop, reactive, styles, watch } from "@toyz/loom";
import { route } from "@toyz/loom/router";
import { entryId, loadApi, sectionId, type Api, type Entry } from "../data";
import { KIND_GROUPS, SECTION_INFO } from "../sections";
import { SinceBadge, summary } from "../ui";

const sheet = css`
  .intro { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; margin: 0 0 28px; }
  .intro .lede { margin: 0; flex: 1 1 420px; }
  .guide-link {
    font-size: 0.85rem; white-space: nowrap; padding: 6px 12px; border-radius: 999px;
    border: 1px solid var(--accent-dim); background: var(--accent-bg);
  }
  .guide-link:hover { text-decoration: none; filter: brightness(1.15); }

  section + section { margin-top: 44px; }
  h2.section { display: flex; align-items: baseline; gap: 12px; }
  h2.section a { color: var(--text); }
  .section-blurb { margin: -6px 0 18px; color: var(--text-dim); font-size: 0.92rem; }
  h3.kind { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-faint); margin: 22px 0 10px; font-family: var(--mono); }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
  a.card {
    display: flex; flex-direction: column; gap: 6px; min-width: 0;
    padding: 14px 16px; border-radius: var(--radius);
    border: 1px solid var(--border); background: var(--bg-raised); color: var(--text);
    transition: border-color 0.12s ease, transform 0.12s ease;
  }
  a.card:hover { border-color: var(--accent-dim); text-decoration: none; transform: translateY(-1px); }
  .card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .card-name { font-family: var(--mono); font-weight: 600; font-size: 0.95rem; color: var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-head .badge { margin-left: auto; }
  .card-sig {
    font-family: var(--mono); font-size: 0.74rem; color: var(--text-faint);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .card-doc { font-size: 0.86rem; color: var(--text-dim); line-height: 1.5; margin: 0; }
  .card-module { font-family: var(--mono); font-size: 0.7rem; color: var(--text-faint); }
  .card-parts { font-family: var(--mono); font-size: 0.72rem; color: var(--text-faint); margin-top: 2px; }

  .filters { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 8px; }
  .filters button {
    font: inherit; font-size: 0.8rem; cursor: pointer;
    padding: 4px 11px; border-radius: 999px;
    border: 1px solid var(--border-strong); background: transparent; color: var(--text-dim);
  }
  .filters button.on { color: var(--accent); border-color: var(--accent-dim); background: var(--accent-bg); }
`;

/** One line of the signature, for the card preview. */
function preview(e: Entry): string {
  const first = e.signature.split("\n")[0]!.replace(/\s+/g, " ").trim();
  return first.length > 90 ? `${first.slice(0, 89)}…` : first;
}

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

  #card(e: Entry, first: string | undefined) {
    // "since v<first release>" on everything is noise; badge what's newer or unreleased.
    const since = e.since === first ? undefined : e.since;
    return (
      <a class="card" href={`#/api/${entryId(e)}`} loom-key={entryId(e)}>
        <div class="card-head">
          <span class="card-name">{e.name}</span>
          <SinceBadge since={since} />
          {e.deprecated ? <span class="badge deprecated">deprecated</span> : null}
        </div>
        <div class="card-sig">{preview(e)}</div>
        {e.doc ? <p class="card-doc">{summary(e.doc)}</p> : null}
        {e.parts?.length ? <div class="card-parts">with {e.parts.join(", ")}</div> : null}
        {e.module !== "@toyz/yerd" ? <div class="card-module">{e.module}</div> : null}
      </a>
    );
  }

  update() {
    const api = this.api;
    if (!api) return <p class="loading">Loading…</p>;
    const sections = this.only ? api.sections.filter((s) => sectionId(s) === this.only) : api.sections;
    if (sections.length === 0) return <p>No such section.</p>;
    const first = api.released[0];
    const single = this.only ? sections[0]! : undefined;
    const info = single ? SECTION_INFO[single] : undefined;
    const kinds = KIND_GROUPS.filter((g) => !this.kind || g.kinds.includes(this.kind));
    return (
      <div>
        <h1>{single ?? "API reference"}</h1>
        <div class="intro">
          <p class="lede">
            {info?.blurb ??
              `Every public export, generated from src/ on main (${api.commit}). Badges mark what's newer than v${first ?? "?"} or not released yet.`}
          </p>
          {info?.guide ? (
            <a class="guide-link" href={`#/guide/${info.guide}`}>
              Read the guide →
            </a>
          ) : null}
        </div>
        {single ? null : (
          <div class="filters">
            <button class={this.kind === "" ? "on" : ""} onClick={() => (this.kind = "")}>all</button>
            {["function", "class", "const", "interface", "type"].map((k) => (
              <button class={this.kind === k ? "on" : ""} onClick={() => (this.kind = k)}>{k}</button>
            ))}
          </div>
        )}
        {sections.map((section) => {
          // Types documented on another export's page are listed with it (card-parts), not on their own.
          const inSection = api.entries.filter((e) => e.section === section && !e.partOf);
          const groups = kinds.map((g) => ({ ...g, entries: inSection.filter((e) => g.kinds.includes(e.kind)) })).filter((g) => g.entries.length);
          if (groups.length === 0) return null;
          return (
            <section loom-key={section}>
              {single ? null : (
                <>
                  <h2 class="section" id={sectionId(section)}>
                    <a href={`#/api/section/${sectionId(section)}`}>{section}</a>
                  </h2>
                  {SECTION_INFO[section] ? <p class="section-blurb">{SECTION_INFO[section]!.blurb}</p> : null}
                </>
              )}
              {groups.map((g) => (
                <div loom-key={g.title}>
                  <h3 class="kind">{g.title}</h3>
                  <div class="grid">{g.entries.map((e) => this.#card(e, first))}</div>
                </div>
              ))}
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
