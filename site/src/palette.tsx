/**
 * <doc-palette>: the command palette. Mod+K (or "/") from anywhere, or the
 * sidebar's search button, which asks for it over loom's event bus.
 *
 * It searches everything the site knows: API exports and their members,
 * guides and every section in them, and a few commands (section indexes).
 * Matching is fuzzy and camelCase-aware ("gid" finds generateId, "sesopt"
 * finds SessionOptions), names outrank summaries, and what you picked
 * recently comes first when the box is empty.
 */

import { LoomElement, LoomEvent, animationFrame, app, component, css, mount, on, query, reactive, styles } from "@toyz/loom";
import { hotkey, hotkeyLabel } from "@toyz/loom/element";
import { LoomRouter } from "@toyz/loom/router";
import { entryId, loadApi, loadGuides, sectionId, type Api, type GuideInfo } from "./data";
import { tagStyles } from "./shared";
import { summary } from "./ui";

/** Ask the palette to open (the sidebar button sends it). */
export class OpenPalette extends LoomEvent {}

type Kind = "guide" | "section" | "api" | "member" | "command";

interface Item {
  kind: Kind;
  title: string;
  /** Where it goes: a router path. */
  to: string;
  /** Shown on the right: the guide, the API section, the export's kind. */
  where: string;
  /** One line under the title. */
  detail?: string;
  /** Also searched, weighted lower than the title. */
  keywords: string;
  /** API kind badge (function, class...). */
  badge?: string;
}

const GROUP_ORDER: Kind[] = ["api", "member", "section", "guide", "command"];
const GROUP_LABEL: Record<Kind, string> = { api: "API", member: "Members", section: "In the guides", guide: "Guides", command: "Go to" };
const PER_GROUP = 8;
const RECENT_KEY = "yerd-docs:palette-recent";

function buildIndex(api: Api, guides: GuideInfo[]): Item[] {
  const items: Item[] = [];
  for (const entry of api.entries) {
    const id = entryId(entry);
    items.push({
      kind: "api",
      title: entry.name,
      to: `/api/${id}`,
      where: entry.partOf ? `on ${entry.partOf.split(".").pop()}` : entry.section,
      detail: entry.doc ? summary(entry.doc) : undefined,
      keywords: `${entry.section} ${entry.module} ${entry.doc ?? ""}`,
      badge: entry.kind,
    });
    for (const member of entry.members ?? []) {
      items.push({
        kind: "member",
        title: `${entry.name}.${member.name}`,
        to: `/api/${id}/${member.name}`,
        where: member.kind,
        detail: member.doc ? summary(member.doc) : undefined,
        keywords: `${member.name} ${member.doc ?? ""}`,
      });
    }
  }
  for (const guide of guides) {
    if (guide.group === "Design notes") continue;
    const to = guide.slug === "overview" ? "/" : `/guide/${guide.slug}`;
    items.push({ kind: "guide", title: guide.title, to, where: guide.group, keywords: guide.group });
    for (const section of guide.sections ?? []) {
      items.push({ kind: "section", title: section.text, to: `/guide/${guide.slug}/${section.id}`, where: guide.title, keywords: guide.title });
    }
  }
  items.push({ kind: "command", title: "All exports", to: "/api", where: "API", keywords: "api reference index" });
  for (const section of api.sections) {
    items.push({ kind: "command", title: `${section} API`, to: `/api/section/${sectionId(section)}`, where: "API section", keywords: section });
  }
  return items;
}

