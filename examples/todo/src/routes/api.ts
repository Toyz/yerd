import { body, del, get, inject, ndjson, param, post, res, route, signal, sse } from "@toyz/yerd";
import { NewTodo, TodoRepo } from "../todos.js";
import { auth, type User } from "../users.js";

/** Live updates: one SSE message per change. The client runtime refreshes the page's Regions on each. */
@route("/todos/events", { guards: [auth.required] })
export class TodoEvents {
  @inject(TodoRepo) accessor repo!: TodoRepo;
  @auth.user accessor me!: User;

  get todos() {
    return this.repo.for(this.me.id);
  }
  @signal accessor stop!: AbortSignal;

  @get @sse async *stream() {
    for await (const change of this.todos.watch(this.stop)) yield change;
  }
}

/** JSON API next to the HTML app. */
@route("/api/todos", { guards: [auth.required] })
export class TodosApi {
  @inject(TodoRepo) accessor repo!: TodoRepo;
  @auth.user accessor me!: User;

  get todos() {
    return this.repo.for(this.me.id);
  }
  @body(NewTodo) accessor input!: Promise<NewTodo>;

  @get list() {
    return { todos: this.todos.list(), ...this.todos.counts() };
  }

  @post async create() {
    const { title } = await this.input;
    return res(this.todos.add(title), { status: 201 });
  }
}

@route("/api/todos/:id", { guards: [auth.required] })
export class TodoApi {
  @inject(TodoRepo) accessor repo!: TodoRepo;
  @auth.user accessor me!: User;

  get todos() {
    return this.repo.for(this.me.id);
  }
  @param("id") accessor id!: string;

  @get show() {
    return this.todos.get(this.id) ?? 404;
  }

  @del remove() {
    return this.todos.remove(this.id) ? 204 : 404;
  }
}

/**
 * A live NDJSON feed: a snapshot line right away, then one line per change
 * (which todo, what happened, the new counts), for as long as the client stays
 * connected. Blank heartbeat lines keep proxies from closing a quiet connection.
 *
 * `curl -N localhost:3000/api/todos/changes.ndjson`
 */
@route("/api/todos/changes.ndjson", { guards: [auth.required] })
export class TodoChanges {
  @inject(TodoRepo) accessor repo!: TodoRepo;
  @auth.user accessor me!: User;

  get todos() {
    return this.repo.for(this.me.id);
  }
  @signal accessor stop!: AbortSignal;

  @get @ndjson({ heartbeat: 15_000 }) async *feed() {
    yield { type: "snapshot", version: this.repo.version, todos: this.todos.list(), ...this.todos.counts() };
    for await (const change of this.todos.watch(this.stop)) {
      yield { ...change, ...this.todos.counts(), at: new Date().toISOString() };
    }
  }
}

/** Export everything as NDJSON: `curl localhost:3000/api/todos.ndjson`. */
@route("/api/todos.ndjson", { guards: [auth.required] })
export class TodoExport {
  @inject(TodoRepo) accessor repo!: TodoRepo;
  @auth.user accessor me!: User;

  get todos() {
    return this.repo.for(this.me.id);
  }

  @get @ndjson async *export() {
    for (const todo of this.todos.list()) yield todo;
  }
}
