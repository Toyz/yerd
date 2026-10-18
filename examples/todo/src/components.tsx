import { Region, bind, type Action, type ActionForm } from "@toyz/yerd";
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
      <form action={bind(actions.toggle, { id: todo.id })}>
        <button class="check" aria-pressed={todo.done ? "true" : "false"} aria-label={todo.done ? `Mark "${todo.title}" as not done` : `Mark "${todo.title}" as done`}>
          ✓
        </button>
      </form>
      <div class="todo-main">
        <a class="todo-title" href={`/todos/${todo.id}`} data-yx-boost prefetch>{todo.title}</a>
        {todo.notes ? <span class="todo-notes">{todo.notes}</span> : null}
      </div>
      {/* Quick rename: a <details>, so it opens without JavaScript. Morphing keeps it open while you type. */}
      <details class="edit">
        <summary class="btn btn-ghost">
          <span class="when-closed">Rename</span>
          <span class="when-open">Cancel</span>
        </summary>
        <form class="edit-form" action={bind(actions.rename, { id: todo.id })}>
          <label class="visually-hidden" for={`title-${todo.id}`}>New title</label>
          <input class="input" id={`title-${todo.id}`} name="title" value={todo.title} required maxlength="140" />
          <button class="btn">Save</button>
          <span class="form-error" data-yx-error></span>
        </form>
      </details>
      <form action={bind(actions.remove, { id: todo.id })}>
        <button class="btn btn-ghost btn-danger" aria-label={`Delete "${todo.title}"`}>Delete</button>
      </form>
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
