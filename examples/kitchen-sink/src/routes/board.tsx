import { ActionForm, Channels, Region, action, get, inject, parse, route, signal, sse } from "@toyz/yerd";
import { Board, CardRef, CardTitle, MoveCard, STATUSES, boardChannel, type Card, type Status } from "../board.js";
import { auth, type User } from "../users.js";
import { Admin } from "./admin.js";

/** Every change to the board pings here; open boards refresh (data-yx-live). */
@route("/board/events", { group: Admin })
export class BoardEvents {
  @inject(Channels) accessor channels!: Channels;
  @signal accessor stop!: AbortSignal;

  @get @sse feed() {
    return this.channels.subscribe(boardChannel, this.stop);
  }
}

function CardItem({ card, status, page }: { card: Card; status: Status; page: BoardPage }) {
  return (
    // Draggable, and a drop target too: a card dropped on a card goes just above it (the innermost target wins).
    <li
      key={card.id}
      class="card"
      data-id={card.id}
      draggable="true"
      action={({ drag }) => page.move({ card: drag.data("id"), to: status, before: card.id })}
      trigger="drop"
    >
      <span class="card-title">{card.title}</span>
      <span class="muted small">by @{card.by}</span>
      <details class="card-edit">
        <summary aria-label={`Edit ${card.title}`}>Edit</summary>
        <form action={({ form }) => page.rename({ id: card.id }, form)}>
          <label class="visually-hidden" for={`title-${card.id}`}>Title</label>
          <input class="input" id={`title-${card.id}`} name="title" value={card.title} required maxlength={80} />
          <button class="btn btn-small">Save</button>
          <span class="form-error" data-yx-error></span>
        </form>
      </details>
      {/* Drag and drop needs JavaScript, so moves have buttons too (plain forms: they work without it). */}
      <div class="card-moves">
        {STATUSES.filter(([s]) => s !== status).map(([s, label]) => (
          <form action={() => page.move({ card: card.id, to: s })}>
            <button class="btn btn-ghost btn-small" aria-label={`Move ${card.title} to ${label}`}>{label}</button>
          </form>
        ))}
      </div>
    </li>
  );
}

/**
 * The staff kanban board. Columns are drop targets (`trigger="drop"`, the
 * lambda's `drag` is the card that landed), cards are drop targets for
 * "put it above this one", and the bin only takes cards (`drop:.card`).
 */
@route("/board", { group: Admin, meta: { title: "Staff board", area: "board" } })
export class BoardPage {
  @inject(Board) accessor board!: Board;
  @auth.user accessor me!: User;

  @get page() {
    return (
      <>
        <h1 class="page-title">Staff board</h1>
        <div data-yx-live="/admin/board/events" hidden></div>
        <form class="new-card" action={this.add} data-yx-reset>
          <label class="visually-hidden" for="new-card">New card</label>
          <input class="input" id="new-card" name="title" placeholder="What needs doing around the shop?" required maxlength={80} autocomplete="off" />
          <button class="btn">Add card</button>
          <span class="form-error" data-yx-error></span>
        </form>
        {this.columns()}
        <div class="bin" action={({ drag }) => this.remove({ id: drag.data("id") })} trigger="drop:.card" data-yx-confirm="Throw this card away?">
          Drop a card here to bin it
        </div>
      </>
    );
  }

  columns() {
    return (
      <Region id="board" class="board">
        {STATUSES.map(([status, label]) => (
          <section class="column" data-status={status} action={({ drag }) => this.move({ card: drag.data("id"), to: status })} trigger="drop">
            <h2>
              {label} <span class="badge">{this.board.column(status).length}</span>
            </h2>
            <ul class="cards">
              {this.board.column(status).map((card) => <CardItem card={card} status={status} page={this} />)}
            </ul>
          </section>
        ))}
      </Region>
    );
  }

  @action add(_: {}, form: ActionForm) {
    this.board.add(form.parse(CardTitle).title, this.me.name);
    return this.columns();
  }

  @action rename({ id }: { id: string }, form: ActionForm) {
    this.board.rename(id, form.parse(CardTitle).title);
    return this.columns();
  }

  /** The ids come from the browser (`drag.data("id")`, read when the card lands), so they're validated like any input. */
  @action move(args: { card: string; to: Status; before?: string }) {
    this.board.move(parse(MoveCard, args));
    return this.columns();
  }

  @action remove({ id }: { id: string }) {
    this.board.remove(parse(CardRef, { card: id }).card);
    return this.columns();
  }
}
