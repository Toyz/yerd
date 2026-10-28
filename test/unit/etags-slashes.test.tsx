// app.etags() (304s for bodies in one piece) and the trailingSlash option (308 to one spelling).
import { describe, expect, it } from "vitest";
import { currentContext, get, res, route, yerd } from "@toyz/yerd";
import { raw } from "./edge-routing-helpers.js";

let version = 1;

@route("/data")
class Data {
  @get read() {
    return { version };
  }
}

@route("/private")
class Private {
  @get read() {
    return res({ secret: 1 }, { headers: { "cache-control": "no-store" } });
  }
}

@route("/cookie")
class Cookie {
  @get read() {
    currentContext().setCookie("seen", "1");
    return { seen: true };
  }
}

@route("/page")
class Page {
  @get show() {
    return <p>page</p>;
  }
}

@route("/feed.xml")
class Feed {
  @get read() {
    return res("<feed/>", { headers: { "content-type": "application/xml" } });
  }
}

@route("/files/*rest")
class Files {
  @get read() {
    return "file";
  }
}

describe("app.etags()", () => {
  const app = () => yerd({ routes: [Data, Private, Cookie, Page], services: [], handleSignals: false }).etags();

  it("tags a body in one piece, and answers a matching If-None-Match with 304", async () => {
    const server = app();
    version = 1;
    const first = await server.request("/data");
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"[\w-]+"$/);
    const again = await server.request("/data", { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(etag);
    version = 2;
    const changed = await server.request("/data", { headers: { "if-none-match": etag } });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ version: 2 });
  });

  it("leaves no-store, responses setting cookies, and streamed pages alone", async () => {
    const server = app();
    expect((await server.request("/private")).headers.get("etag")).toBeNull();
    expect((await server.request("/cookie")).headers.get("etag")).toBeNull();
    expect((await server.request("/page")).headers.get("etag")).toBeNull();
  });

  it("is off unless asked for", async () => {
    expect((await yerd({ routes: [Data], services: [], handleSignals: false }).request("/data")).headers.get("etag")).toBeNull();
  });
});

describe("trailingSlash", () => {
  const app = (trailingSlash: "strip" | "add") => yerd({ routes: [Data, Feed, Files], services: [], handleSignals: false, trailingSlash });
  const go = async (trailing: "strip" | "add", path: string, method = "GET") => {
    const r = await app(trailing).request(path, { method, redirect: "manual" });
    return [r.status, r.headers.get("location")];
  };

  it.each<["strip" | "add", string, number, string | null]>([
    ["strip", "/data/", 308, "/data"],
    ["strip", "/data/?x=1", 308, "/data?x=1"],
    ["strip", "/data", 200, null],
    ["add", "/data", 308, "/data/"],
    ["add", "/data?x=1", 308, "/data/?x=1"],
    ["add", "/data/", 200, null],
    ["add", "/feed.xml", 200, null],
    ["strip", "/nowhere/", 404, null],
  ])("%s: %s -> %d %s", async (trailing, path, status, location) => {
    expect(await go(trailing, path)).toEqual([status, location]);
  });

  it("leaves other methods, and anything that would point off-site, alone", async () => {
    expect((await go("strip", "/data/", "POST"))[0]).not.toBe(308);
    // A splat matches "/files//evil.com/"; and a raw "//evil.com/" target, stripped, would be a link to another host.
    await using server = await app("strip").listen(0, "127.0.0.1");
    const offSite = await raw(server.url, "GET //evil.com/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect(offSite.headers.location).toBeUndefined();
    const nested = await raw(server.url, "GET /files//evil.com/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect([nested.status, nested.headers.location]).toEqual([308, "/files//evil.com"]);
  });
});
