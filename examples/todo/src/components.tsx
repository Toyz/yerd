import { Form, Region, type Action, type ActionForm } from "@toyz/yerd";
import { Ago } from "./attributes.js";
import type { Filter, Todo } from "./todos.js";

/** The actions the list needs, passed down from the route. */
export interface ListActions {
  toggle: Action<{ id: string }>;
  rename: (args: { id: string }, form: ActionForm) => unknown;
  remove: Action<{ id: string }>;
  clearCompleted: Action;
  toggleAll: Action;
}

const FILTERS: Array<[Filter, string]> = [
  ["all", "All"],
  ["active", "Active"],
  ["completed", "Completed"],
];

function TodoItem({ todo, actions }: { todo: Todo; actions: ListActions }) {
  return (
    <li key={todo.id} class={["todo", { done: todo.done }]}>
      {/* A real submit button, so toggling works without JavaScript too. */}
      <Form action={actions.toggle} args={{ id: todo.id }}>
        <button class="check" aria-pressed={todo.done ? "true" : "false"} aria-label={todo.done ? `Mark "${todo.title}" as not done` : `Mark "${todo.title}" as done`}>
          ✓
        </button>
      </Form>
      <div class="todo-main">
        <a class="todo-title" href={`/todos/${todo.id}`} data-yx-boost prefetch>{todo.title}</a>
        <span class="todo-sub">
          {/* A custom attribute: "just now" from the server, kept fresh by its client half. */}
          <Ago iso={todo.createdAt} />
          {todo.notes ? <span class="todo-notes">{todo.notes}</span> : null}
        </span>
      </div>
      {/* Quick rename: a <details>, so it opens without JavaScript. Morphing keeps it open while you type. */}
      <details class="edit">
        <summary class="btn btn-ghost">
          <span class="when-closed">Rename</span>
          <span class="when-open">Cancel</span>
        </summary>
        <Form class="edit-form" action={actions.rename} args={{ id: todo.id }}>
          <label class="visually-hidden" for={`title-${todo.id}`}>New title</label>
          <input class="input" id={`title-${todo.id}`} name="title" value={todo.title} required maxlength="140" />
          <button class="btn">Save</button>
          <span class="form-error" data-yx-error></span>
        </Form>
      </details>
      <Form action={actions.remove} args={{ id: todo.id }}>
        <button class="btn btn-ghost btn-danger" aria-label={`Delete "${todo.title}"`}>Delete</button>
      </Form>
    </li>
  );
}

/** The list itself: a Region, so actions and live refreshes can replace it in place. */
export function TodoList({ todos, filter, actions }: { todos: Todo[]; filter: Filter; actions: ListActions }) {
  return (
    <Region id="todo-list" as="ul" class="todo-list" aria-label="Todos">
      {todos.length === 0 ? (
        <li class="empty">
          <strong>{filter === "completed" ? "Nothing finished yet" : filter === "active" ? "All caught up" : "No todos yet"}</strong>
          {filter === "all" ? "Add one above to get started." : "Try another filter."}
        </li>
      ) : (
        todos.map((todo) => <TodoItem todo={todo} actions={actions} />)
      )}
    </Region>
  );
}

/** Filters, counts and bulk actions under the list. */
export function Toolbar({ filter, counts, actions }: { filter: Filter; counts: { total: number; done: number; left: number }; actions: ListActions }) {
  return (
    <Region id="todo-toolbar" class="toolbar">
      <span>
        {counts.left} of {counts.total} left
      </span>
      <nav class="filters" aria-label="Filter todos" data-yx-boost>
        {FILTERS.map(([value, label]) => (
          <a href={value === "all" ? "/todos" : `/todos?filter=${value}`} aria-current={filter === value ? "page" : undefined}>
            {label}
          </a>
        ))}
      </nav>
      <span>
        {counts.total > 0 ? (
          <form action={actions.toggleAll}>
            <button class="btn btn-ghost">{counts.left > 0 ? "Complete all" : "Reopen all"}</button>
          </form>
        ) : null}
        {counts.done > 0 ? (
          <form action={actions.clearCompleted} data-yx-confirm={`Delete ${counts.done} completed todo${counts.done === 1 ? "" : "s"}?`}>
            <button class="btn btn-ghost btn-danger">Clear completed</button>
          </form>
        ) : null}
      </span>
    </Region>
  );
}

/** The add form. data-yx-reset clears it after a successful add; errors land in data-yx-error. */
export function NewTodoForm({ add }: { add: Action }) {
  return (
    <form action={add} data-yx-reset>
      <div class="new-todo">
        <label class="visually-hidden" for="new-title">What needs doing?</label>
        <input class="input" id="new-title" name="title" placeholder="What needs doing?" autocomplete="off" autofocus required maxlength="140" />
        <button class="btn">Add</button>
      </div>
      <p class="form-error" data-yx-error role="alert"></p>
    </form>
  );
}

/** Sharing: a Region, so turning the link on or off updates it in place. */
export function SharePanel({ url, share, unshare }: { url: string | undefined; share: Action; unshare: Action }) {
  return (
    <Region id="share" class="panel extra">
      <h2>Share</h2>
      {url ? (
        <>
          <p>Anyone with this link can see your list (read-only).</p>
          <div class="share-link">
            <label class="visually-hidden" for="share-url">Share link</label>
            <input class="input" id="share-url" value={url} readonly />
            <a class="btn btn-ghost" href={url} target="_blank">Open</a>
          </div>
          <form action={unshare}>
            <button class="btn btn-ghost btn-danger">Stop sharing</button>
          </form>
        </>
      ) : (
        <>
          <p>Get a read-only link to your list, with a proper preview when you paste it in a chat.</p>
          <form action={share}>
            <button class="btn">Create link</button>
          </form>
        </>
      )}
    </Region>
  );
}

/**
 * Import from a .txt file. `enctype` matters without JavaScript; with it, the
 * runtime sends file forms as multipart on its own.
 */
export function ImportForm({ importFile }: { importFile: Action }) {
  return (
    <section class="panel extra">
      <h2>Import</h2>
      <p>A plain-text file, one todo per line.</p>
      <form action={importFile} enctype="multipart/form-data" data-yx-reset>
        <label class="visually-hidden" for="import-file">Todo file</label>
        <input class="input" id="import-file" type="file" name="file" accept=".txt,text/plain" required />
        <button class="btn">Import</button>
        <p class="form-error" data-yx-error role="alert"></p>
      </form>
    </section>
  );
}
