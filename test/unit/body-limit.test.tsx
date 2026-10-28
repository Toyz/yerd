// @bodyLimit: per class, group, handler or action, deepest wins; actions are held to their own limit once their token is read.
import { describe, expect, it } from "vitest";
import { ActionForm, action, bodyLimit, field, get, group, post, route, yerd } from "@toyz/yerd";
import { parseSize } from "../../src/util/size.js";

const KB = 1024;
const text = (bytes: number) => "x".repeat(bytes);

@route("/notes")
class Notes {
  @field("text") accessor text!: Promise<string | undefined>;

  @get page() {
    return (
      <main>
        <form action={this.small}><button>small</button></form>
        <form action={this.big}><button>big</button></form>
      </main>
    );
  }
  @post @bodyLimit("4kb") async create() {
    return { length: (await this.text)?.length };
  }
  @action small(_: {}, form: ActionForm) {
    return { small: form.string("text").length };
  }
  @action @bodyLimit(8 * KB) big(_: {}, form: ActionForm) {
    return { big: form.string("text").length };
  }
}

@route("/uploads")
@bodyLimit("16kb")
class Uploads {
  @field("text") accessor text!: Promise<string | undefined>;
  @post async create() {
    return { length: (await this.text)?.length };
  }
}

@group("/media")
@bodyLimit("16kb")
class Media {}

@route("/images", { group: Media })
class Images {
  @field("text") accessor text!: Promise<string | undefined>;
  @post async create() {
    return { length: (await this.text)?.length };
  }
}

@route("/tight", { group: Media })
@bodyLimit(2 * KB)
class Tight {
  @field("text") accessor text!: Promise<string | undefined>;
  @post async create() {
    return { length: (await this.text)?.length };
  }
}

const app = () => yerd({ routes: [Notes, Uploads, Images, Tight], services: [], handleSignals: false, bodyLimit: KB });

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
  body: new URLSearchParams(fields).toString(),
});

describe("@bodyLimit", () => {
  it("raises the limit for one handler, the app's still applying elsewhere", async () => {
    const server = app();
    expect((await server.request("/notes", form({ text: text(3 * KB) }))).status).toBe(200);
    expect((await server.request("/notes", form({ text: text(5 * KB) }))).status).toBe(413);
  });

  it("holds each action to its own limit, read under the route's largest", async () => {
    const client = app().client();
    const html = await client.page("/notes");
    const tokens = [...html.matchAll(/name="_yx" value="([^"]+)"/g)].map((m) => m[1]!);
    expect(tokens).toHaveLength(2);
    const [small, big] = tokens as [string, string];
    const post = (token: string, bytes: number) => client.request("/notes", form({ _yx: token, text: text(bytes) }));
    expect((await post(big, 6 * KB)).status).toBe(200);
    expect((await post(big, 9 * KB)).status).toBe(413);
    // The other action keeps the app's 1 KB, though the route reads up to 8 KB to find out which action it is.
    expect((await post(small, 512)).status).toBe(200);
    const refused = await post(small, 2 * KB);
    expect(refused.status).toBe(413);
    expect(refused.headers.get("yx-stale")).toBeNull();
  });

  it("applies on a class, and a group's reaches its routes unless a route sets its own", async () => {
    const server = app();
    expect((await server.request("/uploads", form({ text: text(12 * KB) }))).status).toBe(200);
    expect((await server.request("/media/images", form({ text: text(12 * KB) }))).status).toBe(200);
    expect((await server.request("/media/images", form({ text: text(20 * KB) }))).status).toBe(413);
    expect((await server.request("/media/tight", form({ text: text(3 * KB) }))).status).toBe(413);
  });

  it("refuses a declared Content-Length over the route's largest before reading it", async () => {
    const r = await app().request("/notes", { ...form({ text: "x" }), headers: { ...form({}).headers, "content-length": String(100 * KB) } });
    expect(r.status).toBe(413);
  });

  it("takes bytes or sizes like \"10mb\", and refuses anything else", () => {
    expect([parseSize(512), parseSize("512b"), parseSize("4kb"), parseSize("10MB"), parseSize("1.5gb")]).toEqual([512, 512, 4096, 10 * 1024 ** 2, 1.5 * 1024 ** 3]);
    expect(() => bodyLimit("lots")).toThrow(`@bodyLimit: Invalid size: "lots"`);
    expect(() => bodyLimit(-1)).toThrow("@bodyLimit: Invalid size: -1");
  });
});
