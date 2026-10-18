import { afterAll, describe, expect, it } from "vitest";
import {
  YerdError, action, body, currentContext, get, head, is, post, route, session, sse, status, yerd,
  type ActionForm, type Session,
} from "@toyz/yerd";

class NewTodo {
  @is.string() title!: string;
}

const todos: string[] = [];
let streamClosed = false;

@route("/todos")
class Todos {
  @body(NewTodo) accessor input!: Promise<NewTodo>;

  @get list() {
    return { todos };
  }

  @post @status(201) async add() {
    todos.push((await this.input).title);
    return { ok: true };
  }
}

@route("/empty")
class Empty {
  @get nothing() {
    return 204;
  }
  @head peek() {
    return 200;
  }
}

@route("/boom")
class Boom {
  @get page(): never {
    throw new YerdError(418, "short and stout");
  }
}

@route("/visits")
class Visits {
  @session accessor session!: Session<{ n?: number }>;
  @get count() {
    this.session.n = (this.session.n ?? 0) + 1;
    return { n: this.session.n, https: currentContext().url.protocol === "https:" };
  }
}

@route("/form")
class Form {
  @get page() {
    return (
      <form action={this.save}>
        <input name="title" />
      </form>
    );
  }
  @action save(_: {}, form: ActionForm) {
    todos.push(form.string("title"));
    return 204;
  }
}

@route("/ticks")
class Ticks {
  @get ticks() {
    return sse(
      (async function* () {
        try {
          for (let i = 0; ; i++) {
            yield { i };
            await new Promise((r) => setTimeout(r, 5));
          }
        } finally {
          streamClosed = true;
        }
      })(),
    );
  }
}

@route("/page")
class Page {
  @get page() {
    return (
      <html>
        <body>
          <h1>Hello</h1>
        </body>
      </html>
    );
  }
}

const app = yerd({ routes: [Todos, Empty, Boom, Visits, Form, Ticks, Page], services: [], handleSignals: false, secret: "p".repeat(32) })
  .errorPage(({ status, message }) => <p class="err">{status} {message}</p>)
  .sessions();
afterAll(() => app.stop());

describe("app.request: the pipeline with no server", () => {
  it("answers JSON, takes bodies, applies @status and returns Response objects", async () => {
    const add = await app.request("/todos", { method: "POST", body: JSON.stringify({ title: "milk" }), headers: { "content-type": "application/json" } });
    expect(add).toBeInstanceOf(Response);
    expect(add.status).toBe(201);
    expect(await add.json()).toEqual({ ok: true });
    const list = await app.request("/todos");
    expect(list.headers.get("content-type")).toMatch(/application\/json/);
    expect(await list.json()).toEqual({ todos: ["milk"] });
  });

  it("validates bodies like the real server", async () => {
    const bad = await app.request("/todos", { method: "POST", body: JSON.stringify({}), headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).issues[0].path).toBe("title");
  });

  it("204, HEAD and unknown paths", async () => {
    const empty = await app.request("/empty");
    expect(empty.status).toBe(204);
    expect(empty.body).toBeNull();
    expect((await app.request("/empty", { method: "HEAD" })).status).toBe(200);
    expect((await app.request("/nope")).status).toBe(404);
  });

  it("renders the error page for browsers and plain errors for others", async () => {
    const html = await app.request("/boom", { headers: { accept: "text/html" } });
    expect(html.status).toBe(418);
    expect(await html.text()).toBe('<p class="err">418 short and stout</p>');
    expect(await (await app.request("/boom")).text()).toBe("short and stout");
  });

  it("streams pages", async () => {
    const res = await app.request("/page");
    expect(await res.text()).toBe("<!doctype html><html><body><h1>Hello</h1></body></html>");
  });

  it("keeps a session when you pass its cookie back, and https URLs count as secure", async () => {
    const first = await app.request("/visits");
    expect(await first.json()).toEqual({ n: 1, https: false });
    const cookie = first.headers.getSetCookie()[0]!.split(";")[0]!;
    const second = await app.request("/visits", { headers: { cookie } });
    expect((await second.json()).n).toBe(2);
    const secure = await app.request("https://shop.example/visits");
    expect((await secure.json()).https).toBe(true);
    expect(secure.headers.getSetCookie()[0]).toMatch(/^__Host-yerd_session=.*; Secure/);
  });

  it("runs actions: a token from the page, posted back with the session", async () => {
    const page = await app.request("/form");
    const cookie = page.headers.getSetCookie()[0]?.split(";")[0] ?? "";
    const token = /name="_yx" value="([^"]+)"/.exec(await page.text())![1]!;
    const res = await app.request("/form", {
      method: "POST",
      body: new URLSearchParams({ _yx: token, title: "eggs" }),
      headers: { cookie, origin: "http://localhost", yx: "1" },
    });
    expect(res.status).toBe(204);
    expect(todos).toContain("eggs");
  });

  it("answers fetch Requests directly", async () => {
    const res = await app.fetch(new Request("http://localhost/todos"));
    expect(res.ok).toBe(true);
  });

  it("streams SSE as it goes, and cancelling the body is the client hanging up", async () => {
    const res = await app.request("/ticks");
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes('"i":1')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('data: {"i":0}');
    await reader.cancel();
    for (let i = 0; i < 20 && !streamClosed; i++) await new Promise((r) => setTimeout(r, 10));
    expect(streamClosed).toBe(true);
  });
});

@route("/bye")
class Bye {
  @session accessor session!: Session<{ n?: number }>;
  @post out() {
    this.session.destroy();
    return 204;
  }
}

describe("app.client(): a cookie-keeping test client", () => {
  const withBye = yerd({ routes: [Visits, Form, Bye, Todos], services: [], handleSignals: false, secret: "q".repeat(32) }).sessions();
  afterAll(() => withBye.stop());

  it("carries the session between requests and forgets a deleted cookie", async () => {
    const client = withBye.client();
    expect((await (await client.request("/visits")).json()).n).toBe(1);
    expect((await (await client.request("/visits")).json()).n).toBe(2);
    expect(client.cookies.has("yerd_session")).toBe(true);
    expect((await client.request("/bye", { method: "POST" })).status).toBe(204);
    expect(client.cookies.has("yerd_session")).toBe(false);
    expect((await (await client.request("/visits")).json()).n).toBe(1);
  });

  it("submits a page's action form with its token and the session", async () => {
    const client = withBye.client();
    const res = await client.action("/form", { title: "jam" });
    expect(res.status).toBe(204);
    expect(todos).toContain("jam");
    await expect(client.action("/form", {}, { index: 3 })).rejects.toThrow(/No action on \/form at index 3 \(found 1\)/);
  });
});