/** Word starts in a name: "generateId" -> g, i; "session-and-auth" -> s, a, a. */
function wordStarts(text: string): Set<number> {
  const starts = new Set<number>([0]);
  for (let i = 1; i < text.length; i++) {
    const prev = text[i - 1]!;
    const ch = text[i]!;
    if (/[\s._/\-:(@]/.test(prev) || (/[a-z0-9]/.test(prev) && /[A-Z]/.test(ch))) starts.add(i);
  }
  return starts;
}

/**
 * How well `token` matches `text`, and which characters matched (for
 * highlighting), or undefined. Contiguous beats scattered, a match at a word
 * start beats one in the middle, and the earlier the better.
 */
function fuzzy(token: string, text: string): { score: number; hits: number[] } | undefined {
  const lower = text.toLowerCase();
  const at = lower.indexOf(token);
  if (at >= 0) {
    const starts = wordStarts(text);
    const hits = Array.from({ length: token.length }, (_, i) => at + i);
    const exact = lower === token ? 60 : 0;
    return { score: 100 + exact + (starts.has(at) ? 30 : 0) - Math.min(at, 30) + token.length * 2, hits };
  }
  // Initials and runs: each character either continues the last match or
  // starts a word. "gid" is g(enerate)Id, "sesopt" Ses(sion)Opt(ions); a
  // scattered re(g)...(i)...(d) is no match at all.
  const starts = wordStarts(text);
  const hits: number[] = [];
  let score = 40;
  let from = 0;
  for (const ch of token) {
    const last = hits[hits.length - 1];
    let found = -1;
    if (last !== undefined && lower[last + 1] === ch) {
      found = last + 1;
      score += 5;
    } else {
      for (let i = from; i < lower.length; i++) {
        if (lower[i] === ch && starts.has(i)) {
          found = i;
          break;
        }
      }
      if (found < 0) return undefined;
      score += 8;
    }
    hits.push(found);
    from = found + 1;
  }
  // Fewer words skipped is better: "gid" fits generateId more tightly than getMeaningfulItemData.
  return { score: score - (hits[hits.length - 1]! - hits[0]!) * 0.5, hits };
}

interface Scored {
  item: Item;
  score: number;
  hits: number[];
}

function search(items: Item[], text: string): Scored[] {
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const out: Scored[] = [];
  for (const item of items) {
    let score = 0;
    const hits: number[] = [];
    let ok = true;
    let titled = false;
    for (const token of tokens) {
      const inTitle = fuzzy(token, item.title);
      if (inTitle) {
        score += inTitle.score;
        hits.push(...inTitle.hits);
        titled = true;
        continue;
      }
      // Only plain substrings in the rest: fuzzy matching across a whole doc comment finds everything.
      const rest = `${item.where} ${item.keywords}`.toLowerCase();
      if (rest.includes(token)) score += 12;
      else {
        ok = false;
        break;
      }
    }
    // Something has to be in the name: a word that's only somewhere in a doc comment matches half the API.
    if (!ok || !titled) continue;
    // Exports first, then members and guide sections: the same score means more to a name.
    score += { api: 6, member: 0, section: 2, guide: 4, command: 1 }[item.kind];
    out.push({ item, score, hits });
  }
  return out.sort((a, b) => b.score - a.score || a.item.title.length - b.item.title.length);
}

function readRecent(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function saveRecent(to: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([to, ...readRecent().filter((r) => r !== to)].slice(0, 8)));
  } catch {
    // private mode: no history, that's all
  }
}

/** The title with its matched characters marked. */
function Highlighted({ text, hits }: { text: string; hits: number[] }) {
  if (hits.length === 0) return <span>{text}</span>;
  const marked = new Set(hits);
  const parts: unknown[] = [];
  let run = "";
  let runMarked = false;
  const flush = () => {
    if (run) parts.push(runMarked ? <mark>{run}</mark> : run);
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const isHit = marked.has(i);
    if (isHit !== runMarked) {
      flush();
      runMarked = isHit;
    }
    run += text[i];
  }
  flush();
  return <span>{parts}</span>;
}

