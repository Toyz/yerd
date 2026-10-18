/**
 * One export: the signature up top with its import line, the docs and
 * examples, a compact list of its members followed by each one in full, and
 * the types that belong to it.
 */

import { LoomElement, component, css, mount, prop, reactive, styles, watch } from "@toyz/loom";
import { route } from "@toyz/loom/router";
import { entryId, linkContext, loadApi, loadGuides, resolveApi, sectionId, sourceUrl, type Api, type Entry, type GuideInfo, type Member } from "../data";
import { SECTION_INFO } from "../sections";
import { Code, KindBadge, Markdown, SinceBadge, onCopyClick, summary } from "../ui";

const sheet = css`
  article { max-width: 880px; }
  .crumbs { font-size: 0.88rem; color: var(--text-faint); margin-bottom: 12px; }
  .crumbs a { color: var(--text-faint); text-decoration: none; }
  .crumbs a:hover { color: var(--accent); text-decoration: underline; }
  .title { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
  .title h1 { font-family: var(--mono); font-weight: 600; font-size: clamp(1.6rem, 1.3rem + 1.2vw, 2.1rem); letter-spacing: -0.01em; margin: 0; overflow-wrap: anywhere; }
  .facts { display: flex; gap: 6px 20px; flex-wrap: wrap; font-size: 0.88rem; color: var(--text-faint); margin: 0 0 22px; }
  .facts code { background: none; padding: 0; color: var(--text-dim); }
  .facts a { color: var(--text-dim); }

  /* The signature is the page's headline. */
  .sig { border: 1px solid var(--border-strong); border-radius: 8px; overflow: hidden; margin: 0 0 28px; background: var(--code-bg); }
  .sig .import { display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 18px; border-bottom: 1px solid var(--border); background: var(--bg-raised); }
  .sig .import pre.code { flex: 1; margin: 0; padding: 0; border: 0; background: none; font-size: 0.8rem; color: var(--text-dim); }
  .sig .import button {
    font: 700 0.75rem var(--font); padding: 4px 10px; border-radius: 4px; cursor: pointer; flex: none;
    border: 1px solid var(--border-strong); background: var(--bg); color: var(--text-dim);
  }
  .sig .import button:hover { color: var(--accent); border-color: var(--accent-dim); }
  .sig pre.signature { margin: 0; border: 0; border-radius: 0; font-size: 0.95rem; padding: 18px; }

  .deprecated-note { border-left: 3px solid var(--danger); background: var(--danger-bg); color: var(--text); padding: 8px 14px; border-radius: 0 var(--radius) var(--radius) 0; margin: 12px 0; }
  .empty { color: var(--text-faint); font-style: italic; }
  h2 .count { color: var(--text-faint); font-family: var(--font); font-size: 0.95rem; margin-left: 4px; }

  /* Members: an index you can scan, then each one in full. */
  ul.index { list-style: none; margin: 0 0 28px; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 28px; border-top: 1px solid var(--border); }
  ul.index li { margin: 0; border-bottom: 1px solid var(--border); min-width: 0; }
  ul.index a { display: flex; align-items: baseline; gap: 10px; padding: 7px 4px; text-decoration: none; color: var(--text); min-width: 0; }
  ul.index a:hover { background: var(--bg-hover); }
  ul.index a:hover .m-name { color: var(--accent); }
  .m-name { font: 600 0.88rem var(--mono); white-space: nowrap; }
  .m-kind { font-size: 0.78rem; color: var(--text-faint); white-space: nowrap; }
  .m-doc { font-size: 0.84rem; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }

  .member { padding: 18px 0 8px; border-top: 1px solid var(--border); scroll-margin-top: calc(var(--top) + 16px); }
  .member.target { border-top: 2px solid var(--hat); }
  .member-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .member-head h3 { font-family: var(--mono); font-size: 1.02rem; font-weight: 600; margin: 0; }
  .member-head h3 a { color: inherit; text-decoration: none; }
  .member-head h3 a:hover { color: var(--accent); text-decoration: underline; }
  .member-head .kind { font-size: 0.8rem; color: var(--text-faint); }
  .src { margin-left: auto; font-size: 0.82rem; color: var(--text-faint) !important; }
  .member pre.signature { margin: 10px 0 12px; font-size: 0.84rem; }
  .member .prose { font-size: 0.98rem; }
  .member .prose p:first-child { margin-top: 4px; }

  .part { margin: 18px 0; padding: 4px 22px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-raised); scroll-margin-top: calc(var(--top) + 16px); }
  .part.target { border-color: var(--hat); }
  .part-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
  .part-head h3 { font-family: var(--mono); font-size: 1.12rem; font-weight: 600; margin: 0; }
  .part-head h3 a { color: inherit; text-decoration: none; }
  .part .tag { --hole: var(--bg-raised); }
  .part .member:first-of-type { margin-top: 8px; }

  @media (max-width: 760px) {
    ul.index { grid-template-columns: minmax(0, 1fr); }
    .sig pre.signature { font-size: 0.86rem; padding: 14px; }
    .sig .import { padding-left: 14px; }
    .part { padding: 2px 14px 10px; }
  }
`;

