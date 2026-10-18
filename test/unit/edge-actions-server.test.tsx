import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ActionForm, HttpError, Region, action, bind, createGuard, get, guards, is, length, param, post, query, redirect, route, yerd,
  type RunningServer,
} from "@toyz/yerd";
import { safeNext } from "@toyz/yerd/auth";
import { signAction, type TokenPayload } from "../../src/actions/action.js";

const SECRET = "e".repeat(32);
const OLD = "o".repeat(32);
const seen: unknown[] = [];

class Note {
  @is.string({ validate: length(1, 5) }) title!: string;
  @is.number({ optional: true }) price?: number;
}

const blockAction = createGuard("blockAction", () => false);
const toLogin = createGuard("toLogin", () => "/login");

@route("/edge")
class Edge {
  @get page() {
    return (
      <main>
        <form action={this.add}><input name="title" /></form>
        <form action={this.add}>
          <button>save</button>
          <button formaction={() => this.remove({ id: "f1" })}>delete</button>
        </form>
        <button id="holes" action={({ el, ref }) => this.take({ v: el.value, on: el.checked, n: ref("#n").valueAsNumber, d: el.data("id") })}>h</button>
        <button id="bound" action={bind(this.remove, { id: "b1" })}>b</button>
      </main>
    );
  }

  @post plain(form: unknown) {
    seen.push(["plain-post", form]);
    return "plain";
  }

  @action add(_: {}, form: ActionForm) {
    seen.push(["add", form.get("title") ?? null]);
    return <Region id="r">{form.get("title") ?? ""}</Region>;
  }

  @action remove(args: { id: string }) {
    seen.push(["remove", args]);
  }

  @action take(args: unknown) {
    seen.push(["take", args]);
  }

  @action @guards(blockAction) locked() {
    seen.push(["locked"]);
  }

  @action @guards(toLogin) needsLogin() {
    seen.push(["needsLogin"]);
  }

  @action leave() {
    return redirect("/elsewhere?x=1");
  }

  @action fail() {
    throw new HttpError(422, "Nope, not that");
  }

  @action crash() {
    throw new Error("internal detail");
  }

  @action validate(_: {}, form: ActionForm) {
    form.parse(Note);
  }

  @action parsed(_: {}, form: ActionForm) {
    seen.push(["parsed", form.parse(Note)]);
  }

  @action upload(_: {}, form: ActionForm) {
    seen.push(["upload", form.files("doc").map((f) => `${f.name}:${f.size}`), form.get("title") ?? null]);
  }

  @action json() {
    return { ok: true };
  }

  // Not an action: a valid signature naming it must not run it.
  helper() {
    seen.push(["helper"]);
  }
}

@route("/edge/items/:id")
class Item {
  @param("id") accessor id!: string;
  @query("tab") accessor tab = "none";

  @get page() {
    return <form action={this.save}><button>save</button></form>;
  }

  @action save() {
    seen.push(["save", this.id, this.tab]);
  }
}

@route("/edge/files/*rest")
class Files {
  @param("rest") accessor rest!: string;
  @get page() {
    return <form action={this.touch}><button>t</button></form>;
  }
  @action touch() {
    seen.push(["touch", this.rest]);
  }
}

@route("/edge/other")
class Other {
  @get page() {
    return <p>other</p>;
  }
  @action ping() {
    seen.push(["ping"]);
  }
}

// A page rendering an action of another route: the form posts there, without this page's query.
@route("/edge/host")
class Host {
  @get page() {
    return <form action={new Other().ping}><button>p</button></form>;
  }
}

let server: RunningServer;
let rotated: RunningServer;
beforeAll(async () => {
  server = await yerd({ routes: [Edge, Item, Files, Other, Host], services: [], handleSignals: false, secret: [SECRET, OLD] }).listen(0, "127.0.0.1");
  rotated = await yerd({ routes: [Edge], services: [], handleSignals: false, secret: SECRET }).listen(0, "127.0.0.1");
});
afterAll(async () => {
  await server.close();
  await rotated.close();
});

