/**
 * A guide: one of docs/guide/*.md, rendered, with its headings as an
 * on-page index that follows your scroll, previous / next in reading order,
 * and a link to edit the file on GitHub.
 */

import { LoomElement, component, css, mount, on, prop, reactive, styles, throttle, watch } from "@toyz/loom";
import { route } from "@toyz/loom/router";
import { linkContext, loadApi, loadGuide, loadGuides, type Api, type GuideInfo } from "../data";
import { onProseClick, onProseKeydown } from "../prose";
import { renderMarkdown, type Heading } from "../markdown";

const sheet = css`
  .layout { display: grid; grid-template-columns: minmax(0, var(--measure)) 210px; gap: 64px; align-items: start; justify-content: start; }
  .crumb { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; font-size: 0.88rem; color: var(--text-faint); }
  .crumb a { color: var(--text-faint); text-decoration: none; }
  .crumb a:hover { color: var(--accent); text-decoration: underline; }
  .prose h2, .prose h3 { scroll-margin-top: calc(var(--top) + 20px); }

  .rail { position: sticky; top: calc(var(--top) + 32px); max-height: calc(100vh - var(--top) - 64px); overflow-y: auto; font-size: 0.86rem; scrollbar-width: thin; }
  .rail-title { font-weight: 700; color: var(--text); margin: 0 0 10px; font-size: 0.86rem; }
  .rail ol { list-style: none; margin: 0; padding: 0; border-left: 1px solid var(--border); }
  .rail a { display: block; margin-left: -1px; padding: 4px 0 4px 14px; color: var(--text-faint); border-left: 2px solid transparent; line-height: 1.4; text-decoration: none; }
  .rail a.sub { padding-left: 26px; font-size: 0.82rem; }
  .rail a:hover { color: var(--text); }
  .rail a.on { color: var(--text); border-left-color: var(--brand); font-weight: 700; }
  .rail .edit { display: block; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border); color: var(--text-faint); text-decoration: none; }
  .rail .edit:hover { color: var(--accent); }

  .after { margin-top: 56px; padding-top: 18px; border-top: 1px solid var(--border); }
  .edit-line { font-size: 0.88rem; color: var(--text-faint); margin: 0 0 22px; }
  .edit-line a { color: var(--text-dim); }
  .pager { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .pager a { display: block; padding: 4px 0; color: var(--text); text-decoration: none; }
  .pager small { display: block; color: var(--text-faint); font-size: 0.82rem; margin-bottom: 2px; }
  .pager span { font: 400 1.2rem var(--display); }
  .pager a:hover span { color: var(--accent); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 4px; }
  .pager .next { text-align: right; grid-column: 2; }

  @media (max-width: 1240px) {
    .layout { grid-template-columns: minmax(0, var(--measure)); }
    .rail { display: none; }
  }
  @media (max-width: 560px) {
    .pager { grid-template-columns: 1fr; }
    .pager .next { grid-column: 1; }
  }
`;

@route("/guide/:slug")
@component("page-guide")
@styles(sheet)
export class PageGuide extends LoomElement {
  @prop({ param: "slug" }) accessor slug = "";
  @reactive accessor html = "";
  @reactive accessor headings: Heading[] = [];
  @reactive accessor api: Api | undefined = undefined;
  @reactive accessor guides: GuideInfo[] = [];
  @reactive accessor error = "";
  /** The heading you're reading, for the on-page index. */
  @reactive accessor current = "";

  /** The heading to scroll to (the anchor route sets it). */
  get anchor(): string {
    return "";
  }

  @mount start() {
    void this.load();
  }

  // The outlet reuses this element when only the slug changes.
  @watch("slug") onSlug() {
    if (this.isConnected) void this.load();
  }