/**
 * Exported interfaces and object types a function's (or const's) signature
 * names, other than itself: shown on its page so `yerd(options?: YerdOptions)`
 * lists the options right there. Class pages skip this: their members' types
 * would pull in half the API.
 */
function usedTypes(entry: Entry, api: Api): Entry[] {
  if (entry.kind !== "function" && entry.kind !== "const") return [];
  const found: Entry[] = [];
  for (const other of api.entries) {
    if (other === entry || other.module !== entry.module) continue;
    if ((other.kind !== "interface" && other.kind !== "type") || !other.members?.length) continue;
    if (new RegExp(`(^|[^\\w$.])${other.name.replace(/[$]/g, "\\$&")}(?![\\w$])`).test(entry.signature)) found.push(other);
  }
  return found;
}

const MEMBER_ORDER: Record<Member["kind"], number> = { constructor: 0, property: 1, accessor: 2, method: 3, index: 4 };

@route("/api/:id")
@component("page-api-entry")
@styles(sheet)
export class PageApiEntry extends LoomElement {
  @prop({ param: "id" }) accessor id = "";
  @reactive accessor api: Api | undefined = undefined;
  @reactive accessor guides: GuideInfo[] = [];
  @reactive accessor copied = false;

  /** A member to scroll to (the member route sets it). */
  get focusMember(): string {
    return "";
  }

  @mount async load() {
    window.scrollTo(0, 0);
    const [api, guides] = await Promise.all([loadApi(), loadGuides()]);
    this.api = api;
    this.guides = guides;
    this.scrollToFocus();
  }

  @watch("id") onId() {
    if (this.isConnected) {
      window.scrollTo(0, 0);
      this.scrollToFocus();
    }
  }

  scrollToFocus() {
    const part = this.#partFocus();
    if (!this.focusMember && !part) return;
    requestAnimationFrame(() => this.shadow.getElementById(part ? `p-${part}` : `m-${this.focusMember}`)?.scrollIntoView({ block: "start" }));
  }

