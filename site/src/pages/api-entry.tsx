/** One export: import line, signature, docs, examples, and its members with their own version badges. */

import { LoomElement, component, css, mount, prop, reactive, styles, watch } from "@toyz/loom";
import { route } from "@toyz/loom/router";
import { entryId, linkContext, loadApi, loadGuides, resolveApi, sectionId, sourceUrl, type Api, type Entry, type GuideInfo, type Member } from "../data";
import { Code, KindBadge, Markdown, SinceBadge } from "../ui";

const sheet = css`
  .crumbs { font-size: 0.82rem; color: var(--text-faint); margin-bottom: 10px; }
  .title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
  .title h1 { font-family: var(--mono); font-size: 1.7rem; margin: 0; word-break: break-all; }
  .facts { display: flex; gap: 14px; flex-wrap: wrap; font-size: 0.82rem; color: var(--text-faint); margin: 8px 0 18px; }
  .deprecated-note { border-left: 3px solid var(--danger); background: rgba(240, 139, 139, 0.08); padding: 8px 14px; border-radius: 0 var(--radius) var(--radius) 0; margin: 12px 0; }
  .empty { color: var(--text-faint); font-style: italic; }
  .member { border: 1px solid var(--border); border-radius: var(--radius); padding: 4px 16px 6px; margin: 12px 0; background: var(--bg-raised); scroll-margin-top: 20px; }
  .member.target { border-color: var(--accent-dim); box-shadow: 0 0 0 3px var(--accent-bg); }
  .member-head h3 a { color: inherit; }
  .member-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 10px 0 0; }
  .member-head h3 { font-family: var(--mono); font-size: 0.98rem; margin: 0; }
  .member-head .src { margin-left: auto; font-size: 0.75rem; }
  .member pre.signature { margin: 10px 0; }
  .member .prose p:first-child { margin-top: 4px; }
  h2 .count { color: var(--text-faint); font-weight: 400; font-size: 0.9rem; }
  .part { border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 18px 12px; margin: 16px 0; scroll-margin-top: 20px; }
  .part.target { border-color: var(--accent-dim); box-shadow: 0 0 0 3px var(--accent-bg); }
  .part-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
  .part-head h3 { font-family: var(--mono); font-size: 1.1rem; margin: 0; }
  .part-head h3 a { color: inherit; }
  .part .member { background: var(--bg); }
`;

const MEMBER_ORDER: Record<Member["kind"], number> = { constructor: 0, property: 1, accessor: 2, method: 3, index: 4 };

@route("/api/:id")
@component("page-api-entry")
@styles(sheet)
export class PageApiEntry extends LoomElement {
  @prop({ param: "id" }) accessor id = "";
  @reactive accessor api: Api | undefined = undefined;
  @reactive accessor guides: GuideInfo[] = [];

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

  /** A type documented on this page: its signature, docs, examples and members. */
  #part(part: Entry, api: Api, focused: boolean) {
    const self = entryId(part);
    const ctx = linkContext(api, this.guides, undefined, self);
    const link = (name: string) => {
      const id = resolveApi(api, name);
      return id && id !== self ? id : undefined;
    };
    const members = [...(part.members ?? [])].sort((a, b) => MEMBER_ORDER[a.kind] - MEMBER_ORDER[b.kind]);
    return (
      <section class={`part ${focused ? "target" : ""}`} id={`p-${part.name}`} loom-key={part.name}>
        <div class="part-head">
          <h3><a href={`#/api/${self}`}>{part.name}</a></h3>
          <KindBadge kind={part.kind} />
          <SinceBadge since={part.since} />
          <a class="src" href={sourceUrl(api, part.source.file, part.source.line)} target="_blank" rel="noopener">source</a>
        </div>
        <Code class="signature" code={part.signature} link={link} />
        {part.doc ? <Markdown text={part.doc} ctx={ctx} /> : null}
        {(part.examples ?? []).map((ex) => (
          <Code code={ex} />
        ))}
        {members.map((m) => this.#member(m, part, api))}
      </section>
    );
  }

  #member(m: Member, entry: Entry, api: Api) {
    const self = entryId(entry);
    const ctx = linkContext(api, this.guides, undefined, `${self}/${m.name}`);
    const link = (name: string) => {
      const id = resolveApi(api, name);
      return id && id !== self ? id : undefined;
    };
    return (
      <div class={`member ${m.name === this.focusMember ? "target" : ""}`} id={`m-${m.name}`} loom-key={`${m.static ? "static " : ""}${m.name}`}>
        <div class="member-head">
          <h3>
            <a href={`#/api/${self}/${m.name}`}>
              {m.static ? "static " : ""}
              {m.name}
            </a>
          </h3>
          <span class="badge kind">{m.kind}</span>
          <SinceBadge since={m.since} />
          {m.deprecated ? <span class="badge deprecated">deprecated</span> : null}
          {m.line ? (
            <a class="src" href={sourceUrl(api, entry.source.file, m.line)} target="_blank" rel="noopener">source</a>
          ) : null}
        </div>
        <Code class="signature" code={m.signature} link={link} />
        {m.deprecated ? <div class="deprecated-note">{m.deprecated}</div> : null}
        {m.doc ? <Markdown text={m.doc} ctx={ctx} /> : null}
        {(m.examples ?? []).map((ex) => (
          <Code code={ex} />
        ))}
      </div>
    );
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
            No export <code>{this.id}</code>. <a href="#/api">All exports</a>
          </p>
        </div>
      );
    }
    const self = entryId(entry);
    const ctx = linkContext(api, this.guides, undefined, self);
    const link = (name: string) => {
      const id = resolveApi(api, name);
      return id && id !== self ? id : undefined;
    };
    const members = [...(entry.members ?? [])].sort((a, b) => MEMBER_ORDER[a.kind] - MEMBER_ORDER[b.kind]);
    const typeOnly = entry.kind === "interface" || entry.kind === "type";
    const importLine = `import { ${typeOnly ? `type ${entry.name}` : entry.name} } from "${entry.module}";`;
    return (
      <article>
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
          <span>{entry.module}</span>
          <a href={sourceUrl(api, entry.source.file, entry.source.line)} target="_blank" rel="noopener">
            {entry.source.file}:{entry.source.line}
          </a>
        </div>
        <Code code={importLine} />
        <Code class="signature" code={entry.signature} link={link} />
        {entry.deprecated ? <div class="deprecated-note">{entry.deprecated}</div> : null}
        {entry.doc ? <Markdown text={entry.doc} ctx={ctx} /> : <p class="empty">No description yet; the signature and source are above.</p>}
        {entry.examples?.length ? (
          <>
            <h2>Examples</h2>
            {entry.examples.map((ex) => (
              <Code code={ex} />
            ))}
          </>
        ) : null}
        {members.length ? (
          <>
            <h2>
              {entry.kind === "const" ? "Properties" : "Members"} <span class="count">({members.length})</span>
            </h2>
            {members.map((m) => this.#member(m, entry, api))}
          </>
        ) : null}
        {entry.parts?.length ? (
          <>
            <h2>
              Related types <span class="count">({entry.parts.length})</span>
            </h2>
            {entry.parts
              .map((name) => api.entries.find((e) => e.module === entry.module && e.name === name))
              .filter((part): part is Entry => part !== undefined)
              .map((part) => this.#part(part, api, part.name === focusPart))}
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