const now = () => Math.floor(Date.now() / 1000);
const token = (a: string, p: unknown = {}, extra: Partial<TokenPayload> = {}, secret = SECRET) => signAction(secret, { c: "Edge", a, p, e: now() + 600, ...extra });

function post_(path: string, body: URLSearchParams | FormData | string, headers: Record<string, string> = {}, base = server.url) {
  return fetch(base + path, { method: "POST", body, headers: { origin: base, ...headers }, redirect: "manual" });
}

function fields(record: Record<string, string> | Array<[string, string]>) {
  return new URLSearchParams(record);
}

async function page(path: string): Promise<string> {
  return (await fetch(server.url + path)).text();
}

describe("which token runs", () => {
  it("the last _yx wins: a formaction button's token comes after the form's", async () => {
    seen.length = 0;
    const r = await post_("/edge", fields([["_yx", token("add")], ["_yx", token("remove", { id: "last" })]]), { yx: "1" });
    expect(r.status).toBe(204);
    expect(seen).toEqual([["remove", { id: "last" }]]);
  });

  it("a bad last token isn't rescued by a good earlier one", async () => {
    seen.length = 0;
    const r = await post_("/edge", fields([["_yx", token("add")], ["_yx", "junk.junk"]]));
    expect(r.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it("the rendered formaction button carries its own token as name=_yx", async () => {
    const html = await page("/edge");
    const button = /<button formaction="\/edge" formmethod="post" name="_yx" value="([^"]+)">delete<\/button>/.exec(html);
    expect(button).not.toBeNull();
    seen.length = 0;
    const formToken = [...html.matchAll(/name="_yx" value="([^"]+)"/g)][1]![1]!;
    await post_("/edge", fields([["_yx", formToken], ["_yx", button![1]!]]), { yx: "1" });
    expect(seen).toEqual([["remove", { id: "f1" }]]);
  });

  it.each([
    ["a method that isn't an action (a signature can't call arbitrary methods)", { a: "helper" }],
    ["the page handler", { a: "page" }],
    ["the @post handler", { a: "plain" }],
    ["constructor", { a: "constructor" }],
    ["__proto__", { a: "__proto__" }],
    ["toString", { a: "toString" }],
    ["an unknown class", { c: "Nope", a: "add" }],
    ["another route's class at this path", { c: "Other", a: "ping" }],
  ])("refuses %s as an unknown action", async (_name, change) => {
    seen.length = 0;
    const r = await post_("/edge", fields({ _yx: signAction(SECRET, { c: "Edge", p: {}, e: now() + 60, ...{ a: "add" }, ...change }) }));
    expect(r.status).toBe(400);
    expect(await r.text()).toBe("Unknown action");
    expect(seen).toEqual([]);
  });

  it("a token posted to another route's path is unknown there", async () => {
    const r = await post_("/edge/other", fields({ _yx: token("add") }));
    expect(r.status).toBe(400);
    expect(await r.text()).toBe("Unknown action");
  });

  it("without _yx, a form post goes to the route's @post handler", async () => {
    seen.length = 0;
    const r = await post_("/edge", fields({ title: "x" }));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("plain");
  });

  it("an empty _yx is a malformed token, not a plain post", async () => {
    const r = await post_("/edge", fields({ _yx: "" }));
    expect(r.status).toBe(400);
    expect(await r.text()).toBe("Malformed action token");
  });

  it("a JSON body naming _yx isn't an action", async () => {
    seen.length = 0;
    const r = await post_("/edge", JSON.stringify({ _yx: token("remove", { id: "j" }) }), { "content-type": "application/json" });
    expect(seen.some((entry) => (entry as unknown[])[0] === "remove")).toBe(false);
    expect(r.status).not.toBe(204);
  });

  it("a route with actions but no @post refuses a plain form post", async () => {
    const r = await post_("/edge/other", fields({ x: "1" }));
    expect(r.status).toBe(405);
  });
});

describe("expiry, rotation and staleness", () => {
  it("refuses an expired token with a 403, flagged stale for the runtime", async () => {
    seen.length = 0;
    const expired = token("remove", { id: "x" }, { e: now() - 5 });
    const scripted = await post_("/edge", fields({ _yx: expired }), { yx: "1" });
    expect(scripted.status).toBe(403);
    expect(scripted.headers.get("yx-stale")).toBe("1");
    expect(await scripted.text()).toBe("This form has expired; reload the page and try again");
    const plain = await post_("/edge", fields({ _yx: expired }));
    expect(plain.status).toBe(403);
    expect(plain.headers.get("yx-stale")).toBeNull();
    expect(seen).toEqual([]);
  });

  it("accepts a token signed with an older secret still in the list", async () => {
    seen.length = 0;
    const r = await post_("/edge", fields({ _yx: token("remove", { id: "old" }, {}, OLD) }), { yx: "1" });
    expect(r.status).toBe(204);
    expect(seen).toEqual([["remove", { id: "old" }]]);
  });

  it("refuses it once the secret is dropped, as stale", async () => {
    const r = await post_("/edge", fields({ _yx: token("remove", { id: "old" }, {}, OLD) }), { yx: "1" }, rotated.url);
    expect(r.status).toBe(400);
    expect(r.headers.get("yx-stale")).toBe("1");
  });

  it("an error the action throws is never flagged stale", async () => {
    const r = await post_("/edge", fields({ _yx: token("fail") }), { yx: "1" });
    expect(r.status).toBe(422);
    expect(r.headers.get("yx-stale")).toBeNull();
    expect(await r.text()).toBe("Nope, not that");
  });

  it("a crash in an action is a 500 that doesn't leak its message", async () => {
    const r = await post_("/edge", fields({ _yx: token("crash") }), { yx: "1" });
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain("internal detail");
  });

  it("accepts a prerendered token (no expiry) on its signature alone", async () => {
    seen.length = 0;
    const r = await post_("/edge", fields({ _yx: signAction(SECRET, { c: "Edge", a: "remove", p: { id: "pre" } }) }), { yx: "1" });
    expect(r.status).toBe(204);
    expect(seen).toEqual([["remove", { id: "pre" }]]);
  });
});

describe("cross-site posts", () => {
  const good = () => fields({ _yx: token("remove", { id: "cs" }) });

  it.each([
    ["another Origin", { origin: "https://evil.test" }, 403],
    ["an opaque Origin", { origin: "null" }, 403],
    ["Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }, 403],
    ["Sec-Fetch-Site same-site", { "sec-fetch-site": "same-site" }, 403],
    ["a foreign Referer and no Origin", { origin: "", referer: "https://evil.test/x" }, 403],
    ["no Origin, no Referer (not a browser page)", { origin: "" }, 204],
    ["Sec-Fetch-Site same-origin", { origin: "", "sec-fetch-site": "same-origin" }, 204],
  ])("%s -> %i", async (_name, headers, status) => {
    seen.length = 0;
    const all: Record<string, string> = { origin: server.url, yx: "1", ...headers };
    for (const [k, v] of Object.entries(all)) if (v === "") delete all[k];
    const r = await fetch(server.url + "/edge", { method: "POST", body: good(), headers: all, redirect: "manual" });
    expect(r.status).toBe(status);
    expect(seen.length).toBe(status === 204 ? 1 : 0);
  });

  it("a cross-site post never reaches the action, even with a valid token", async () => {
    seen.length = 0;
    await post_("/edge", good(), { origin: "https://evil.test", yx: "1" });
    expect(seen).toEqual([]);
  });

  it("trustedOrigins lets one other origin in, and only that one", async () => {
    const own = await yerd({ routes: [Edge], services: [], handleSignals: false, secret: SECRET, trustedOrigins: ["https://admin.test/some/path"] }).listen(0, "127.0.0.1");
    try {
      const ok = await fetch(own.url + "/edge", { method: "POST", body: good(), headers: { origin: "https://admin.test", "sec-fetch-site": "cross-site", yx: "1" } });
      expect(ok.status).toBe(204);
      const no = await fetch(own.url + "/edge", { method: "POST", body: good(), headers: { origin: "https://admin.test:8443", yx: "1" } });
      expect(no.status).toBe(403);
    } finally {
      await own.close();
    }
  });

  it("csrf: false turns the check off (the token still has to verify)", async () => {
    const own = await yerd({ routes: [Edge], services: [], handleSignals: false, secret: SECRET, csrf: false }).listen(0, "127.0.0.1");
    try {
      const ok = await fetch(own.url + "/edge", { method: "POST", body: good(), headers: { origin: "https://evil.test", yx: "1" } });
      expect(ok.status).toBe(204);
      const bad = await fetch(own.url + "/edge", { method: "POST", body: fields({ _yx: "x.y" }), headers: { origin: "https://evil.test" } });
      expect(bad.status).toBe(400);
    } finally {
      await own.close();
    }
  });
});

describe("holes over HTTP", () => {
  const holesToken = async () => {
    const html = await page("/edge");
    return /id="holes" data-yx-action="\/edge" data-yx-token="([^"]+)"/.exec(html)![1]!;
  };

  it("renders the holes spec next to the token", async () => {
    const html = await page("/edge");
    const spec = /id="holes"[^>]*data-yx-holes="([^"]+)"/.exec(html)![1]!.replaceAll("&quot;", '"');
    expect(JSON.parse(spec)).toEqual([["el", "value"], ["el", "checked"], ["ref", "#n", "valueAsNumber"], ["el", "dataset", "id"]]);
  });

  it("fills and types every hole", async () => {
    seen.length = 0;
    const r = await post_("/edge", fields({ _yx: await holesToken(), _yxh0: "<b>v</b>", _yxh1: "true", _yxh2: "12.5", _yxh3: "card-7" }), { yx: "1" });
    expect(r.status).toBe(204);
    expect(seen).toEqual([["take", { v: "<b>v</b>", on: true, n: 12.5, d: "card-7" }]]);
  });

  it("a missing hole is a 400 and the action doesn't run", async () => {
    seen.length = 0;
    const r = await post_("/edge", fields({ _yx: await holesToken(), _yxh0: "v", _yxh1: "true", _yxh3: "d" }), { yx: "1" });
    expect(r.status).toBe(400);
    expect(r.headers.get("yx-stale")).toBeNull();
    expect(seen).toEqual([]);
  });

  it("extra _yxh fields and look-alike names add nothing", async () => {
    seen.length = 0;
    await post_("/edge", fields({ _yx: await holesToken(), _yxh0: "v", _yxh1: "false", _yxh2: "", _yxh3: "d", _yxh4: "evil", "_yxh0[x]": "1", __proto__: "p" }), { yx: "1" });
    expect(seen).toEqual([["take", { v: "v", on: false, n: 0, d: "d" }]]);
  });

  it("a hole sent twice takes the first value", async () => {
    seen.length = 0;
    await post_("/edge", fields([["_yx", await holesToken()], ["_yxh0", "one"], ["_yxh0", "two"], ["_yxh1", "true"], ["_yxh2", "1"], ["_yxh3", "d"]]), { yx: "1" });
    expect((seen[0] as [string, { v: string }])[1].v).toBe("one");
  });

  it("holes sent as multipart work too", async () => {
    seen.length = 0;
    const body = new FormData();
    for (const [k, v] of Object.entries({ _yx: await holesToken(), _yxh0: "m", _yxh1: "true", _yxh2: "3", _yxh3: "d" })) body.append(k, v);
    const r = await post_("/edge", body, { yx: "1" });
    expect(r.status).toBe(204);
    expect(seen).toEqual([["take", { v: "m", on: true, n: 3, d: "d" }]]);
  });

  it("a hole posted as a file isn't a value", async () => {
    seen.length = 0;
    const body = new FormData();
    for (const [k, v] of Object.entries({ _yx: await holesToken(), _yxh1: "true", _yxh2: "3", _yxh3: "d" })) body.append(k, v);
    body.append("_yxh0", new File(["x"], "x.txt"));
    const r = await post_("/edge", body, { yx: "1" });
    expect(r.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it("bind() renders and runs like the lambda", async () => {
    const html = await page("/edge");
    const t = /id="bound" data-yx-action="\/edge" data-yx-token="([^"]+)"/.exec(html)![1]!;
    expect(html).not.toMatch(/id="bound"[^>]*data-yx-holes/);
    seen.length = 0;
    await post_("/edge", fields({ _yx: t }), { yx: "1" });
    expect(seen).toEqual([["remove", { id: "b1" }]]);
  });
});