  /** The route names a type documented on another export's page: that type. */
  #partFocus(): string | undefined {
    return this.api?.entries.find((e) => entryId(e) === this.id)?.partOf ? this.id.slice(this.id.indexOf(".") + 1) : undefined;
  }

  #linker(api: Api, self: string) {
    return (name: string) => {
      const id = resolveApi(api, name);
      return id && id !== self ? id : undefined;
    };
  }

  /** The members as one scannable list, each linking to its full entry below. */
  #index(members: Member[], self: string) {
    if (members.length < 4) return null;
    return (
      <ul class="index">
        {members.map((m) => (
          <li loom-key={`${m.static ? "static " : ""}${m.name}`}>
            <a href={`#/api/${self}/${m.name}`}>
              <span class="m-name">
                {m.static ? "static " : ""}
                {m.name}
              </span>
              <span class="m-kind">{m.kind}</span>
              <span class="m-doc">{summary(m.doc)}</span>
            </a>
          </li>
        ))}
      </ul>
    );
  }

  /** A type documented on this page: its signature, docs, examples and members. */
  #part(part: Entry, api: Api, focused: boolean) {
    const self = entryId(part);
    const ctx = linkContext(api, this.guides, undefined, self);
    const members = [...(part.members ?? [])].sort((a, b) => MEMBER_ORDER[a.kind] - MEMBER_ORDER[b.kind]);
    return (
      <section class={`part ${focused ? "target" : ""}`} id={`p-${part.name}`} loom-key={part.name}>
        <div class="part-head">
          <h3>
            <a href={`#/api/${self}`}>{part.name}</a>
          </h3>
          <KindBadge kind={part.kind} />
          <SinceBadge since={part.since} />
          <a class="src" href={sourceUrl(api, part.source.file, part.source.line)} target="_blank" rel="noopener">
            Source
          </a>
        </div>
        <Code class="signature" code={part.signature} link={this.#linker(api, self)} />
        {part.doc ? <Markdown text={part.doc} ctx={ctx} /> : null}
        {(part.examples ?? []).map((ex) => (
          <Code code={ex} />
        ))}
        {this.#index(members, self)}
        {members.map((m) => this.#member(m, part, api))}
      </section>
    );
  }

  #member(m: Member, entry: Entry, api: Api) {
    const self = entryId(entry);
    const ctx = linkContext(api, this.guides, undefined, `${self}/${m.name}`);
    return (
      <div class={`member ${m.name === this.focusMember ? "target" : ""}`} id={`m-${m.name}`} loom-key={`${m.static ? "static " : ""}${m.name}`}>
        <div class="member-head">
          <h3>
            <a href={`#/api/${self}/${m.name}`}>
              {m.static ? "static " : ""}
              {m.name}
            </a>
          </h3>
          <span class="kind">{m.kind}</span>
          <SinceBadge since={m.since} />
          {m.deprecated ? <span class="badge deprecated">deprecated</span> : null}
          {m.line ? (
            <a class="src" href={sourceUrl(api, entry.source.file, m.line)} target="_blank" rel="noopener">
              Source
            </a>
          ) : null}
        </div>
        <Code class="signature" code={m.signature} link={this.#linker(api, self)} />
        {m.deprecated ? <div class="deprecated-note">{m.deprecated}</div> : null}
        {m.doc ? <Markdown text={m.doc} ctx={ctx} /> : null}
        {(m.examples ?? []).map((ex) => (
          <Code code={ex} />
        ))}
      </div>
    );
  }

  #copyImport(line: string) {
    void navigator.clipboard?.writeText(line).then(() => {
      this.copied = true;
      setTimeout(() => (this.copied = false), 1200);
    });
  }

  update() {
    const api = this.api;
    if (!api) return <p class="loading">Loading…</p>;
    const asked = api.entries.find((e) => entryId(e) === this.id);
    // A companion type's id shows its owner's page, scrolled to it.
    const entry = asked?.partOf ? (api.entries.find((e) => entryId(e) === asked.partOf) ?? asked) : asked;
    const focusPart = asked && asked !== entry ? asked.name : undefined;
    if (!entry) {
      return (
        <div>
          <h1>Not found</h1>
          <p>
            No export is called <code>{this.id}</code>. Try the <a href="#/api">API index</a> or the search.
          </p>
        </div>
      );
    }
    const self = entryId(entry);
    const ctx = linkContext(api, this.guides, undefined, self);
    const members = [...(entry.members ?? [])].sort((a, b) => MEMBER_ORDER[a.kind] - MEMBER_ORDER[b.kind]);
    const typeOnly = entry.kind === "interface" || entry.kind === "type";
    const importLine = `import { ${typeOnly ? `type ${entry.name}` : entry.name} } from "${entry.module}";`;
    const guide = SECTION_INFO[entry.section]?.guide;
    // Types this page owns (only it uses them), then shared types its own
    // signature takes (yerd(options?: YerdOptions)), each with its members.
    const owned = (entry.parts ?? [])
      .map((name) => api.entries.find((e) => e.module === entry.module && e.name === name))
      .filter((part): part is Entry => part !== undefined);
    const used = usedTypes(entry, api).filter((t) => !owned.includes(t));
    const types = [...owned, ...used];
    return (
      <article onClick={onCopyClick}>
        <div class="crumbs">
          <a href="#/api">API</a> / <a href={`#/api/section/${sectionId(entry.section)}`}>{entry.section}</a>
        </div>
        <div class="title">
          <h1>{entry.name}</h1>
          <KindBadge kind={entry.kind} />
          <SinceBadge since={entry.since} />
          {entry.deprecated ? <span class="badge deprecated">deprecated</span> : null}
        </div>
        <div class="facts">
          <code>{entry.module}</code>
          <a href={sourceUrl(api, entry.source.file, entry.source.line)} target="_blank" rel="noopener">
            {entry.source.file}:{entry.source.line}
          </a>
          {guide ? <a href={`#/guide/${guide}`}>Guide: {this.guides.find((g) => g.slug === guide)?.title ?? guide}</a> : null}
        </div>

        <div class="sig">
          <div class="import">
            <Code code={importLine} />
            <button type="button" onClick={() => this.#copyImport(importLine)} aria-label="Copy the import line">
              {this.copied ? "Copied" : "Copy"}
            </button>
          </div>
          <Code class="signature" code={entry.signature} link={this.#linker(api, self)} />
        </div>

        {entry.deprecated ? <div class="deprecated-note">{entry.deprecated}</div> : null}
        {entry.doc ? <Markdown text={entry.doc} ctx={ctx} /> : <p class="empty">No description yet; the signature and source are above.</p>}
        {entry.examples?.length ? (
          <>
            <h2>{entry.examples.length === 1 ? "Example" : "Examples"}</h2>
            {entry.examples.map((ex) => (
              <Code code={ex} />
            ))}
          </>
        ) : null}
        {members.length ? (
          <>
            <h2>
              {entry.kind === "const" ? "Properties" : "Members"}
              <span class="count">{members.length}</span>
            </h2>
            {this.#index(members, self)}
            {members.map((m) => this.#member(m, entry, api))}
          </>
        ) : null}
        {types.length ? (
          <>
            <h2>
              {owned.length && !used.length ? "Related types" : "Types it takes"}
              <span class="count">{types.length}</span>
            </h2>
            {types.map((part) => this.#part(part, api, part.name === focusPart))}
          </>
        ) : null}
      </article>
    );
  }
}

@route("/api/:id/:member")
@component("page-api-member")
export class PageApiMember extends PageApiEntry {
  @prop({ param: "member" }) accessor member = "";

  override get focusMember(): string {
    return this.member;
  }

  @watch("member") onMember() {
    if (this.isConnected) {
      this.scheduleUpdate();
      this.scrollToFocus();
    }
  }
}
