import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Channels, channel, inject, is, length, onBoot, onShutdown, service, trim } from "@toyz/yerd";

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
  version = 0;

  @onBoot async load() {
    if (this.#file === ":memory:") return;
    try {
      const data = JSON.parse(await readFile(this.#file, "utf8")) as Todo[];
      if (Array.isArray(data)) this.#todos = data.filter((t) => typeof t.owner === "string");
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
      .catch((error) => console.error("[todo] failed to save:", error));
  }
}

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

  counts() {
    const mine = this.#mine();
    const done = mine.filter((t) => t.done).length;
    return { total: mine.length, done, left: mine.length - done };
  }

  add(title: string): Todo {
    const now = new Date().toISOString();
    const todo: Todo = { id: randomUUID(), owner: this.owner, title, notes: "", done: false, createdAt: now, updatedAt: now };
    this.repo.all().push(todo);
    this.repo.changed(this.owner, { type: "added", todo });
    return todo;
  }

  update(id: string, patch: Partial<Pick<Todo, "title" | "notes" | "done">>): Todo | undefined {
    const todo = this.get(id);
    if (!todo) return undefined;
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
