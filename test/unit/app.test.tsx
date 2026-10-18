import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BootError, YerdError, args, between, field, get, header, layout, lower, matches, oneOf, param, params, post, query, route, toInt, trim, yerd,
  type Child, type RunningServer,
} from "@toyz/yerd";

function Root({ children }: { children: Child }) {
  return <html><head><title>test</title></head><body>{children}</body></html>;
}

function Card({ children }: { children: Child }) {
  return <section class="card">{children}</section>;
}

@route("/users/:id")
@layout(Card)
class UserPage {
  @param("id", { transform: toInt }) accessor id!: number;
  @query("tab") accessor tab = "posts";
  @header("x-test") accessor testHeader: string | undefined;

  @get
  show() {
    return <h1>user {this.id + 1} on {this.tab}{this.testHeader ? ` (${this.testHeader})` : ""}</h1>;
  }

  @post
  @args(field("name", { transform: trim, required: true }))
  update(name: string) {
    return { updated: this.id, name };
  }
}

@route("/users/new")
class NewUser {
  @get form() {
    return "new user form";
  }
}

@route("/api/:org/:repo")
class Repo {
  @params accessor p!: Record<string, string>;
  @get show() {
    return this.p;
  }
}

@route("/status/teapot")
class Teapot {
  @get brew() {
    return 418;
  }
}

@route("/fail")
class Fail {
  @get boom(): never {
    throw new Error("secret internals");
  }
  @post forbidden(): never {
    throw new YerdError(403, "not yours");
  }
}

@route("/void")
class Void {
  @post nothing() {}
}

@route("/search/:limit")
class Search {
  @param("limit", { transform: toInt, validate: between(1, 50) }) accessor limit!: number;
  @query("sort", { transform: [trim, lower, oneOf("asc", "desc")] }) accessor sort: "asc" | "desc" = "asc";
  @query("q", { required: true, validate: [matches(/^\w+$/, "q must be a word"), (q: string) => q !== "admin"] }) accessor q!: string;
  @header("x-page", { transform: toInt }) accessor page = 1;

  @get find() {
    return { limit: this.limit, sort: this.sort, q: this.q, page: this.page };
  }
}

let server: RunningServer;

beforeAll(async () => {
  const app = yerd({ routes: [UserPage, NewUser, Repo, Teapot, Fail, Void, Search] }).layout(Root);
  server = await app.listen(0, "127.0.0.1");
});

afterAll(() => server.close());

const at = (path: string, init?: RequestInit) => fetch(server.url + path, init);

describe("app", () => {
  it("renders a decorated route through route and root layouts", async () => {
    const r = await at("/users/7?tab=likes", { headers: { "x-test": "hey" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await r.text()).toBe(
      '<!doctype html><html><head><title>test</title></head><body><section class="card"><h1>user 8 on likes (hey)</h1></section></body></html>',
    );
  });

  it("falls back to the accessor initializer when the query param is missing", async () => {
    expect(await (await at("/users/1")).text()).toContain("user 2 on posts");
  });

  it("turns a bad parse into a 400 with the parser's message", async () => {
    const r = await at("/users/abc");
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('Expected an integer, got "abc"');
  });

  it("prefers static routes over params", async () => {
    expect(await (await at("/users/new")).text()).toBe("new user form");
  });

  it("serves json, statuses and 204s from the coercion table", async () => {
    expect(await (await at("/api/toyz/yerd")).json()).toEqual({ org: "toyz", repo: "yerd" });
    expect((await at("/status/teapot")).status).toBe(418);
    expect((await at("/void", { method: "POST" })).status).toBe(204);
    const updated = await at("/users/3", { method: "POST", body: new URLSearchParams({ name: "  Ada " }) });
    expect(await updated.json()).toEqual({ updated: 3, name: "Ada" });
    const nameless = await at("/users/3", { method: "POST" });
    expect(nameless.status).toBe(400);
    expect((await nameless.json()).error).toBe("Missing required form field: name");
  });

  it("answers 404, 405 with Allow, and HEAD via GET", async () => {
    expect((await at("/missing")).status).toBe(404);
    const r = await at("/users/new", { method: "DELETE" });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET, HEAD");
    const h = await at("/users/new", { method: "HEAD" });
    expect(h.status).toBe(200);
    expect(await h.text()).toBe("");
  });

  it("hides internal errors and exposes YerdError messages", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      const r = await at("/fail");
      expect(r.status).toBe(500);
      expect(await r.text()).toBe("Internal Server Error");
    } finally {
      console.error = quiet;
    }
    const f = await at("/fail", { method: "POST" });
    expect(f.status).toBe(403);
    expect(await f.text()).toBe("not yours");
  });

  it("runs transform pipelines left to right", async () => {
    const r = await at("/search/10?sort=%20DESC%20&q=moths", { headers: { "x-page": "3" } });
    expect(await r.json()).toEqual({ limit: 10, sort: "desc", q: "moths", page: 3 });
  });

  it("uses initializers for missing optional values", async () => {
    expect(await (await at("/search/5?q=x")).json()).toEqual({ limit: 5, sort: "asc", q: "x", page: 1 });
  });

  it("rejects values a pipeline step refuses", async () => {
    const tooBig = await at("/search/99?q=x");
    expect(tooBig.status).toBe(400);
    expect((await tooBig.json()).error).toBe("Must be from 1 to 50 (got 99)");
    const badSort = await at("/search/5?q=x&sort=sideways");
    expect((await badSort.json()).error).toBe('Expected one of asc, desc, got "sideways"');
  });

  it("runs validators in order with their own messages, or a generic one for false", async () => {
    const notWord = await at("/search/5?q=two%20words");
    expect(notWord.status).toBe(400);
    expect((await notWord.json()).error).toBe("q must be a word");
    const reserved = await at("/search/5?q=admin");
    expect(reserved.status).toBe(400);
    expect((await reserved.json()).error).toBe("Invalid query parameter: q");
  });

  it("answers 400 for a missing required value", async () => {
    const r = await at("/search/5");
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("Missing required query parameter: q");
  });

  it("sets nosniff on every response", async () => {
    expect((await at("/users/new")).headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("boot validation", () => {
  it("refuses to start on a @param missing from the pattern and on routes without verbs", async () => {
    @route("/things/:id")
    class BadParam {
      @param("thingId") accessor thingId!: string;
      @get show() {
        return this.thingId;
      }
    }
    @route("/empty")
    class NoVerbs {}

    const app = yerd({ routes: [BadParam, NoVerbs] });
    const error = await app.boot().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BootError);
    expect((error as BootError).problems).toEqual([
      "BadParam.thingId (@param): :thingId is not a parameter of /things/:id",
      "NoVerbs (/empty) has no verb methods (@get, @post, ...)",
    ]);
  });

  it("refuses duplicate routes", async () => {
    @route("/dup")
    class A {
      @get a() {
        return "a";
      }
    }
    @route("/dup")
    class B {
      @get b() {
        return "b";
      }
    }
    const error = (await yerd({ routes: [A, B] }).boot().catch((e: unknown) => e)) as BootError;
    expect(error.problems[0]).toMatch(/Duplicate route: GET \/dup/);
  });
});
