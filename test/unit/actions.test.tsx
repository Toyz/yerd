import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ActionForm, Region, Scripts, action, get, is, length, redirect, route, trim, yerd,
  type Action, type RunningServer,
} from "@toyz/yerd";

class NewItem {
  @is.string({ transform: trim, validate: length(1, 50) }) title!: string;
}

const items: string[] = [];

function List({ remove }: { remove: Action<{ index: number }> }) {
  return (
    <Region id="items" as="ul">
      {items.map((title, index) => (
        <li key={title}>
          {title}
          <form action={() => remove({ index })} class="inline">
            <button>x</button>
          </form>
        </li>
      ))}
    </Region>
  );
}

@route("/items")
class Items {
  @get page() {
    return (
      <main>
        <Scripts />
        <List remove={this.remove} />
        <form action={this.add}>
          <input name="title" />
        </form>
      </main>
    );
  }

  @action add(_: {}, form: ActionForm) {
    items.push(form.parse(NewItem).title);
    return <List remove={this.remove} />;
  }

  @action remove({ index }: { index: number }) {
    items.splice(index, 1);
  }

  @action leave() {
    return redirect("/elsewhere");
  }
}

let server: RunningServer;
beforeAll(async () => {
  server = await yerd({ routes: [Items], services: [], handleSignals: false, secret: "x".repeat(32) }).listen(0, "127.0.0.1");
});
afterAll(() => server.close());

/** The add form is the last action form on the page. */
async function addToken(): Promise<string> {
  return (await pageTokens()).at(-1)!;
}

async function pageTokens(): Promise<string[]> {
  const html = await (await fetch(server.url + "/items")).text();
  return [...html.matchAll(/name="_yx" value="([^"]+)"/g)].map((m) => m[1]!);
}

function post(fields: Record<string, string>, headers: Record<string, string> = {}) {
  return fetch(server.url + "/items", { method: "POST", body: new URLSearchParams(fields), headers, redirect: "manual" });
}

describe("action forms", () => {
  it("render as POST forms to the owning route with a signed token and data-yx", async () => {
    const html = await (await fetch(server.url + "/items")).text();
    expect(html).toContain('<script type="module" src="/_yerd/runtime.js"></script>');
    expect(html).toMatch(/<form action="\/items" method="post" data-yx><input type="hidden" name="_yx" value="[\w-]+\.[\w-]+"><input name="title"><\/form>/);
    expect(html).toContain('<ul id="items" data-yx-region></ul>');
  });

  it("without JS: run the action, then 303 back to the referring page", async () => {
    items.length = 0;
    const [add] = await pageTokens();
    const r = await post({ _yx: add!, title: "  milk " }, { referer: `${server.url}/items?x=1` });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/items?x=1");
    expect(items).toEqual(["milk"]);
  });

  it("with JS: return the action's JSX bare, for the runtime to morph", async () => {
    items.length = 0;
    const [add] = await pageTokens();
    const r = await post({ _yx: add!, title: "eggs" }, { yx: "1" });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html.startsWith('<ul id="items" data-yx-region><li data-key="eggs">eggs<form action="/items" class="inline" method="post" data-yx>')).toBe(true);
  });

  it("passes bound args, signed; an action returning nothing is a 204 for scripts", async () => {
    items.splice(0, items.length, "a", "b", "c");
    const tokens = await pageTokens();
    // tokens: remove(0), remove(1), remove(2), add
    const r = await post({ _yx: tokens[1]! }, { yx: "1" });
    expect(r.status).toBe(204);
    expect(items).toEqual(["a", "c"]);
  });

  it("rejects tampered tokens and arguments", async () => {
    items.splice(0, items.length, "a", "b");
    const [first] = await pageTokens();
    const [data, sig] = first!.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(data!, "base64url").toString()), p: { index: 1 } })).toString("base64url");
    const r = await post({ _yx: `${forged}.${sig}` });
    expect(r.status).toBe(400);
    expect(await r.text()).toBe("Invalid action signature");
    expect(items).toEqual(["a", "b"]);
  });

  it("refuses cross-origin posts", async () => {
    const add = await addToken();
    const r = await post({ _yx: add, title: "x" }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });

  it("reports validation errors as JSON with issues", async () => {
    const add = await addToken();
    const r = await post({ _yx: add, title: "   " }, { yx: "1" });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "Validation failed", issues: [{ path: "title", message: "Expected a length from 1 to 50, got 0" }] });
  });

  it("turns redirects into yx-location for scripts", async () => {
    @route("/leave")
    class Leave {
      @get page() {
        return <form action={this.go}><button>go</button></form>;
      }
      @action go() {
        return redirect("/elsewhere");
      }
    }
    const own = await yerd({ routes: [Leave], services: [], handleSignals: false }).listen(0, "127.0.0.1");
    try {
      const html = await (await fetch(own.url + "/leave")).text();
      const token = /name="_yx" value="([^"]+)"/.exec(html)![1]!;
      const scripted = await fetch(own.url + "/leave", { method: "POST", body: new URLSearchParams({ _yx: token }), headers: { yx: "1" } });
      expect(scripted.headers.get("yx-location")).toBe("/elsewhere");
      const plain = await fetch(own.url + "/leave", { method: "POST", body: new URLSearchParams({ _yx: token }), redirect: "manual" });
      expect(plain.status).toBe(303);
      expect(plain.headers.get("location")).toBe("/elsewhere");
    } finally {
      await own.close();
    }
  });

  it("serves the client runtime", async () => {
    const r = await fetch(server.url + "/_yerd/runtime.js");
    expect(r.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const js = await r.text();
    expect(js.startsWith("(function yerdRuntime")).toBe(true);
    expect(js).toContain("data-yx-region");
  });
});
