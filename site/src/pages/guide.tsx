/** A guide: one of docs/*.md, rendered, with its headings as an in-page index. */

import { LoomElement, component, css, mount, prop, reactive, styles, watch } from "@toyz/loom";
import { route } from "@toyz/loom/router";
import { linkContext, loadApi, loadGuide, loadGuides, type Api, type GuideInfo } from "../data";
import { onCopyClick } from "../ui";
import { renderMarkdown, type Heading } from "../markdown";

const sheet = css`
  :host { max-width: 1400px; }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 220px; gap: 48px; align-items: start; }
  .source { font-size: 0.8rem; margin-bottom: 18px; }
  .group { font: 700 0.72rem var(--mono); text-transform: uppercase; letter-spacing: 0.08em; color: var(--accent); margin-bottom: 6px; }
  .prose h2, .prose h3 { scroll-margin-top: 20px; }

  .rail { position: sticky; top: 28px; max-height: calc(100vh - 56px); overflow-y: auto; font-size: 0.84rem; scrollbar-width: thin; }
  .rail-title { font: 700 0.7rem var(--mono); text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-faint); margin-bottom: 8px; }
  .rail a { display: block; padding: 3px 0 3px 10px; color: var(--text-dim); border-left: 1px solid var(--border); line-height: 1.4; }
  .rail a.sub { padding-left: 22px; font-size: 0.8rem; color: var(--text-faint); }
  .rail a:hover { color: var(--accent); border-left-color: var(--accent); text-decoration: none; }

  .pager { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 56px; }
  .pager a {
    display: block; padding: 12px 16px; border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--bg-raised); color: var(--text);
  }
  .pager a:hover { border-color: var(--accent-dim); text-decoration: none; }
  .pager small { display: block; color: var(--text-faint); font-size: 0.75rem; }
  .pager .next { text-align: right; grid-column: 2; }

  @media (max-width: 1240px) {
    .layout { grid-template-columns: minmax(0, 1fr); }
    .rail { display: none; }
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

  update() {
    if (this.error) return <p class="error">{this.error}</p>;
    if (!this.html) return <p class="loading">Loading…</p>;
    const guide = this.guides.find((g) => g.slug === this.slug);
    const outline = this.headings.filter((h) => h.level === 2 || h.level === 3);
    // Prev / next within the same group (the guides read in order).
    const siblings = this.guides.filter((g) => g.group === guide?.group);
    const at = siblings.findIndex((g) => g.slug === this.slug);
    const prev = at > 0 ? siblings[at - 1] : undefined;
    const next = at >= 0 && at < siblings.length - 1 ? siblings[at + 1] : undefined;
    return (
      <div class="layout">
        <article>
          {guide ? <div class="group">{guide.group}</div> : null}
          <div class="prose" onClick={onCopyClick} rawHTML={this.html}></div>
          {guide && this.api ? (
            <div class="source muted" style="margin-top: 40px">
              Edit <a href={`${this.api.repo}/edit/main/${guide.file}`} target="_blank" rel="noopener">{guide.file}</a> on GitHub
            </div>
          ) : null}
          {prev || next ? (
            <nav class="pager">
              {prev ? (
                <a href={`#/guide/${prev.slug}`}>
                  <small>Previous</small>
                  {prev.title}
                </a>
              ) : null}
              {next ? (
                <a class="next" href={`#/guide/${next.slug}`}>
                  <small>Next</small>
                  {next.title}
                </a>
              ) : null}
            </nav>
          ) : null}
        </article>
        {outline.length > 1 ? (
          <nav class="rail" aria-label="On this page">
            <div class="rail-title">On this page</div>
            {outline.map((h) => (
              <a class={h.level === 3 ? "sub" : ""} href={`#/guide/${this.slug}/${h.id}`}>
                {h.text}
              </a>
            ))}
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
