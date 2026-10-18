import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ActionForm, YerdError, action, body, createGuard, currentContext, file, files, is, every, get, onBoot, post, res, resolve, route, service, yerd,
  type Child, type LayoutProps, type RunningServer,
} from "@toyz/yerd";

const deny = createGuard("deny", () => false);
let wiped = 0;

@route("/vault")
class Vault {
  @get page() {
    return (
      <main>
        <form action={this.wipe}><button>wipe</button></form>
        <form action={this.note}><button>note</button></form>
      </main>
    );
  }

  @deny @action wipe() {
    wiped++;
  }

  @action note() {
    return "noted";
  }

  /** A plain post that starts a session. */
  @post visit() {
    currentContext().session.set("visited" as never, true as never);
    return 204;
  }
}

@route("/upload")
class Upload {
  @get page() {
    return <form action={this.save} enctype="multipart/form-data"><input type="file" name="doc" /><input name="title" /></form>;
  }

  @action async save(_: {}, form: ActionForm) {
    const file = form.file("doc");
    return { title: form.get("title"), name: file?.name, text: await file?.text(), none: form.file("missing") ?? null };
  }
}

@route("/avatar")
class Avatar {
  @file("avatar", { required: true, types: ["image/*"], maxSize: 100 }) accessor avatar!: Promise<File>;
  @files("extra") accessor extra!: Promise<File[]>;

  @post async upload() {
    const avatar = await this.avatar;
    return { name: avatar.name, type: avatar.type, extra: (await this.extra).length };
  }
}

class Profile {
  @is.string() name!: string;
  @is.file({ types: ["image/*"], maxSize: 100 }) avatar!: File;
  @is.files({ optional: true, max: 2 }) attachments?: File[];
}

@route("/profile")
class ProfileRoute {
  @body(Profile) accessor profile!: Promise<Profile>;

  @get page() {
    return <form action={this.save} enctype="multipart/form-data"><input name="name" /></form>;
  }

  @post async create() {
    const p = await this.profile;
    return { name: p.name, avatar: p.avatar.name, attachments: p.attachments?.length ?? 0 };
  }

  @action save(_: {}, form: ActionForm) {
    const p = form.parse(Profile);
    return { via: "action", avatar: p.avatar.name };
  }
}

@route("/api/things")
class Things {
  @post create() {
    return { ok: true };
  }
}

@route("/headers")
class Headers {
  @get mixed() {
    return res("<b>hi</b>", { headers: { "Content-Type": "text/html; charset=utf-8", Vary: "cookie" } });
  }
}

function Boom(): Child {
  throw new YerdError(418, "short and stout");
}

@route("/boom")
class BoomPage {
  @get page() {
    return <main><Boom /></main>;
  }
}

@service
class Brand {
  name = "Yerd Co";
}

function Root({ children }: LayoutProps) {
  return <html><body><header>{resolve(Brand).name}</header>{children}</body></html>;
}

let server: RunningServer;
beforeAll(async () => {
  server = await yerd({
    routes: [Vault, Things, Headers, BoomPage, Upload, Avatar, ProfileRoute],
    services: [Brand],
    handleSignals: false,
    secret: "h".repeat(32),
    trustedOrigins: ["https://admin.example.com"],
  })
    .sessions()
    .layout(Root)
    .errorPage(({ status, message }) => <p class="err">{status} {message}</p>)
    .listen(0, "127.0.0.1");
});
afterAll(() => server.close());

/** fetch with a cookie jar. */
function client() {
  let jar = "";
  return async (path: string, init: RequestInit = {}) => {
    const r = await fetch(server.url + path, { redirect: "manual", ...init, headers: { cookie: jar, ...(init.headers as object) } });
    for (const c of r.headers.getSetCookie()) jar = c.split(";")[0]!;
    return r;
  };
}

async function tokens(c: ReturnType<typeof client>, path: string): Promise<string[]> {
  const html = await (await c(path, { headers: { accept: "text/html" } })).text();
  return [...html.matchAll(/name="_yx" value="([^"]+)"/g)].map((m) => m[1]!);
}

/** Send raw bytes, get the status line back. */
function rawRequest(text: string): Promise<string> {
  const { port } = new URL(server.url);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), "127.0.0.1", () => socket.write(text));
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\r\n")) {
        socket.destroy();
        resolve(data.split("\r\n")[0]!);
      }
    });
    socket.on("error", reject);
  });
}