describe("params, query and other routes", () => {
  it.each([
    ["/edge/items/42", "/edge/items/42"],
    ["/edge/items/42?tab=a&b=2", "/edge/items/42?tab=a&b=2"],
    ["/edge/items/a%20b%2Fc", "/edge/items/a%20b%2Fc"],
    ["/edge/items/%3Cx%3E%22", "/edge/items/%3Cx%3E%22"],
  ])("a form on %s posts to %s", async (path, expected) => {
    const html = await page(path);
    const url = /<form action="([^"]+)"/.exec(html)![1]!.replaceAll("&amp;", "&");
    expect(url).toBe(expected);
  });

  it("the action sees the page's params and query", async () => {
    const html = await page("/edge/items/a%20b?tab=posts");
    const t = /name="_yx" value="([^"]+)"/.exec(html)![1]!;
    seen.length = 0;
    await post_("/edge/items/a%20b?tab=posts", fields({ _yx: t }), { yx: "1" });
    expect(seen).toEqual([["save", "a b", "posts"]]);
  });

  // The token signs the class, action and args, not the URL: params and query are
  // request data like any other, so the action checks them (documented).
  it("a token from one item works on another item's URL", async () => {
    const html = await page("/edge/items/1");
    const t = /name="_yx" value="([^"]+)"/.exec(html)![1]!;
    seen.length = 0;
    await post_("/edge/items/2?tab=x", fields({ _yx: t }), { yx: "1" });
    expect(seen).toEqual([["save", "2", "x"]]);
  });

  it("a wildcard param is filled into the URL", async () => {
    const html = await page("/edge/files/a/b.txt");
    expect(html).toContain('<form action="/edge/files/a%2Fb.txt" method="post" data-yx>');
    const t = /name="_yx" value="([^"]+)"/.exec(html)![1]!;
    seen.length = 0;
    const r = await post_("/edge/files/a%2Fb.txt", fields({ _yx: t }), { yx: "1" });
    expect(r.status).toBe(204);
    expect(seen).toEqual([["touch", "a/b.txt"]]);
  });

  it("another route's action posts to that route, without this page's query", async () => {
    const html = await page("/edge/host?keep=1");
    expect(html).toMatch(/<form action="\/edge\/other" method="post" data-yx>/);
    const t = /name="_yx" value="([^"]+)"/.exec(html)![1]!;
    seen.length = 0;
    await post_("/edge/other", fields({ _yx: t }), { yx: "1" });
    expect(seen).toEqual([["ping"]]);
  });
});

