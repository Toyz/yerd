import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Channels, channel, inject, instrument, is, length, logger, onBoot, onShutdown, service, trim, type Logger } from "@toyz/yerd";

export interface Todo {
  id: string;
  /** The user who owns it. */
  owner: string;
  title: string;
  notes: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
}

export type Filter = "all" | "active" | "completed";

/** What changed, as sent on the live feeds. */
export type TodoChange =
  | { version: number; type: "added" | "updated"; todo: Todo }
  | { version: number; type: "removed"; id: string }
  | { version: number; type: "cleared" | "bulk"; ids: string[] };

type ChangeInput = TodoChange extends infer C ? (C extends unknown ? Omit<C, "version"> : never) : never;

/** One live channel per user: their todo changes and nobody else's. */
export const todoChannel = (userId: string) => channel<TodoChange>(`todos:${userId}`);

/** What the new-todo form submits. */
export class NewTodo {
  @is.string({ transform: trim, validate: length(1, 140) }) title!: string;
}

/** What the edit form on the detail page submits (the checkbox is read separately). */
export class EditTodo {
  @is.string({ transform: trim, validate: length(1, 140) }) title!: string;
  @is.string({ optional: true, transform: trim, validate: length(0, 2000) }) notes?: string;
}

/**
 * A PATCH body for the JSON API. Every field is optional, and a field the
 * client left out isn't on the instance at all, so merging it can't wipe the
 * others: `{ "done": true }` keeps the title and notes.
 */
export class TodoChanges {
  @is.string({ optional: true, transform: trim, validate: length(1, 140) }) title?: string;
  @is.string({ optional: true, transform: trim, validate: length(0, 2000) }) notes?: string;
  @is.boolean({ optional: true }) done?: boolean;
}

/** The import form: a plain-text file, one todo per line. */
export class ImportTodos {
  @is.file({ types: ["text/plain"], maxSize: 64 * 1024 }) file!: File;
}

/** A domain error, not an HTTP one: routes decide what it means (the JSON API maps it to a 404 with @catches). */
export class TodoNotFound extends Error {
  constructor(readonly id: string) {
    super(`No todo with id ${id}`);
  }
}

/**
 * The todo store: an in-memory list persisted to a JSON file. Set TODO_FILE to
 * choose the file, or ":memory:" to keep nothing on disk (tests).
 *
 * Routes never touch other users' todos: they work through `repo.for(userId)`,
 * a view that only sees (and only hears about) that user's todos.
 */
@service
export class TodoRepo {
  #todos: Todo[] = [];
  #saving: Promise<void> = Promise.resolve();
  readonly #file = process.env.TODO_FILE ?? join(process.cwd(), ".data", "todos.json");
  @inject(Channels) accessor channels!: Channels;
  /** Logs as "TodoRepo", from whichever request is running. */
  @logger accessor log!: Logger;
  version = 0;