describe("actions", () => {
  it("run their own method guards", async () => {
    const c = client();
    const [wipe] = await tokens(c, "/vault");
    const r = await c("/vault", { method: "POST", body: new URLSearchParams({ _yx: wipe! }), headers: { yx: "1" } });
    expect(r.status).toBe(403);
    expect(wiped).toBe(0);
  });

  it("refuse a token made for another session", async () => {
    const mine = client();
    const theirs = client();
    await theirs("/vault", { method: "POST" });
    await mine("/vault", { method: "POST" });
    const [, note] = await tokens(theirs, "/vault");
    const r = await mine("/vault", { method: "POST", body: new URLSearchParams({ _yx: note! }), headers: { yx: "1" } });
    expect(r.status).toBe(403);
    expect(await r.text()).toContain("different session");
    const ok = await theirs("/vault", { method: "POST", body: new URLSearchParams({ _yx: note! }), headers: { yx: "1" } });
    expect(ok.status).toBe(200);
  });
});

describe("uploads", () => {
  it("reach actions as files from a multipart post", async () => {
    const c = client();
    const [token] = await tokens(c, "/upload");
    const body = new FormData();
    body.set("_yx", token!);
    body.set("title", "notes");
    body.set("doc", new File(["hello file"], "notes.txt", { type: "text/plain" }));
    const r = await c("/upload", { method: "POST", body, headers: { yx: "1" } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ title: "notes", name: "notes.txt", text: "hello file", none: null });
  });
});

describe("upload accessors", () => {
  const send = (parts: Array<[string, File | string]>) => {
    const body = new FormData();
    for (const [k, v] of parts) body.append(k, v);
    return fetch(server.url + "/avatar", { method: "POST", body });
  };
  const png = (bytes = 10) => new File([new Uint8Array(bytes)], "me.png", { type: "image/png" });

  it("give the route typed files, checking required, type and size", async () => {
    const ok = await send([["avatar", png()], ["extra", png()], ["extra", png()]]);
    expect(await ok.json()).toEqual({ name: "me.png", type: "image/png", extra: 2 });
    expect((await send([["avatar", new File([], "", { type: "application/octet-stream" })]])).status).toBe(400);
    expect((await send([["avatar", new File(["x"], "a.txt", { type: "text/plain" })]])).status).toBe(415);
    expect((await send([["avatar", png(500)]])).status).toBe(413);
  });
});

describe("DTOs with files", () => {
  const png = (bytes = 10, name = "me.png") => new File([new Uint8Array(bytes)], name, { type: "image/png" });
  const form = (parts: Array<[string, File | string]>) => {
    const data = new FormData();
    for (const [k, v] of parts) data.append(k, v);
    return data;
  };

  it("validate uploads next to fields through @body(Dto)", async () => {
    const ok = await fetch(server.url + "/profile", { method: "POST", body: form([["name", "ada"], ["avatar", png()], ["attachments", png(1, "a.png")]]) });
    expect(await ok.json()).toEqual({ name: "ada", avatar: "me.png", attachments: 1 });

    const bad = await fetch(server.url + "/profile", {
      method: "POST",
      body: form([["name", "ada"], ["avatar", new File(["x"], "a.txt", { type: "text/plain" })], ["attachments", png()], ["attachments", png()], ["attachments", png()]]),
    });
    expect(bad.status).toBe(400);
    const { issues } = (await bad.json()) as { issues: Array<{ path: string; message: string }> };
    expect(issues.map((i) => i.path)).toEqual(["avatar", "attachments"]);

    // An empty file input counts as no file.
    const missing = await fetch(server.url + "/profile", { method: "POST", body: form([["name", "ada"], ["avatar", new File([], "")]]) });
    expect(((await missing.json()) as { issues: Array<{ path: string }> }).issues[0]!.path).toBe("avatar");
  });

  it("validate uploads in actions through form.parse(Dto)", async () => {
    const c = client();
    const [token] = await tokens(c, "/profile");
    const r = await c("/profile", { method: "POST", body: form([["_yx", token!], ["name", "ada"], ["avatar", png()]]), headers: { yx: "1" } });
    expect(await r.json()).toEqual({ via: "action", avatar: "me.png" });
  });
});