const sheet = css`
  ${tagStyles}
  :host { display: none; position: fixed; inset: 0; z-index: 1000; align-items: flex-start; justify-content: center; padding-top: min(14vh, 120px); }
  :host(.open) { display: flex; }
  .backdrop { position: fixed; inset: 0; background: light-dark(rgba(60, 42, 24, 0.32), rgba(8, 6, 4, 0.66)); backdrop-filter: blur(6px); animation: fade 0.12s ease; }
  .modal {
    position: relative; width: min(680px, calc(100vw - 24px)); max-height: min(560px, 76vh);
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--bg-raised); border: 1px solid var(--border-strong); border-radius: 10px;
    box-shadow: var(--shadow); animation: pop 0.14s cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes fade { from { opacity: 0; } }
  @keyframes pop { from { opacity: 0; transform: scale(0.98) translateY(-6px); } }
  .bar { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
  .bar svg { flex: none; color: var(--brand); }
  .input { flex: 1; min-width: 0; background: none; border: 0; outline: none; color: var(--text); font: inherit; font-size: 1.05rem; caret-color: var(--brand); }
  .input::placeholder { color: var(--text-faint); }
  kbd {
    display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 20px; padding: 0 5px;
    border: 1px solid var(--border); border-radius: 4px; font: 600 0.7rem var(--mono); color: var(--text-dim); background: var(--bg-sunken);
  }
  .results { overflow-y: auto; padding: 6px 8px 8px; flex: 1; scrollbar-width: thin; }
  .label { font: 400 0.95rem var(--display); color: var(--text-dim); padding: 12px 10px 4px; }
  .item { --hole: var(--bg-raised); display: flex; align-items: center; gap: 12px; padding: 8px 10px; border-radius: 6px; cursor: pointer; border-left: 3px solid transparent; }
  .item.active { --hole: var(--bg-hover); background: var(--bg-hover); border-left-color: var(--brand); }
  .item .icon { flex: none; width: 24px; height: 24px; border-radius: 5px; display: grid; place-items: center; font: 600 0.72rem var(--mono); color: var(--text-faint); background: var(--bg-sunken); }
  .item.active .icon { color: var(--accent); }
  .info { flex: 1; min-width: 0; }
  .title { font-size: 0.95rem; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .title.mono { font-family: var(--mono); font-size: 0.88rem; }
  .title mark { background: none; color: var(--accent); font-weight: 700; text-decoration: underline; text-decoration-color: var(--accent-dim); text-underline-offset: 3px; }
  .detail { font-size: 0.8rem; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
  .where { flex: none; font-size: 0.78rem; color: var(--text-faint); max-width: 34%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .empty { padding: 36px 16px; text-align: center; color: var(--text-dim); }
  .foot { display: flex; gap: 18px; padding: 10px 18px; border-top: 1px solid var(--border); font-size: 0.78rem; color: var(--text-faint); }
  .foot span { display: inline-flex; align-items: center; gap: 5px; }
  @media (max-width: 600px) {
    :host { padding-top: 12px; }
    .modal { max-height: calc(100dvh - 24px); }
    .foot { display: none; }
    .where { display: none; }
  }
`;

const ICON: Record<Kind, string> = { api: "{}", member: ".", section: "#", guide: "¶", command: "/" };

@component("doc-palette")
@styles(sheet)
export class DocPalette extends LoomElement {
  @reactive accessor isOpen = false;
  @reactive accessor text = "";
  @reactive accessor active = 0;
  @query(".input") accessor input!: HTMLInputElement;

  #items: Item[] = [];
  #shown: Scored[] = [];
  #needsFocus = false;
  #returnFocus: Element | null = null;

  @mount async load() {
    const [api, guides] = await Promise.all([loadApi(), loadGuides()]);
    this.#items = buildIndex(api, guides);
    if (this.isOpen) this.scheduleUpdate();
  }

  @hotkey("mod+k", { global: true })
  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** "/" opens it too, unless you're typing somewhere. */
  @hotkey("/", { global: true, preventDefault: false })
  slash(event?: KeyboardEvent) {
    const target = (event?.composedPath?.()[0] ?? document.activeElement) as HTMLElement | null;
    if (this.isOpen || target?.closest?.("input, textarea, select, [contenteditable]")) return;
    event?.preventDefault();
    this.open();
  }

  @on(OpenPalette) onOpenRequest() {
    this.open();
  }

  /** Focus waits for the frame after the input renders. */
  @animationFrame focusTick() {
    if (!this.#needsFocus || !this.input) return;
    this.input.focus();
    this.input.select();
    this.#needsFocus = false;
  }

  open() {
    this.#returnFocus = document.activeElement;
    this.isOpen = true;
    this.active = 0;
    this.classList.add("open");
    this.#needsFocus = true;
  }

  close() {
    this.isOpen = false;
    this.classList.remove("open");
    (this.#returnFocus as HTMLElement | null)?.focus?.();
  }

  go(item: Item) {
    saveRecent(item.to);
    this.close();
    void app.get(LoomRouter).navigate(item.to);
  }

  onKeyDown(event: KeyboardEvent) {
    const count = Math.max(this.#shown.length, 1);
    if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
      event.preventDefault();
      this.active = (this.active + 1) % count;
      this.#reveal();
    } else if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
      event.preventDefault();
      this.active = (this.active - 1 + count) % count;
      this.#reveal();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = this.#shown[this.active];
      if (chosen) this.go(chosen.item);
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.close();
    }
  }

  #reveal() {
    requestAnimationFrame(() => this.shadow.querySelector(".item.active")?.scrollIntoView({ block: "nearest" }));
  }

