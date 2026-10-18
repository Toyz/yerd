import {
  ActionForm, YerdError, accepts, action, get, group, inject, negotiate, oneOf, param, query, redirect, route, setMeta,
} from "@toyz/yerd";
import { Ago } from "../attributes.js";
import { ImportForm, NewTodoForm, SharePanel, TodoList, Toolbar, type ListActions } from "../components.js";
import { AppShell, CardLayout, TodoCount } from "../layouts.js";
import { EditTodo, ImportTodos, NewTodo, TodoRepo, type Filter } from "../todos.js";
import { UserRepo, auth, type User } from "../users.js";
import { shareUrl } from "./share.js";

/** Everything inside the app chrome, signed in only. Prefix "/" so member routes keep their own paths. */
@group("/", { layout: AppShell, meta: { nav: "todos" }, guards: [auth.required] })
export class App {}

/** One todo's pages: nested in App, so they get the app shell *and* the card layout. */
@group("/todos/:id", { group: App, layout: CardLayout })
export class TodoPages {}

@route("/todos", { group: App, meta: { title: "Todos" } })
export class TodoListPage implements ListActions {
  @inject(TodoRepo) accessor repo!: TodoRepo;
  @inject(UserRepo) accessor users!: UserRepo;
  @auth.user accessor me!: User;

  /** Only this user's todos. */
  get todos() {
    return this.repo.for(this.me.id);
  }
  @query("filter", { transform: oneOf("all", "active", "completed") }) accessor filter: Filter = "all";

  @get page() {
    if (this.filter !== "all") setMeta({ title: `${this.filter[0]!.toUpperCase()}${this.filter.slice(1)} todos` });
    return (
      <>
        <h1 class="page-title">What's next?</h1>
        <section class="panel">
          <NewTodoForm add={this.add} />
          <TodoList todos={this.todos.list(this.filter)} filter={this.filter} actions={this} />
          <Toolbar filter={this.filter} counts={this.todos.counts()} actions={this} />
        </section>
        <div class="extras">
          {this.sharePanel()}
          <ImportForm importFile={this.importFile} />
        </div>
      </>
    );
  }

  sharePanel() {
    const token = this.me.shareToken;
    return <SharePanel url={token ? shareUrl(token) : undefined} share={this.share} unshare={this.unshare} />;
  }

  /** Same URL, JSON for API clients: `curl -H 'accept: application/json' localhost:3000/todos?filter=active` */
  @get @accepts("json") data() {
    return { filter: this.filter, todos: this.todos.list(this.filter), ...this.todos.counts() };
  }

  /** Every Region an action can change. Returned from actions so one round trip updates them all. */
  regions() {
    return (
      <>
        <TodoList todos={this.todos.list(this.filter)} filter={this.filter} actions={this} />
        <Toolbar filter={this.filter} counts={this.todos.counts()} actions={this} />
        <TodoCount left={this.todos.counts().left} />
      </>
    );
  }

  @action add(_: {}, form: ActionForm) {
    this.todos.add(form.parse(NewTodo).title);
    return this.regions();
  }

  @action toggle({ id }: { id: string }) {
    this.todos.toggle(id);
    return this.regions();
  }

  @action rename({ id }: { id: string }, form: ActionForm) {
    const { title } = form.parse(NewTodo);
    if (!this.todos.get(id)) throw new YerdError(404, "That todo is gone");
    this.todos.update(id, { title });
    return this.regions();
  }

  @action remove({ id }: { id: string }) {
    this.todos.remove(id);
    return this.regions();
  }

  @action toggleAll() {
    this.todos.toggleAll();
    return this.regions();
  }

  @action clearCompleted() {
    this.todos.clearCompleted();
    return this.regions();
  }

  @action share() {
    this.users.share(this.me);
    return this.sharePanel();
  }

  @action unshare() {
    this.users.unshare(this.me);
    return this.sharePanel();
  }

  /** The upload: `is.file` in the DTO checks the type and size, then every non-blank line becomes a todo. */
  @action async importFile(_: {}, form: ActionForm) {
    const { file } = form.parse(ImportTodos);
    const titles = (await file.text()).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (titles.length === 0) throw new YerdError(400, "That file has no todos in it.");
    if (titles.length > 200) throw new YerdError(400, "That's more than 200 todos; split the file up.");
    const long = titles.findIndex((title) => title.length > 140);
    if (long >= 0) throw new YerdError(400, `Todo ${long + 1} is longer than 140 characters.`);
    this.todos.addMany(titles);
    return this.regions();
  }
}

@route("/", { group: TodoPages })
export class TodoDetailPage {
  @inject(TodoRepo) accessor repo!: TodoRepo;
  @auth.user accessor me!: User;

  /** Only this user's todos. */
  get todos() {
    return this.repo.for(this.me.id);
  }
  @param("id") accessor id!: string;

  #todo() {
    const todo = this.todos.get(this.id);
    if (!todo) throw new YerdError(404, "That todo doesn't exist (or was deleted).");
    return todo;
  }

  @get page() {
    const todo = this.#todo();
    // One handler, two representations: the card for browsers, the todo for API clients.
    return negotiate({ html: () => this.#card(), json: () => todo });
  }

  #card() {
    const todo = this.#todo();
    setMeta({ title: todo.title });
    return (
      <>
        <h1>{todo.title}</h1>
        <p class="meta-line">
          Created <Ago iso={todo.createdAt} /> · {todo.done ? "done" : "open"}
        </p>
        <form action={this.save}>
          <div class="field">
            <label for="title">Title</label>
            <input class="input" id="title" name="title" value={todo.title} required maxlength="140" />
          </div>
          <div class="field">
            <label for="notes">Notes</label>
            <textarea class="input" id="notes" name="notes" maxlength="2000" placeholder="Anything worth remembering">{todo.notes}</textarea>
          </div>
          <label class="checkbox">
            <input type="checkbox" name="done" checked={todo.done} /> Done
          </label>
          <p class="form-error" data-yx-error role="alert"></p>
          <div class="row">
            <button class="btn">Save changes</button>
          </div>
        </form>
        <form action={this.remove} data-yx-confirm="Delete this todo?" style={{ marginTop: "12px" }}>
          <button class="btn btn-ghost btn-danger">Delete todo</button>
        </form>
      </>
    );
  }

  @action save(_: {}, form: ActionForm) {
    this.#todo();
    const edit = form.parse(EditTodo);
    this.todos.update(this.id, { title: edit.title, notes: edit.notes ?? "", done: form.has("done") });
    return redirect("/todos");
  }

  @action remove() {
    this.todos.remove(this.id);
    return redirect("/todos");
  }
}