describe("guards, redirects and responses", () => {
  it("a method guard on the action refuses it", async () => {
    seen.length = 0;
    const r = await post_("/edge", fields({ _yx: token("locked") }), { yx: "1" });
    expect(r.status).toBe(403);
    expect(r.headers.get("yx-stale")).toBeNull();
    expect(seen).toEqual([]);
  });

  it("a guard's redirect is yx-location with JS and a 303 without", async () => {
    seen.length = 0;
    const scripted = await post_("/edge", fields({ _yx: token("needsLogin") }), { yx: "1" });
    expect(scripted.status).toBe(200);
    expect(scripted.headers.get("yx-location")).toBe("/login");
    const plain = await post_("/edge", fields({ _yx: token("needsLogin") }));
    expect(plain.status).toBe(303);
    expect(plain.headers.get("location")).toBe("/login");
    expect(seen).toEqual([]);
  });

  it("a redirect is yx-location with JS and a 303 without", async () => {
    const scripted = await post_("/edge", fields({ _yx: token("leave") }), { yx: "1" });
    expect(scripted.status).toBe(200);
    expect(scripted.headers.get("yx-location")).toBe("/elsewhere?x=1");
    expect(scripted.headers.get("location")).toBeNull();
    const plain = await post_("/edge", fields({ _yx: token("leave") }));
    expect(plain.status).toBe(303);
    expect(plain.headers.get("location")).toBe("/elsewhere?x=1");
  });

  it.each([
    ["the referring page", `/edge?from=1`, "/edge?from=1"],
    ["a referer on another host: the request path", "http://evil.test/x", "/edge"],
    ["a referer whose path resolves to //host: the request path", "/..//evil.test/x", "/edge"],
    ["no referer: the request path", undefined, "/edge"],
  ])("without JS, JSX goes back to %s", async (_name, referer, location) => {
    const headers: Record<string, string> = {};
    if (referer !== undefined) headers.referer = referer.startsWith("/") ? server.url + referer : referer;
    const r = await post_("/edge", fields({ _yx: token("add"), title: "t" }), headers);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(location);
  });

  it("JSX comes back bare with JS, and an object is sent as JSON either way", async () => {
    const r = await post_("/edge", fields({ _yx: token("add"), title: "<i>" }), { yx: "1" });
    expect(await r.text()).toBe('<div id="r" data-yx-region>&lt;i&gt;</div>');
    const json = await post_("/edge", fields({ _yx: token("json") }), { yx: "1" });
    expect(await json.json()).toEqual({ ok: true });
    const plainJson = await post_("/edge", fields({ _yx: token("json") }));
    expect(await plainJson.json()).toEqual({ ok: true });
  });

  it("validation errors are JSON with every issue by path", async () => {
    const r = await post_("/edge", fields({ _yx: token("validate"), title: "", price: "abc" }), { yx: "1" });
    expect(r.status).toBe(400);
    expect(r.headers.get("content-type")).toContain("json");
    const body = (await r.json()) as { error: string; issues: Array<{ path: string; message: string }> };
    expect(body.error).toBe("Validation failed");
    expect(body.issues.map((i) => i.path).sort()).toEqual(["price", "title"]);
  });

  it("parse() never sees the _yx fields", async () => {
    seen.length = 0;
    await post_("/edge", fields({ _yx: token("parsed"), _yxh0: "x", title: "ok" }), { yx: "1" });
    expect(seen).toEqual([["parsed", { title: "ok" }]]);
  });

  it("takes uploads as multipart; an empty file input counts as none", async () => {
    seen.length = 0;
    const body = new FormData();
    body.append("_yx", token("upload"));
    body.append("title", "t");
    body.append("doc", new File(["hello"], "a.txt", { type: "text/plain" }));
    body.append("doc", new File([], "", { type: "application/octet-stream" }));
    const r = await post_("/edge", body, { yx: "1" });
    expect(r.status).toBe(204);
    expect(seen).toEqual([["upload", ["a.txt:5"], "t"]]);
  });
});

