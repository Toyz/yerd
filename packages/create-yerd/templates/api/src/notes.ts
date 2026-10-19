import { Conflict, NotFound, is, length, service, trim } from "@toyz/yerd";

export interface Note {
  id: number;
  title: string;
  body: string;
  done: boolean;
}

/** The body of POST and PUT. Validated before the handler runs; every issue is reported at once. */
export class NoteInput {
  @is.string({ transform: trim, validate: length(1, 120) }) title!: string;
  @is.string({ transform: trim, validate: length(0, 2000) }) body = "";
  @is.boolean() done = false;
}

/** A 404 whose JSON carries the id: `{"error":"No note 7","code":"not_found","id":7}`. */
export class NoteNotFound extends NotFound {
  constructor(readonly id: number) {
    super(`No note ${id}`, { details: { id } });
  }
}

/** Notes, in memory. A singleton: swap in a database when you have one. */
@service
export class Notes {
  #notes: Note[] = [{ id: 1, title: "Read the yerd guides", body: "https://toyz.github.io/yerd/", done: false }];
  #next = 2;

  list(done?: boolean): Note[] {
    return done === undefined ? this.#notes : this.#notes.filter((n) => n.done === done);
  }

  /** The note, or a 404 for the request. */
  find(id: number): Note {
    const note = this.#notes.find((n) => n.id === id);
    if (!note) throw new NoteNotFound(id);
    return note;
  }

  create(input: NoteInput): Note {
    this.#unique(input.title);
    const note = { id: this.#next++, ...input };
    this.#notes.push(note);
    return note;
  }

  update(id: number, input: NoteInput): Note {
    const note = this.find(id);
    this.#unique(input.title, id);
    return Object.assign(note, input);
  }

  remove(id: number): void {
    this.find(id);
    this.#notes = this.#notes.filter((n) => n.id !== id);
  }

  /** Titles are unique: a 409 with a code clients can switch on. */
  #unique(title: string, except?: number): void {
    if (this.#notes.some((n) => n.id !== except && n.title.toLowerCase() === title.toLowerCase())) {
      throw new Conflict(`A note called "${title}" already exists`, { code: "duplicate_title" });
    }
  }
}
