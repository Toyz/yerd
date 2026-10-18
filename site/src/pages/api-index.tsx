/**
 * The reference index: every export by section, one compact row each (kind
 * tag, name, first sentence), filtered as you type. Version badges only where
 * they say something: newer than the first release, or not released yet.
 */

import { LoomElement, component, css, mount, prop, reactive, styles, watch } from "@toyz/loom";
import { route } from "@toyz/loom/router";
import { entryId, loadApi, sectionId, type Api, type Entry } from "../data";
import { SECTION_INFO } from "../sections";
import { KindBadge, SinceBadge, summary } from "../ui";

const sheet = css`
  .page { max-width: 1080px; }
  .head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 24px; }
  .head h1 { margin-bottom: 8px; }
  .guide-link { font-weight: 700; white-space: nowrap; }
  .lede { margin-bottom: 26px; }

  .tools {
    position: sticky; top: var(--top); z-index: 5;
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px;
    padding: 12px 0; margin: 0 0 8px;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
  }
  .filter { position: relative; flex: 1 1 280px; max-width: 380px; }
  .filter svg { position: absolute; left: 11px; top: 50%; margin-top: -8px; color: var(--text-faint); pointer-events: none; }
  .filter input {
    width: 100%; padding: 8px 12px 8px 34px;
    font: inherit; font-size: 0.95rem; color: var(--text);
    background: var(--bg-raised); border: 1px solid var(--border-strong); border-radius: 6px;
  }
  .filter input::placeholder { color: var(--text-faint); }
  .filter input:focus { outline: 2px solid var(--hat); outline-offset: 0; border-color: transparent; }
  .kinds { display: flex; gap: 4px; flex-wrap: wrap; }
  .kinds button {
    font: inherit; font-size: 0.86rem; cursor: pointer;
    padding: 4px 11px; border-radius: 999px;
    border: 1px solid transparent; background: none; color: var(--text-dim);
  }
  .kinds button:hover { color: var(--text); background: var(--bg-hover); }
  .kinds button[aria-pressed="true"] { color: var(--text); border-color: var(--border-strong); background: var(--bg-raised); font-weight: 700; }
  .count { font-size: 0.85rem; color: var(--text-faint); margin-left: auto; white-space: nowrap; }

  section { margin-top: 36px; }
  section h2 { margin: 0 0 4px; font-size: 1.5rem; scroll-margin-top: calc(var(--top) + 70px); }
  section h2 a { color: var(--text); text-decoration: none; }
  section h2 a:hover { color: var(--accent); }
  .blurb { margin: 0 0 12px; font-size: 0.95rem; max-width: var(--measure); }
  .blurb a { white-space: nowrap; }

  ul.rows { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 32px; border-top: 1px solid var(--border); }
  ul.rows li { margin: 0; border-bottom: 1px solid var(--border); min-width: 0; }
  a.row {
    display: grid; grid-template-columns: 5.6rem minmax(0, 1fr); column-gap: 10px; align-items: baseline;
    padding: 9px 6px; color: var(--text); text-decoration: none; border-radius: 4px;
  }
  a.row:hover { background: var(--bg-hover); }
  a.row:hover .name { color: var(--accent); }
  a.row:hover .tag { --hole: var(--bg-hover); }
  .row .tag { justify-self: start; transform: translateY(3px); }
  .name-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .name { font: 600 0.95rem var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .module { font: 0.75rem var(--mono); color: var(--text-faint); white-space: nowrap; }
  .doc { grid-column: 2; font-size: 0.86rem; color: var(--text-dim); line-height: 1.45; margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .parts { grid-column: 2; font: 0.74rem var(--mono); color: var(--text-faint); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .none { padding: 40px 0; color: var(--text-dim); }
  .none button { font: inherit; color: var(--accent); background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }

  @media (max-width: 900px) {
    ul.rows { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 560px) {
    .tools { position: static; }
    .count { margin-left: 0; }
    a.row { grid-template-columns: minmax(0, 1fr); }
    .row .tag { grid-row: 1; transform: none; margin-bottom: 4px; }
    .doc, .parts { grid-column: 1; }
  }
`;

const KINDS: Array<{ id: string; label: string; kinds: string[] }> = [
  { id: "", label: "All", kinds: [] },
  { id: "function", label: "Functions", kinds: ["function"] },
  { id: "class", label: "Classes", kinds: ["class"] },
  { id: "const", label: "Constants", kinds: ["const"] },
  { id: "type", label: "Types", kinds: ["interface", "type", "enum", "other"] },
  { id: "new", label: "New on main", kinds: [] },
];

/** Kind order inside a section: things you call first, then types. */
const KIND_ORDER: Record<string, number> = { function: 0, class: 1, const: 2, interface: 3, type: 4, enum: 5, other: 6 };

@route("/api")
@component("page-api")
@styles(sheet)
export class PageApi extends LoomElement {
  @reactive accessor api: Api | undefined = undefined;
  @reactive accessor kind = "";
  @reactive accessor text = "";

  /** Which section to show; "" for all. The section route sets it. */
  get only(): string {
    return "";
  }