  @onBoot async load() {
    if (this.#file === ":memory:") return;
    try {
      const data = JSON.parse(await readFile(this.#file, "utf8")) as Todo[];
      if (Array.isArray(data)) this.#todos = data.filter((t) => typeof t.owner === "string");
      this.log.info("loaded todos", { count: this.#todos.length, file: this.#file });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  @onShutdown async flush() {
    await this.#saving;
  }

  /** One user's todos. */
  for(owner: string): TodoList {
    return new TodoList(this, owner);
  }

  /** @internal */ all(): Todo[] {
    return this.#todos;
  }

  /** @internal */ replace(todos: Todo[]): void {
    this.#todos = todos;
  }

  /** @internal */ changed(owner: string, change: ChangeInput): void {
    this.version++;
    void this.channels.publish(todoChannel(owner), { version: this.version, ...change } as TodoChange);
    if (this.#file === ":memory:") return;
    const snapshot = JSON.stringify(this.#todos, null, 2);
    const file = this.#file;
    // Writes are serialized and atomic (write a temp file, then rename).
    this.#saving = this.#saving
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, snapshot);
        await rename(`${file}.tmp`, file);
      })
      .catch((error) => this.log.error("failed to save todos", { file, error }));
  }
}

/**
 * The log target for TodoList's spans, spelled out: the target defaults to the
 * class name, and the production bundle renames this class (TodoList$1) because
 * components.tsx has a TodoList too.
 */
const TARGET = "TodoList";

/** A user's view of the store. Every method only sees that user's todos. */
export class TodoList {
  constructor(
    private readonly repo: TodoRepo,
    readonly owner: string,
  ) {}

  #mine(): Todo[] {
    return this.repo.all().filter((t) => t.owner === this.owner);
  }

  list(filter: Filter = "all"): Todo[] {
    const mine = this.#mine();
    if (filter === "active") return mine.filter((t) => !t.done);
    if (filter === "completed") return mine.filter((t) => t.done);
    return mine;
  }

  get(id: string): Todo | undefined {
    return this.#mine().find((t) => t.id === id);
  }

  /** Like get(), but a missing todo is a TodoNotFound. */
  find(id: string): Todo {
    const todo = this.get(id);
    if (!todo) throw new TodoNotFound(id);
    return todo;
  }

  counts() {
    const mine = this.#mine();
    const done = mine.filter((t) => t.done).length;
    return { total: mine.length, done, left: mine.length - done };
  }

  add(title: string): Todo {
    const todo = this.#create(title);
    this.repo.all().push(todo);
    this.repo.changed(this.owner, { type: "added", todo });
    return todo;
  }

  /** Several at once (the import), as one change. Logged as a span with just the count, not every title. */
  @instrument({ target: TARGET, level: "info", skipAll: true, fields: (list, [titles]) => ({ owner: list.owner, count: titles.length }) })
  addMany(titles: string[]): Todo[] {
    const added = titles.map((title) => this.#create(title));
    this.repo.all().push(...added);
    this.repo.changed(this.owner, { type: "bulk", ids: added.map((t) => t.id) });
    return added;
  }

  #create(title: string): Todo {
    const now = new Date().toISOString();
    return { id: randomUUID(), owner: this.owner, title, notes: "", done: false, createdAt: now, updatedAt: now };
  }

  /**
   * Merge `patch` into a todo. Notes are the user's own words, so the span
   * leaves them out ("patch.notes" is checked by the compiler: a typo there
   * doesn't build) and skips the return value, which carries them too.
   */
  @instrument({ target: TARGET, skip: ["patch.notes"], ret: false })
  update(id: string, patch: Partial<Pick<Todo, "title" | "notes" | "done">>): Todo {
    const todo = this.find(id);
    Object.assign(todo, patch, { updatedAt: new Date().toISOString() });
    this.repo.changed(this.owner, { type: "updated", todo });
    return todo;
  }

  toggle(id: string): void {
    const todo = this.get(id);
    if (todo) this.update(id, { done: !todo.done });
  }

  toggleAll(): void {
    const mine = this.#mine();
    const done = mine.some((t) => !t.done);
    const now = new Date().toISOString();
    for (const todo of mine) Object.assign(todo, { done, updatedAt: now });
    this.repo.changed(this.owner, { type: "bulk", ids: mine.map((t) => t.id) });
  }

  remove(id: string): boolean {
    if (!this.get(id)) return false;
    this.repo.replace(this.repo.all().filter((t) => t.id !== id));
    this.repo.changed(this.owner, { type: "removed", id });
    return true;
  }

  clearCompleted(): void {
    const ids = this.#mine().filter((t) => t.done).map((t) => t.id);
    this.repo.replace(this.repo.all().filter((t) => !ids.includes(t.id)));
    this.repo.changed(this.owner, { type: "cleared", ids });
  }

  /** This user's changes, until `signal` aborts (their channel; queued per subscriber). */
  watch(signal: AbortSignal): AsyncGenerator<TodoChange> {
    return this.repo.channels.subscribe(todoChannel(this.owner), signal);
  }
}