describe("safeNext", () => {
  it.each([
    ["/account", "/account"],
    ["/..//evil.test", "/"],
    ["//evil.test", "/"],
    ["https://evil.test", "/"],
    [null, "/"],
  ])("%j -> %j", (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });
});

describe("session-bound tokens", () => {
  let sessioned: RunningServer;
  beforeAll(async () => {
    sessioned = await yerd({ routes: [Edge], services: [], handleSignals: false, secret: SECRET }).sessions({}).listen(0, "127.0.0.1");
  });
  afterAll(() => sessioned.close());

  /** A browser: a cookie jar, and pages asked for as HTML. */
  function browser() {
    let jar = "";
    return {
      get jar() {
        return jar;
      },
      async fetch(path: string, init: RequestInit = {}) {
        const headers = { accept: "text/html", origin: sessioned.url, ...(init.headers as object), ...(jar ? { cookie: jar } : {}) };
        const r = await fetch(sessioned.url + path, { ...init, headers, redirect: "manual" });
        for (const c of r.headers.getSetCookie()) jar = /Max-Age=0/.test(c) ? "" : c.split(";")[0]!;
        return r;
      },
    };
  }

  async function addToken(b: ReturnType<typeof browser>): Promise<string> {
    const html = await (await b.fetch("/edge")).text();
    return /name="_yx" value="([^"]+)"/.exec(html)![1]!;
  }

  it("a page gives the visitor a session and its tokens carry the session's tag", async () => {
    const b = browser();
    const t = await addToken(b);
    expect(b.jar).toMatch(/^yerd_session=/);
    const payload = JSON.parse(Buffer.from(t.split(".")[0]!, "base64url").toString()) as TokenPayload;
    expect(payload.s).toMatch(/^[\w-]{22}$/);
    expect(typeof payload.e).toBe("number");
  });

  it("works in the session it was made for", async () => {
    const b = browser();
    const t = await addToken(b);
    seen.length = 0;
    const r = await b.fetch("/edge", { method: "POST", body: fields({ _yx: t, title: "mine" }), headers: { yx: "1" } });
    expect(r.status).toBe(200);
    expect(seen).toEqual([["add", "mine"]]);
  });

  it("is refused in another visitor's session, flagged stale", async () => {
    const victim = browser();
    const attacker = browser();
    const stolen = await addToken(attacker);
    await addToken(victim);
    seen.length = 0;
    const r = await victim.fetch("/edge", { method: "POST", body: fields({ _yx: stolen, title: "x" }), headers: { yx: "1" } });
    expect(r.status).toBe(403);
    expect(r.headers.get("yx-stale")).toBe("1");
    expect(seen).toEqual([]);
  });

  it("is refused with no session at all", async () => {
    const t = await addToken(browser());
    const r = await fetch(sessioned.url + "/edge", { method: "POST", body: fields({ _yx: t }), headers: { origin: sessioned.url } });
    expect(r.status).toBe(403);
  });

  it("a token without a session tag is refused while sessions are on", async () => {
    const b = browser();
    await addToken(b);
    const r = await b.fetch("/edge", { method: "POST", body: fields({ _yx: token("remove", { id: "x" }) }) });
    expect(r.status).toBe(403);
  });

  it("a prerendered token (no expiry, no tag) still works in any session", async () => {
    const b = browser();
    await addToken(b);
    seen.length = 0;
    const r = await b.fetch("/edge", { method: "POST", body: fields({ _yx: signAction(SECRET, { c: "Edge", a: "remove", p: { id: "p" } }) }), headers: { yx: "1" } });
    expect(r.status).toBe(204);
    expect(seen).toEqual([["remove", { id: "p" }]]);
  });

  it("a page fetched without Accept: text/html still renders forms that work", async () => {
    let jar = "";
    const r = await fetch(sessioned.url + "/edge", { headers: { accept: "*/*" } });
    for (const c of r.headers.getSetCookie()) jar = c.split(";")[0]!;
    const t = /name="_yx" value="([^"]+)"/.exec(await r.text())![1]!;
    seen.length = 0;
    const posted = await fetch(sessioned.url + "/edge", { method: "POST", body: fields({ _yx: t, title: "a" }), headers: { origin: sessioned.url, yx: "1", ...(jar ? { cookie: jar } : {}) } });
    expect(posted.status).toBe(200);
  });
});
