import { body, catches, currentContext, del, get, inject, ndjson, param, patch, post, res, route, signal, sse, status } from "@toyz/yerd";
import { NewTodo, TodoChanges, TodoNotFound, TodoRepo } from "../todos.js";
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

/**
 * The JSON API, next to the HTML app: a collection and its items, with the
 * same login (a browser session, or a 401 for scripts without one).
 *
 * ```sh
 * curl -b cookies.txt localhost:3000/api/todos
 * curl -b cookies.txt -H 'content-type: application/json' -d '{"title":"Buy milk"}' localhost:3000/api/todos
 * curl -b cookies.txt -X PATCH -H 'content-type: application/json' -d '{"done":true}' localhost:3000/api/todos/<id>
 * ```
 */
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

  /** 201 with the new todo, and where it lives (only known once it exists, hence ctx.setHeader). */
  @post @status(201) async create() {
    const todo = this.todos.add((await this.input).title);
    currentContext().setHeader("location", `/api/todos/${todo.id}`);
    return todo;
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
  /** All optional: only what was sent is changed. */
  @body(TodoChanges) accessor changes!: Promise<TodoChanges>;

  @get show() {
    return this.todos.find(this.id);
  }

  @patch async update() {
    return this.todos.update(this.id, await this.changes);
  }

  @del remove() {
    if (!this.todos.remove(this.id)) throw new TodoNotFound(this.id);
  }

  /** The store throws a domain error; this route decides it's a 404 with a JSON body. */
  @catches(TodoNotFound)
  notFound(error: TodoNotFound) {
    return res({ error: error.message, id: error.id }, { status: 404 });
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
export class TodoChangeFeed {
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