describe("cross-site requests", () => {
  const send = (headers: Record<string, string>) =>
    fetch(server.url + "/api/things", { method: "POST", body: "{}", headers: { "content-type": "application/json", ...headers } });

  it("are refused by Sec-Fetch-Site, Origin or Referer", async () => {
    expect((await send({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await send({ "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await send({ origin: "https://evil.example" })).status).toBe(403);
    expect((await send({ origin: "null" })).status).toBe(403);
    expect((await send({ referer: "https://evil.example/page" })).status).toBe(403);
  });

  it("pass when same-origin, trusted, or not from a browser at all", async () => {
    expect((await send({ "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await send({ origin: server.url })).status).toBe(200);
    expect((await send({ origin: "https://admin.example.com", "sec-fetch-site": "cross-site" })).status).toBe(200);
    expect((await send({})).status).toBe(200);
  });
});

describe("responses", () => {
  it("lowercase header names, so a handler's Content-Type replaces the default, and append to Vary", async () => {
    const r = await fetch(server.url + "/headers");
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(r.headers.get("vary")).toBe("cookie");
  });

  it("reject redirects with line breaks before anything is written", () => {
    expect(() => res(null, { status: 303, headers: { location: "/a\r\nset-cookie: x=1" } })).toThrow(TypeError);
    expect(() => res("x", { status: 99 })).toThrow(TypeError);
  });

  it("render the error page for an error thrown at the top of a page", async () => {
    const r = await fetch(server.url + "/boom", { headers: { accept: "text/html" } });
    expect(r.status).toBe(418);
    expect(await r.text()).toContain('<p class="err">418 short and stout</p>');
  });

  it("render 404s with the layouts, DI included", async () => {
    const r = await fetch(server.url + "/nope", { headers: { accept: "text/html" } });
    expect(r.status).toBe(404);
    const html = await r.text();
    expect(html).toContain("<header>Yerd Co</header>");
    expect(html).toContain("404 Not Found");
  });
});

describe("the runtime script", () => {
  it("is compressed, revalidated with an ETag, and still the same script", async () => {
    const br = await fetch(server.url + "/_yerd/runtime.js", { headers: { "accept-encoding": "br" } });
    expect(br.headers.get("content-encoding")).toBe("br");
    const etag = br.headers.get("etag")!;
    expect(await br.text()).toContain("yerd.runtime");
    const plain = await fetch(server.url + "/_yerd/runtime.js", { headers: { "accept-encoding": "identity" } });
    expect(plain.headers.get("content-encoding")).toBeNull();
    const again = await fetch(server.url + "/_yerd/runtime.js", { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
  });
});

describe("odd request targets", () => {
  it("answer OPTIONS * and junk absolute targets instead of crashing", async () => {
    expect(await rawRequest("OPTIONS * HTTP/1.1\r\nhost: x\r\n\r\n")).toBe("HTTP/1.1 204 No Content");
    expect(await rawRequest("GET * HTTP/1.1\r\nhost: x\r\n\r\n")).toBe("HTTP/1.1 400 Bad Request");
  });
});

describe("lifecycle", () => {
  it("stops what it started when @onBoot fails, and can't be restarted after stop", async () => {
    let ticks = 0;
    @service({ lifetime: "singleton" })
    class Ticker {
      @every(5, { immediate: true }) tick() {
        ticks++;
      }
    }
    @service({ lifetime: "singleton" })
    class Broken {
      @onBoot boot() {
        throw new Error("no database");
      }
    }
    const app = yerd({ routes: [], services: [Ticker, Broken] });
    await expect(app.start()).rejects.toThrow("no database");
    const seen = ticks;
    await new Promise((r) => setTimeout(r, 30));
    expect(ticks).toBe(seen);

    const other = yerd({ routes: [], services: [] });
    await other.start();
    await other.stop();
    await expect(other.start()).rejects.toThrow("stopped");
  });

  it("waits for a start in progress before stopping", async () => {
    let ticks = 0;
    @service({ lifetime: "singleton" })
    class Slow {
      @onBoot async boot() {
        await new Promise((r) => setTimeout(r, 20));
      }
      @every(5, { immediate: true }) tick() {
        ticks++;
      }
    }
    const app = yerd({ routes: [], services: [Slow] });
    void app.start();
    await app.stop();
    const seen = ticks;
    await new Promise((r) => setTimeout(r, 30));
    expect(ticks).toBe(seen);
  });
});
