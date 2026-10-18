import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ILogger, Region, action, get, route, yerd, type ActionForm, type LogRecord, type RunningServer } from "@toyz/yerd";

const seen: unknown[] = [];

@route("/lab")
class Lab {
  @get page() {
    return (
      <main>
        <form action={() => this.remove({ id: "a1" })}><button>x</button></form>
        <form action={({ form }) => this.rename({ id: "a2" }, form)} trigger="change"><input name="title" /></form>
        <input id="q" action={({ el, ctx }) => this.search({ q: el.value, page: Number(ctx.query.get("page") ?? 1), on: el.checked })} trigger="input 250ms" />
        <div id="more" action={({ ref }) => this.search({ q: ref("#q").value, page: 2, on: ref("#q").checked })} trigger="visible" />
        <button id="plain" action={() => this.remove({ id: "b" })}>b</button>
        <Region id="feed" as="ul" append><li>one</li></Region>
        <div id="zone" action={this.upload} trigger="drop:files" accept="image/*">Drop photos</div>
        <div id="staging" dropTo="#photos">Drop to add</div>
      </main>
    );
  }

  @action remove(args: { id: string }) {
    seen.push(["remove", args]);
  }

  @action rename(args: { id: string }, form: ActionForm) {
    seen.push(["rename", args, form.get("title")]);
  }

  @action upload(_: {}, form: ActionForm) {
    seen.push(["upload", form.files("files").map((f) => `${f.name}:${f.size}`)]);
  }

  @action search(args: { q: string; page: number; on: boolean }) {
    seen.push(["search", args]);
    return <Region id="hits">{args.q}</Region>;
  }
}

@route("/broken/none")
class NoAction {
  @get page() {
    return <button action={() => 1}>x</button>;
  }
}

@route("/broken/twice")
class Twice {
  @get page() {
    return <button action={() => (this.go(), this.go())}>x</button>;
  }
  @action go() {}
}

@route("/broken/compute")
class Compute {
  @get page() {
    return <input action={({ el }) => this.take({ q: el.value.trim() })} />;
  }
  @action take(_: { q: string }) {}
}

const records: LogRecord[] = [];

let server: RunningServer;
let pageHtml = "";
beforeAll(async () => {
  server = await yerd({ routes: [Lab, NoAction, Twice, Compute], services: [], handleSignals: false, secret: "l".repeat(32) })
    .services((s) => s.value(ILogger, { write: (r) => records.push(r) }))
    .listen(0, "127.0.0.1");
  pageHtml = await (await fetch(`${server.url}/lab?page=3`)).text();
});
afterAll(() => server.close());

function attr(id: string, name: string): string {
  const tag = new RegExp(`<[a-z]+ [^>]*id="${id}"[^>]*>`).exec(pageHtml)?.[0] ?? new RegExp(`<[a-z]+ id="${id}"[^>]*>`).exec(pageHtml)?.[0] ?? "";
  return (new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? "").replaceAll("&quot;", '"');
}

function post(fields: Record<string, string>) {
  return fetch(`${server.url}/lab`, { method: "POST", body: new URLSearchParams(fields), headers: { yx: "1", origin: server.url } });
}

describe("action lambdas", () => {
  it("render forms, triggers and element actions with signed tokens and holes", () => {
    expect(pageHtml).toMatch(/<form action="\/lab\?page=3" method="post" data-yx><input type="hidden" name="_yx" value="[\w-]+\.[\w-]+"><button>x<\/button><\/form>/);
    expect(pageHtml).toMatch(/<form action="\/lab\?page=3" method="post" data-yx data-yx-trigger="change">/);
    expect(attr("q", "data-yx-trigger")).toBe("input 250ms");
    expect(JSON.parse(attr("q", "data-yx-holes"))).toEqual([["el", "value"], ["el", "checked"]]);
    expect(JSON.parse(attr("more", "data-yx-holes"))).toEqual([["ref", "#q", "value"], ["ref", "#q", "checked"]]);
    expect(attr("plain", "data-yx-trigger")).toBe("click");
    expect(attr("plain", "data-yx-action")).toBe("/lab?page=3");
    expect(pageHtml).not.toMatch(/ action="[^/]/);
    expect(pageHtml).toContain('<ul id="feed" data-yx-region data-yx-append><li>one</li></ul>');
  });

  it("call the captured action with its args, holes filled and typed, ctx read at render", async () => {
    seen.length = 0;
    const r = await post({ _yx: attr("q", "data-yx-token"), _yxh0: "cats", _yxh1: "true" });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('<div id="hits" data-yx-region>cats</div>');
    expect(seen).toEqual([["search", { q: "cats", page: 3, on: true }]]);
  });

  it("pass the form through, and run the plain ones", async () => {
    seen.length = 0;
    const tokens = [...pageHtml.matchAll(/name="_yx" value="([^"]+)"/g)].map((m) => m[1]!);
    await post({ _yx: tokens[0]! });
    await post({ _yx: tokens[1]!, title: "new" });
    await post({ _yx: attr("plain", "data-yx-token") });
    expect(seen).toEqual([["remove", { id: "a1" }], ["rename", { id: "a2" }, "new"], ["remove", { id: "b" }]]);
  });

  it("flag tokens the server no longer accepts as stale, for the runtime to refresh", async () => {
    const r = await post({ _yx: "eyJ4IjoxfQ.bad" });
    expect(r.status).toBe(400);
    expect(r.headers.get("yx-stale")).toBe("1");
    // Without the runtime, it's the normal error page.
    const plain = await fetch(`${server.url}/lab`, { method: "POST", body: new URLSearchParams({ _yx: "eyJ4IjoxfQ.bad" }), headers: { origin: server.url } });
    expect(plain.headers.get("yx-stale")).toBeNull();
  });

  it("take dropped files as multipart", async () => {
    seen.length = 0;
    expect(attr("zone", "data-yx-trigger")).toBe("drop:files");
    expect(attr("zone", "accept")).toBe("image/*");
    expect(attr("staging", "data-yx-drop-to")).toBe("#photos");
    expect(pageHtml).not.toContain("dropTo");
    const body = new FormData();
    body.append("_yx", attr("zone", "data-yx-token"));
    body.append("files", new File(["abc"], "a.png", { type: "image/png" }));
    body.append("files", new File(["defg"], "b.png", { type: "image/png" }));
    const r = await fetch(`${server.url}/lab`, { method: "POST", body, headers: { yx: "1", origin: server.url } });
    expect(r.status).toBe(204);
    expect(seen).toEqual([["upload", ["a.png:3", "b.png:4"]]]);
  });

  it("refuse a token whose holes weren't sent (a plain post can't fill them)", async () => {
    seen.length = 0;
    const r = await post({ _yx: attr("more", "data-yx-token") });
    expect(r.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it("explain lambdas that call no action, two, or compute with live values", async () => {
    for (const [path, message] of [
      ["none", "must call an @action method"],
      ["twice", "calls one @action method, not 2"],
      ["compute", "el.value is filled in by the browser"],
    ] as const) {
      records.length = 0;
      const r = await fetch(`${server.url}/broken/${path}`);
      expect(r.status).toBe(500);
      expect(JSON.stringify(records)).toContain(message);
    }
  });
});