  /** Empty box: recent picks, then the guides. Otherwise the best matches, a few per kind. */
  #results(): Scored[] {
    if (!this.text.trim()) {
      const byPath = new Map(this.#items.map((item) => [item.to, item]));
      const recent = readRecent()
        .map((to) => byPath.get(to))
        .filter((item): item is Item => item !== undefined)
        .map((item) => ({ item: { ...item, where: `recent - ${item.where}` }, score: 0, hits: [] }));
      const guides = this.#items.filter((item) => item.kind === "guide").map((item) => ({ item, score: 0, hits: [] }));
      return [...recent, ...guides];
    }
    const found = search(this.#items, this.text);
    const perKind = new Map<Kind, number>();
    const capped = found.filter((s) => {
      const n = perKind.get(s.item.kind) ?? 0;
      perKind.set(s.item.kind, n + 1);
      return n < PER_GROUP;
    });
    // Groups ordered by their best match (ties in the usual order), items by score within each.
    const best = new Map<Kind, number>();
    for (const s of capped) if (!best.has(s.item.kind)) best.set(s.item.kind, s.score);
    const order = [...GROUP_ORDER].filter((k) => best.has(k)).sort((a, b) => best.get(b)! - best.get(a)! || GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b));
    return order.flatMap((kind) => capped.filter((s) => s.item.kind === kind));
  }

  update() {
    if (!this.isOpen) return <div></div>;
    this.#shown = this.#results();
    if (this.active >= this.#shown.length) this.active = 0;
    let index = 0;
    const groups: unknown[] = [];
    let current: string | undefined;
    for (const scored of this.#shown) {
      const label = this.text.trim() ? GROUP_LABEL[scored.item.kind] : scored.item.where.startsWith("recent") ? "Recent" : "Guides";
      if (label !== current) {
        groups.push(<div class="label">{label}</div>);
        current = label;
      }
      const i = index++;
      const { item } = scored;
      groups.push(
        <div
          class={`item ${i === this.active ? "active" : ""}`}
          loom-key={`${item.kind}:${item.to}`}
          onClick={() => this.go(item)}
          onMouseMove={() => i !== this.active && (this.active = i)}
          role="option"
          aria-selected={i === this.active ? "true" : "false"}
        >
          <span class="icon">{ICON[item.kind]}</span>
          <div class="info">
            <div class={`title ${item.kind === "api" || item.kind === "member" ? "mono" : ""}`}>
              <Highlighted text={item.title} hits={scored.hits} />
            </div>
            {item.detail ? <div class="detail">{item.detail}</div> : null}
          </div>
          {item.badge ? <span class={`tag ${item.badge}`}>{item.badge}</span> : <span class="where">{item.where}</span>}
        </div>,
      );
    }
    return (
      <div>
        <div class="backdrop" onClick={() => this.close()}></div>
        <div class="modal" role="dialog" aria-label="Search the docs">
          <div class="bar">
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={2} stroke-linecap="round">
              <circle cx={11} cy={11} r={7} />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              class="input"
              type="text"
              placeholder="Search the API, members and guides..."
              value={this.text}
              role="combobox"
              aria-expanded="true"
              onInput={(e: Event) => {
                this.text = (e.target as HTMLInputElement).value;
                this.active = 0;
              }}
              onKeyDown={(e: KeyboardEvent) => this.onKeyDown(e)}
            />
            <kbd>esc</kbd>
          </div>
          <div class="results" role="listbox">
            {this.#shown.length ? groups : <div class="empty">Nothing matches "{this.text.trim()}".</div>}
          </div>
          <div class="foot">
            <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
            <span><kbd>↵</kbd> open</span>
            <span><kbd>esc</kbd> close</span>
            <span style="margin-left:auto"><kbd>{PALETTE_HOTKEY}</kbd> anywhere</span>
          </div>
        </div>
      </div>
    );
  }
}

/** The shortcut, printed for this platform (read off the binding, so the hint can't drift). */
export const PALETTE_HOTKEY = hotkeyLabel(DocPalette.prototype.toggle);
