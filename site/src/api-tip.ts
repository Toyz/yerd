/**
 * Hover cards for API references, as a loom custom attribute: any element
 * with `data-api="yerd.res"` (the markdown renderer puts it on every link to
 * an API page) shows the export's kind, version and summary on hover or
 * focus. loom connects the controller wherever the attribute appears,
 * including inside page components' shadow roots and markdown rendered into
 * them later.
 *
 * The card is one element on <body>, filled with textContent (no HTML from
 * the docs reaches it), positioned under the link, or above when there's no
 * room below.
 */

import { on } from "@toyz/loom";
import { LoomAttribute, attribute, debounce } from "@toyz/loom/element";
import { entryId, loadApi, lookupApi } from "./data";
import { summaryParts } from "./ui";

let card: HTMLDivElement | undefined;
let owner: Element | undefined;

function cardElement(): HTMLDivElement {
  if (!card) {
    card = document.createElement("div");
    card.className = "api-tip";
    card.setAttribute("role", "tooltip");
    card.hidden = true;
    document.body.appendChild(card);
  }
  return card;
}

function line(className: string, text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  return el;
}

async function show(el: Element, id: string): Promise<void> {
  const api = await loadApi();
  if (owner !== el) return; // the pointer moved on while the data loaded
  const found = lookupApi(api, id);
  if (!found) return;
  const { entry, member } = found;
  const tip = cardElement();
  tip.replaceChildren();

  const head = document.createElement("div");
  head.className = "api-tip-head";
  head.append(line("api-tip-name", member ? `${entry.name}.${member.name}` : entry.name));
  head.append(line(`api-tip-kind ${member ? member.kind : entry.kind}`, member ? member.kind : entry.kind));
  const since = member?.since !== undefined ? member.since : entry.since;
  head.append(line(since === null ? "api-tip-since unreleased" : "api-tip-since", since === null ? "unreleased" : `since v${since}`));
  tip.append(head);

  const signature = (member ?? entry).signature.split("\n")[0]!;
  tip.append(line("api-tip-sig", signature.length > 120 ? `${signature.slice(0, 119)}…` : signature));
  const runs = summaryParts((member ?? entry).doc);
  if (runs.length) {
    const doc = line("api-tip-doc", "");
    for (const run of runs) {
      if (!run.code) doc.append(run.text);
      else doc.append(Object.assign(document.createElement("code"), { textContent: run.text }));
    }
    tip.append(doc);
  }
  if (entry.module !== "@toyz/yerd") tip.append(line("api-tip-module", `${entry.module} · ${entryId(entry)}`));

  tip.hidden = false;
  const rect = el.getBoundingClientRect();
  const width = Math.min(440, window.innerWidth - 24);
  tip.style.width = `${width}px`;
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
  const below = rect.bottom + 8;
  const height = tip.offsetHeight;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 8) : below;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hide(el: Element): void {
  if (owner !== el) return;
  owner = undefined;
  if (card) card.hidden = true;
}

/**
 * The controller, written with loom's own decorators: they work on attribute
 * controllers the same as on elements. `@on("mouseenter")` listens on the
 * element carrying the attribute; `@debounce` delays the card a little (so
 * sweeping the pointer across a paragraph doesn't flash cards) and cancels
 * itself when the element goes away.
 */
@attribute("data-api")
export class ApiTip extends LoomAttribute {
  #wanted = false;

  @on("mouseenter")
  @on("focusin")
  enter(): void {
    this.#wanted = true;
    this.reveal();
  }

  @on("mouseleave")
  @on("focusout")
  @on("click")
  leave(): void {
    this.#wanted = false;
    hide(this.el);
  }

  @debounce(250)
  reveal(): void {
    if (!this.#wanted) return;
    owner = this.el;
    void show(this.el, this.value);
  }

  disconnect(): void {
    hide(this.el);
  }
}
