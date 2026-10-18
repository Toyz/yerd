import { expect, it } from "vitest";
import { args, body, del, get, is, param, patch, post, put, route, toInt, yerd } from "@toyz/yerd";

interface Todo { id: number; title: string; done: boolean }
const todos = new Map<number, Todo>([[1, { id: 1, title: "milk", done: false }]]);

class NewTodo {
  @is.string() title!: string;
}

/** Every field optional: a PATCH sends only what changes. */
class TodoChanges {
  @is.string({ optional: true }) title?: string;
  @is.boolean({ optional: true }) done?: boolean;
}

/** PUT replaces the whole thing, so everything is required. */
class TodoReplacement {
  @is.string() title!: string;
  @is.boolean() done!: boolean;
}

@route("/patch/todos")
class TodoList {
  @body(NewTodo) accessor input!: Promise<NewTodo>;

  @post async create() {
    const { title } = await this.input;
    const todo = { id: todos.size + 1, title, done: false };
    todos.set(todo.id, todo);
    return todo;
  }
}

@route("/patch/todos/:id")
class TodoItem {
  @param("id", { transform: toInt }) accessor id!: number;

  // One body accessor per shape. They're promises: nothing is read or
  // validated until a handler awaits one, so each verb uses its own.
  @body(TodoChanges) accessor changes!: Promise<TodoChanges>;

  @get show() {
    return todos.get(this.id) ?? 404;
  }

  @patch async update() {
    const todo = todos.get(this.id);
    if (!todo) return 404;
    // Only the fields the client sent are on `changes`, so this can't wipe the others.
    Object.assign(todo, await this.changes);
    return todo;
  }

  // The same thing as method parameters, for those who prefer them to fields.
  @put @args(param("id", { transform: toInt }), body(TodoReplacement))
  replace(id: number, next: TodoReplacement) {
    if (!todos.has(id)) return 404;
    const todo = { id, ...next };
    todos.set(id, todo);
    return todo;
  }

  @del remove() {
    return todos.delete(this.id) ? 204 : 404;
  }
}

it("PATCH takes the id from the URL and a partial body; PUT a full one", async () => {
  const server = await yerd({ routes: [TodoList, TodoItem], services: [], handleSignals: false }).listen(0, "127.0.0.1");
  const send = (method: string, path: string, data?: unknown) =>
    fetch(server.url + path, { method, body: data === undefined ? undefined : JSON.stringify(data), headers: { "content-type": "application/json" } });
  try {
    expect(await (await send("PATCH", "/patch/todos/1", { done: true })).json()).toEqual({ id: 1, title: "milk", done: true });
    expect(await (await send("PATCH", "/patch/todos/1", { title: "oat milk" })).json()).toEqual({ id: 1, title: "oat milk", done: true });
    const bad = await send("PATCH", "/patch/todos/1", { done: "yes please" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { issues: unknown[] }).issues).toEqual([{ path: "done", message: "Expected a boolean" }]);
    expect((await send("PATCH", "/patch/todos/99", { done: true })).status).toBe(404);
    expect(await (await send("PUT", "/patch/todos/1", { title: "eggs", done: false })).json()).toEqual({ id: 1, title: "eggs", done: false });
    expect((await send("PUT", "/patch/todos/1", { title: "eggs" })).status).toBe(400);
    expect((await send("POST", "/patch/todos", { title: "bread" })).status).toBe(200);
    expect((await send("DELETE", "/patch/todos/2")).status).toBe(204);
  } finally {
    await server.close();
  }
});