  @mount async load() {
    window.scrollTo(0, 0);
    this.api = await loadApi();
  }

  #matches(e: Entry, tokens: string[]): boolean {
    const kind = KINDS.find((k) => k.id === this.kind)!;
    if (kind.id === "new" && e.since !== null && !(e.members ?? []).some((m) => m.since === null)) return false;
    if (kind.kinds.length && !kind.kinds.includes(e.kind)) return false;
    if (tokens.length === 0) return true;
    const name = e.name.toLowerCase();
    const rest = `${e.module} ${e.section} ${(e.members ?? []).map((m) => m.name).join(" ")}`.toLowerCase();
    return tokens.every((t) => name.includes(t) || rest.includes(t));
  }

  #row(e: Entry, first: string | undefined) {
    // "since v<first release>" on everything is noise; badge what's newer or unreleased.
    const since = e.since === first ? undefined : e.since;
    const doc = summary(e.doc);
    return (
      <li loom-key={entryId(e)}>
        <a class="row" href={`#/api/${entryId(e)}`}>
          <KindBadge kind={e.kind} />
          <span class="name-line">
            <span class="name">{e.name}</span>
            <SinceBadge since={since} />
            {e.deprecated ? <span class="badge deprecated">deprecated</span> : null}
            {e.module !== "@toyz/yerd" ? <span class="module">{e.module.replace("@toyz/yerd", "")}</span> : null}
          </span>
          {doc ? <span class="doc">{doc}</span> : null}
          {e.parts?.length ? <span class="parts">with {e.parts.join(", ")}</span> : null}
        </a>
      </li>
    );
  }

  update() {
    const api = this.api;
    if (!api) return <p class="loading">Loading…</p>;
    const sections = this.only ? api.sections.filter((s) => sectionId(s) === this.only) : api.sections;
    if (sections.length === 0) return <p>No such section. <a href="#/api">All exports</a></p>;
    const first = api.released[0];
    const single = this.only ? sections[0]! : undefined;
    const info = single ? SECTION_INFO[single] : undefined;
    const tokens = this.text.toLowerCase().split(/\s+/).filter(Boolean);
    const searching = tokens.length > 0 || this.kind !== "";
    const hasNew = api.entries.some((e) => e.since === null || (e.members ?? []).some((m) => m.since === null));
    let shown = 0;
    let total = 0;
    const blocks = sections.map((section) => {
      // Types documented on another export's page are listed with it ("with ..."), unless you're searching.
      const inSection = api.entries.filter((e) => e.section === section && (searching || !e.partOf));
      total += inSection.length;
      const entries = inSection.filter((e) => this.#matches(e, tokens)).sort((a, b) => KIND_ORDER[a.kind]! - KIND_ORDER[b.kind]! || a.name.localeCompare(b.name));
      shown += entries.length;
      if (entries.length === 0) return null;
      const blurb = SECTION_INFO[section];
      return (
        <section loom-key={section}>
          {single ? null : (
            <>
              <h2 id={sectionId(section)}>
                <a href={`#/api/section/${sectionId(section)}`}>{section}</a>
              </h2>
              {blurb ? (
                <p class="blurb">
                  {blurb.blurb} {blurb.guide ? <a href={`#/guide/${blurb.guide}`}>Read the guide</a> : null}
                </p>
              ) : null}
            </>
          )}
          <ul class="rows">{entries.map((e) => this.#row(e, first))}</ul>
        </section>
      );
    });
    return (
      <div class="page">
        <div class="head">
          <h1>{single ?? "API reference"}</h1>
          {info?.guide ? (
            <a class="guide-link" href={`#/guide/${info.guide}`}>
              Read the guide
            </a>
          ) : null}
        </div>
        <p class="lede">
          {info?.blurb ??
            `Every public export, generated from the source on main. Each page has the signature, the docs, examples and a link to the code.`}
        </p>
        <div class="tools">
          <label class="filter">
            <span class="visually-hidden">Filter exports</span>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={2.2} stroke-linecap="round" aria-hidden="true">
              <circle cx={11} cy={11} r={7} />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              type="search"
              placeholder={single ? `Filter ${single}` : "Filter by name or member"}
              value={this.text}
              onInput={(e: Event) => (this.text = (e.target as HTMLInputElement).value)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === "Escape") this.text = "";
              }}
            />
          </label>
          <div class="kinds" role="group" aria-label="Kind">
            {KINDS.filter((k) => k.id !== "new" || hasNew).map((k) => (
              <button type="button" aria-pressed={this.kind === k.id ? "true" : "false"} onClick={() => (this.kind = k.id)}>
                {k.label}
              </button>
            ))}
          </div>
          <span class="count" aria-live="polite">
            {searching ? `${shown} of ${total}` : `${total} exports`}
          </span>
        </div>
        {shown === 0 ? (
          <p class="none">
            Nothing matches. <button type="button" onClick={() => { this.text = ""; this.kind = ""; }}>Clear the filter</button>, or try the
            search (it looks in guides too).
          </p>
        ) : (
          blocks
        )}
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
      this.text = "";
      this.scheduleUpdate();
    }
  }
}
