import { Channels, channel, inject, is, length, matches, service, trim } from "@toyz/yerd";

export type Status = "todo" | "doing" | "done";
export const STATUSES: Array<[Status, string]> = [
  ["todo", "To do"],
  ["doing", "Doing"],
  ["done", "Done"],
];

export interface Card {
  id: string;
  title: string;
  status: Status;
  by: string;
}

/** A ping per change: every open board refreshes (data-yx-live). */
export const boardChannel = channel<{ version: number }>("board");

/**
 * A move, as it arrives from a drop: `drag.dataset.id` is read by the browser
 * when the card lands, so it's validated like any other input.
 */
export class MoveCard {
  @is.string({ validate: matches(/^c\d+$/, "Not a card id") }) card!: string;
  @is.oneOf(["todo", "doing", "done"]) to!: Status;
  @is.string({ optional: true, validate: matches(/^c\d+$/, "Not a card id") }) before?: string;
}

/** A card id from the browser (the bin's `drag.dataset.id`). */
export class CardRef {
  @is.string({ validate: matches(/^c\d+$/, "Not a card id") }) card!: string;
}

export class CardTitle {
  @is.string({ transform: trim, validate: length(1, 80) }) title!: string;
}

/** The staff kanban board, in memory. */
@service
export class Board {
  @inject(Channels) accessor channels!: Channels;
  #next = 1;
  #cards: Card[] = [
    ["Count the gnomes (again)", "todo"],
    ["Find out who keeps adding rocks", "todo"],
    ["Answer the fountain's emails", "todo"],
    ["Repaint flamingo #7", "doing"],
    ["Restock googly eyes", "doing"],
    ["Untangle the wind chimes", "done"],
  ].map(([title, status]) => ({ id: `c${this.#next++}`, title: title!, status: status as Status, by: "ada" }));
  version = 0;

  column(status: Status): Card[] {
    return this.#cards.filter((c) => c.status === status);
  }

  get(id: string): Card | undefined {
    return this.#cards.find((c) => c.id === id);
  }

  add(title: string, by: string): Card {
    const card: Card = { id: `c${this.#next++}`, title, status: "todo", by };
    this.#cards.push(card);
    this.#changed();
    return card;
  }

  rename(id: string, title: string): void {
    const card = this.get(id);
    if (card) card.title = title;
    this.#changed();
  }

  /** Move a card to a column; with `before`, just above that card, else to the bottom. */
  move({ card: id, to, before }: MoveCard): void {
    const card = this.get(id);
    if (!card || id === before) return;
    this.#cards = this.#cards.filter((c) => c !== card);
    card.status = to;
    const at = before ? this.#cards.findIndex((c) => c.id === before) : -1;
    if (at >= 0) this.#cards.splice(at, 0, card);
    else this.#cards.push(card);
    this.#changed();
  }

  remove(id: string): void {
    this.#cards = this.#cards.filter((c) => c.id !== id);
    this.#changed();
  }

  #changed(): void {
    void this.channels.publish(boardChannel, { version: ++this.version });
  }
}
