// The CSRF nonce: created when a token is first signed, so visitors never shown a form get no session.
import { describe, expect, it } from "vitest";
import { MemoryStore, action, get, route, yerd, type Child } from "@toyz/yerd";

const SECRET = "n".repeat(32);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hits: string[] = [];

async function Soon() {
  await Promise.resolve();
  return <p>soon</p>;
}

async function Slow({ children }: { children?: Child }) {
  await sleep(10);
  return <section>{children}</section>;
}

@route("/plain")
class Plain {
  @get page() {
    return <main><h1>no forms here</h1><Soon /></main>;
  }
}

@route("/form")
class FormPage {
  @get page() {
    return <main><form action={this.go}><button>go</button></form></main>;
  }
  @action go() {
    hits.push("form");
  }
}

@route("/late-form")
class LateForm {
  @get page() {
    return <main><h1>top</h1><Slow><form action={this.go}><button>go</button></form></Slow></main>;
  }
  @action go() {
    hits.push("late-form");
  }
}

@route("/soon-form")
class SoonForm {
  @get page() {
    return <main><Soon /><button action={this.go}>go</button></main>;
  }
  @action go() {
    hits.push("soon-form");
  }
}

@route("/slow-plain")
class SlowPlain {
  @get page() {
    return <main><Slow><p>nothing to post</p></Slow></main>;
  }
}

function app(store: MemoryStore) {
  return yerd({ routes: [Plain, FormPage, LateForm, SoonForm, SlowPlain], services: [], handleSignals: false, secret: SECRET })
    .sessions({ store })
    .errorPage(({ status }) => <p>error {status}</p>);
}

const html = { headers: { accept: "text/html" } };

describe("the CSRF nonce for a visitor with no session", () => {
  it("isn't created for a page without action forms, in an app that has actions", async () => {
    const store = new MemoryStore();
    const r = await app(store).request("/plain", html);
    expect(await r.text()).toContain("soon");
    expect(r.headers.getSetCookie()).toEqual([]);
    expect(r.headers.get("cache-control")).toBeNull();
    expect(store.size).toBe(0);
  });

  it("isn't created for an error page either", async () => {
    const store = new MemoryStore();
    const r = await app(store).request("/nope", html);
    expect(r.status).toBe(404);
    expect(r.headers.getSetCookie()).toEqual([]);
    expect(store.size).toBe(0);
  });

  it("is created by the page's first form, and its token works", async () => {
    const store = new MemoryStore();
    const client = app(store).client();
    hits.length = 0;
    const r = await client.action("/form");
    expect(r.status).toBe(204);
    expect(hits).toEqual(["form"]);
    expect(store.size).toBe(1);
  });

  it("is created for a form behind an async component that resolves at once", async () => {
    const store = new MemoryStore();
    const client = app(store).client();
    hits.length = 0;
    expect((await client.action("/soon-form")).status).toBe(204);
    expect(hits).toEqual(["soon-form"]);
  });

  it("is created before the headers when the page still has parts to stream, so a form rendered after them works", async () => {
    const store = new MemoryStore();
    const yerdApp = app(store);
    const first = await yerdApp.request("/late-form", html);
    // The session cookie went out with the headers, before the form was rendered.
    expect(first.headers.getSetCookie().length).toBe(1);
    expect(await first.text()).toContain('name="_yx"');

    const client = yerdApp.client();
    hits.length = 0;
    expect((await client.action("/late-form")).status).toBe(204);
    expect(hits).toEqual(["late-form"]);
    // Plain form posts (no script) too.
    expect((await client.action("/late-form", {}, { script: false })).status).toBe(303);
    expect(hits).toEqual(["late-form", "late-form"]);
  });

  it("is created for any page still streaming when its headers go, forms or not (a later part might render one)", async () => {
    const store = new MemoryStore();
    const r = await app(store).request("/slow-plain", html);
    await r.text();
    expect(r.headers.getSetCookie().length).toBe(1);
    // A HEAD never renders the rest, so it never needs one.
    const head = await app(store).request("/slow-plain", { method: "HEAD", ...html });
    expect(head.headers.getSetCookie()).toEqual([]);
  });

  it("isn't created twice: a visitor who has one keeps it, and their old tokens keep working", async () => {
    const store = new MemoryStore();
    const client = app(store).client();
    const page = await client.page("/form");
    const token = /name="_yx" value="([^"]+)"/.exec(page)![1]!.replace(/&amp;/g, "&").replace(/&quot;/g, '"');
    await client.page("/late-form");
    await client.page("/slow-plain");
    hits.length = 0;
    const r = await client.request("/form", { method: "POST", body: new URLSearchParams({ _yx: token }), headers: { yx: "1" } });
    expect(r.status).toBe(204);
    expect(hits).toEqual(["form"]);
  });
});
