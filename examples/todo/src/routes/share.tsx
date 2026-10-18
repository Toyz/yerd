import { YerdError, currentContext, get, inject, isBot, layout, oneOf, param, query, route, setMeta } from "@toyz/yerd";
import { Ago } from "../attributes.js";
import { MarketingLayout, SharedCard } from "../layouts.js";
import { TodoRepo, type Filter, type Todo } from "../todos.js";
import { UserRepo, type User } from "../users.js";

/**
 * A share link's absolute URL. ctx.url is built from the Host header and
 * always says http://, so behind a TLS proxy set PUBLIC_URL (https://todos.example.com).
 */
export function shareUrl(token: string): string {
  return new URL(`/share/${token}`, process.env.PUBLIC_URL ?? currentContext().url.origin).href;
}

const FILTERS: Array<[Filter, string]> = [
  ["all", "All"],
  ["active", "Open"],
  ["completed", "Done"],
];

/**
 * A read-only, public view of someone's list: no login, outside the app
 * group, and not prerendered (it's different for every token, and variants
 * need a request to test). Two layouts from one decorator, outermost first.
 *
 * Request variants: people get the live page (filters, times that tick, the
 * runtime); crawlers and link unfurlers (`@get(isBot)`) get one complete,
 * script-free document with everything in it. isBot reads the User-Agent,
 * so both answers carry `Vary: User-Agent` and a cache keeps them apart.
 */
@route("/share/:token")
@layout(MarketingLayout, SharedCard)
export class SharedList {
  @inject(TodoRepo) accessor repo!: TodoRepo;
  @inject(UserRepo) accessor users!: UserRepo;
  @param("token") accessor token!: string;
  @query("filter", { transform: oneOf("all", "active", "completed") }) accessor filter: Filter = "all";

  #owner(): User {
    const owner = this.users.byShareToken(this.token);
    if (!owner) throw new YerdError(404, "This link was turned off, or never existed.");
    return owner;
  }

  /** Title, description and canonical URL for the layout's <title>, meta description and Open Graph tags. */
  #describe(owner: User, todos: Todo[]) {
    const done = todos.filter((t) => t.done).length;
    const open = todos.filter((t) => !t.done).map((t) => t.title);
    const next = open.length > 0 ? ` Next up: ${open.slice(0, 3).join(", ")}${open.length > 3 ? "..." : ""}` : "";
    setMeta({
      title: `@${owner.name}'s todos`,
      description: `${done} of ${todos.length} done.${next}`,
      url: shareUrl(this.token),
    });
  }

  /** People: the interactive page. */
  @get page() {
    const owner = this.#owner();
    const todos = this.repo.for(owner.id).list();
    this.#describe(owner, todos);
    const shown = this.repo.for(owner.id).list(this.filter);
    return (
      <>
        <h1>@{owner.name}'s todos</h1>
        <p class="meta-line">
          {todos.filter((t) => t.done).length} of {todos.length} done · shared read-only
        </p>
        <nav class="filters" aria-label="Filter todos" data-yx-boost>
          {FILTERS.map(([value, label]) => (
            <a href={value === "all" ? `/share/${this.token}` : `/share/${this.token}?filter=${value}`} aria-current={this.filter === value ? "page" : undefined}>
              {label}
            </a>
          ))}
        </nav>
        <ul class="shared-list">
          {shown.length === 0 ? <li class="empty">Nothing here.</li> : null}
          {shown.map((todo) => (
            <li class={["todo", { done: todo.done }]}>
              <span class="check" aria-hidden="true">✓</span>
              <div class="todo-main">
                <span class="todo-title">{todo.title}</span>
                <span class="todo-sub">
                  <Ago iso={todo.createdAt} />
                  {todo.notes ? <span class="todo-notes">{todo.notes}</span> : null}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </>
    );
  }

  /** Crawlers: every todo with its full notes and plain dates, no filters, no client runtime. */
  @get(isBot) crawlable() {
    const owner = this.#owner();
    const todos = this.repo.for(owner.id).list();
    this.#describe(owner, todos);
    setMeta({ scripts: false });
    const date = (iso: string) => new Date(iso).toLocaleDateString("en", { dateStyle: "long" });
    return (
      <>
        <h1>@{owner.name}'s todos</h1>
        <p class="meta-line">
          {todos.filter((t) => t.done).length} of {todos.length} done
        </p>
        <ul class="shared-list">
          {todos.map((todo) => (
            <li class={["todo", { done: todo.done }]}>
              <span class="check" aria-hidden="true">✓</span>
              <div class="todo-main">
                <span class="todo-title">{todo.title}</span>
                <span class="todo-sub">
                  {todo.done ? "Done" : "Open"} · added <time datetime={todo.createdAt}>{date(todo.createdAt)}</time>
                </span>
                {todo.notes ? <p class="shared-notes">{todo.notes}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      </>
    );
  }
}