  async load() {
    const slug = this.slug;
    this.error = "";
    try {
      const [api, guides, text] = await Promise.all([loadApi(), loadGuides(), loadGuide(slug)]);
      if (slug !== this.slug) return;
      const rendered = renderMarkdown(text, linkContext(api, guides, slug));
      this.api = api;
      this.guides = guides;
      this.html = rendered.html;
      this.headings = rendered.headings;
      this.current = "";
      requestAnimationFrame(() => this.scrollToAnchor());
    } catch (error) {
      if (slug === this.slug) this.error = String(error);
    }
  }

  scrollToAnchor() {
    const target = this.anchor ? this.shadow.getElementById(this.anchor) : null;
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }

  /** The last ## / ### heading above the top fifth of the window is the one you're in. */
  @on(window, "scroll")
  @throttle(100)
  spy() {
    const line = window.innerHeight * 0.2 + 40;
    let current = "";
    for (const h of this.shadow.querySelectorAll<HTMLElement>(".prose h2[id], .prose h3[id]")) {
      if (h.getBoundingClientRect().top > line) break;
      current = h.id;
    }
    if (current !== this.current) this.current = current;
  }

  update() {
    if (this.error) return <p class="error">{this.error}</p>;
    if (!this.html) return <p class="loading">Loading…</p>;
    const guide = this.guides.find((g) => g.slug === this.slug);
    const outline = this.headings.filter((h) => h.level === 2 || h.level === 3);
    // Previous / next in reading order across all the guides (design notes among themselves).
    const notes = guide?.group === "Design notes";
    const order = this.guides.filter((g) => g.slug !== "overview" && (g.group === "Design notes") === notes);
    const at = order.findIndex((g) => g.slug === this.slug);
    const prev = at > 0 ? order[at - 1] : undefined;
    const next = at >= 0 && at < order.length - 1 ? order[at + 1] : undefined;
    const editUrl = guide && this.api ? `${this.api.repo}/edit/main/${guide.file}` : undefined;
    return (
      <div class="layout">
        <article>
          {guide ? (
            <div class="crumb">
              <span>
                <a href="#/guide/getting-started">Guides</a> / {guide.group}
              </span>
            </div>
          ) : null}
          <div class="prose" onClick={onProseClick} onKeyDown={onProseKeydown} rawHTML={this.html}></div>
          <div class="after">
            {editUrl ? (
              <p class="edit-line">
                Something unclear or wrong? <a href={editUrl} target="_blank" rel="noopener">Edit this page on GitHub</a>.
              </p>
            ) : null}
            {prev || next ? (
              <nav class="pager" aria-label="More guides">
                {prev ? (
                  <a href={`#/guide/${prev.slug}`} rel="prev">
                    <small>Previous</small>
                    <span>{prev.title}</span>
                  </a>
                ) : null}
                {next ? (
                  <a class="next" href={`#/guide/${next.slug}`} rel="next">
                    <small>Next</small>
                    <span>{next.title}</span>
                  </a>
                ) : null}
              </nav>
            ) : null}
          </div>
        </article>
        {outline.length > 1 ? (
          <nav class="rail" aria-label="On this page">
            <div class="rail-title">On this page</div>
            <ol>
              {outline.map((h) => (
                <li>
                  <a
                    class={`${h.level === 3 ? "sub" : ""} ${h.id === this.current ? "on" : ""}`}
                    href={`#/guide/${this.slug}/${h.id}`}
                    aria-current={h.id === this.current ? "location" : undefined}
                  >
                    {h.text}
                  </a>
                </li>
              ))}
            </ol>
            {editUrl ? (
              <a class="edit" href={editUrl} target="_blank" rel="noopener">
                Edit this page
              </a>
            ) : null}
          </nav>
        ) : null}
      </div>
    );
  }
}

@route("/guide/:slug/:anchor")
@component("page-guide-anchor")
export class PageGuideAnchor extends PageGuide {
  @prop({ param: "anchor" }) accessor heading = "";

  override get anchor(): string {
    return this.heading;
  }

  @watch("heading") onHeading() {
    if (this.isConnected && this.html) requestAnimationFrame(() => this.scrollToAnchor());
  }
}
