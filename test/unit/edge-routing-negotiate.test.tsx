import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accepts, get, negotiate, parseAccept, post, res, route, type ErrorPageProps, type RunningServer } from "@toyz/yerd";
import { choose, expandType } from "../../src/respond/negotiate.js";
import { serve } from "./edge-routing-helpers.js";

const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

describe("parseAccept", () => {
  it.each([
    [undefined, []],
    ["", []],
    [",,, ,", []],
    ["application/json", [{ type: "application", subtype: "json", q: 1 }]],
    [" Application/JSON ; q=0.5 ", [{ type: "application", subtype: "json", q: 0.5 }]],
    ["text/*;q=2", [{ type: "text", subtype: "*", q: 1 }]],
    ["text/html;q=-1", [{ type: "text", subtype: "html", q: 0 }]],
    ["text/html;q=abc", [{ type: "text", subtype: "html", q: 0 }]],
    ["text/html;q=", [{ type: "text", subtype: "html", q: 0 }]],
    ["text/html;level=1;q=0.3", [{ type: "text", subtype: "html", q: 0.3 }]],
    // Parameter names are case-insensitive (RFC 9110 5.6.6).
    ["text/html;Q=0.2", [{ type: "text", subtype: "html", q: 0.2 }]],
    ["json", [{ type: "json", subtype: "*", q: 1 }]],
    ["*", [{ type: "*", subtype: "*", q: 1 }]],
    ["a/b, c/d;q=0", [{ type: "a", subtype: "b", q: 1 }, { type: "c", subtype: "d", q: 0 }]],
  ])("%j", (header, ranges) => {
    expect(parseAccept(header)).toEqual(ranges);
  });

  it("does not choke on a very long header", () => {
    const header = Array.from({ length: 5000 }, (_, i) => `x/y${i};q=0.${i % 10}`).join(",");
    expect(parseAccept(header)).toHaveLength(5000);
  });
});

describe("choose with a default", () => {
  const json = [["application/json"]];
  it.each([
    [undefined, "default"],
    ["", "default"],
    ["*/*", "default"],
    ["*", "default"],
    [BROWSER, "default"],
    ["text/html", "default"],
    ["garbage", "default"],
    ["application/json", 0],
    ["APPLICATION/JSON", 0],
    ["application/*", 0],
    ["application/json;q=2", 0],
    ["application/json;q=0.5, text/html", "default"],
    ["text/html;q=0.5, application/json", 0],
    ["application/json;q=0", "default"],
    ["application/json;q=-1", "default"],
    ["application/json;q=0, */*", "default"],
    ["application/json;Q=0", "default"],
  ])("Accept %j -> %j", (accept, expected) => {
    expect(choose(json, accept, true)).toBe(expected);
  });
});

describe("choose without a default", () => {
  const variants = [["application/json"], ["application/xml"]];
  it.each([
    [undefined, 0],
    ["*/*", 0],
    ["*/*;q=0", undefined],
    ["text/html", undefined],
    ["application/xml", 1],
    ["application/xml, application/json", 0],
    ["application/xml;q=0.9, application/json;q=0.8", 1],
    ["application/*;q=0.5, application/xml", 1],
    ["text/html, */*;q=0.1", 0],
    // A type refused by name isn't picked through */*.
    ["application/json;q=0, */*", 1],
    ["application/json;q=0, application/xml;q=0, */*", undefined],
    ["application/*;q=0, */*", undefined],
  ])("Accept %j -> %j", (accept, expected) => {
    expect(choose(variants, accept, false)).toBe(expected);
  });
});

describe("expandType", () => {
  it.each([
    ["json", "application/json"],
    ["html", "text/html"],
    ["ndjson", "application/x-ndjson"],
    ["text", "text/plain"],
    ["sse", "text/event-stream"],
    ["xml", "application/xml"],
    ["csv", "text/csv"],
    ["Application/Vnd.Api+JSON", "application/vnd.api+json"],
  ])("%s -> %s", (input, output) => {
    expect(expandType(input)).toBe(output);
  });
});

describe("decorator and negotiate() validation", () => {
  it.each(["jsno", "text/html; charset=utf-8", "text/", "/json", "a/b/c", "", "text html"])("@accepts(%j) is refused", (type) => {
    expect(() => (accepts as (...t: string[]) => unknown)(type)).toThrow(TypeError);
  });

  it("@accepts() with nothing is refused", () => {
    expect(() => (accepts as (...t: string[]) => unknown)()).toThrow(/at least one type/);
  });

  it.each(["application/vnd.api+json", "text/x-c++src", "image/svg+xml"])("@accepts(%j) is fine", (type) => {
    expect(() => (accepts as (...t: string[]) => unknown)(type)).not.toThrow();
  });

  it("negotiate() refuses no variants and non-types", () => {
    expect(() => negotiate({})).toThrow(/at least one variant/);
    expect(() => negotiate({ jsno: () => 1 } as never)).toThrow(/isn't a media type/);
  });
});

// ── over HTTP ──

@route("/todos")
class Todos {
  @get page() { return <ul><li>milk</li></ul>; }
  @get @accepts("json") data() { return { todos: ["milk"] }; }
  @get @accepts("csv", "text/tab-separated-values") table() { return res("milk", { headers: { "content-type": "text/csv; charset=utf-8" } }); }
  @post create() { return "created"; }
  @post @accepts("json") createJson() { return { created: true }; }
}

@route("/api-only")
class ApiOnly {
  @get @accepts("json") data() { return { ok: true }; }
  @get @accepts("xml") xml() { return res("<ok/>", { headers: { "content-type": "application/xml" } }); }
}

@route("/vendor")
class Vendor {
  @get @accepts("application/vnd.api+json") data() { return { data: [] }; }
}

@route("/neg")
class Neg {
  @get show() {
    return negotiate({
      html: () => <h1>neg</h1>,
      json: () => ({ neg: true }),
      csv: () => "a,b",
      xml: () => "<neg/>",
      text: () => "plain neg",
    });
  }
}

@route("/neg-json-first")
class NegJsonFirst {
  @get show() {
    return negotiate({ json: () => "a string", html: () => <p>h</p> });
  }
  @post nulls() {
    return negotiate({ json: () => null });
  }
}

const ErrorPage = ({ status, message }: ErrorPageProps) => <p>{status} {message}</p>;

let server: RunningServer;
beforeAll(async () => {
  server = await serve([Todos, ApiOnly, Vendor, Neg, NegJsonFirst], (app) => app.errorPage(ErrorPage));
});
afterAll(() => server.close());

const go = (path: string, accept: string | undefined, method = "GET") =>
  fetch(server.url + path, { method, headers: accept === undefined ? {} : { accept } });

describe("@accepts over HTTP", () => {
  it.each([
    [undefined, "text/html; charset=utf-8", "<ul><li>milk</li></ul>"],
    ["*/*", "text/html; charset=utf-8", "<ul><li>milk</li></ul>"],
    [BROWSER, "text/html; charset=utf-8", "<ul><li>milk</li></ul>"],
    ["application/json", "application/json; charset=utf-8", '{"todos":["milk"]}'],
    ["application/json;q=0.9, text/html", "text/html; charset=utf-8", "<ul><li>milk</li></ul>"],
    ["text/csv", "text/csv; charset=utf-8", "milk"],
    ["text/tab-separated-values", "text/csv; charset=utf-8", "milk"],
    ["text/csv;q=0.5, application/json", "application/json; charset=utf-8", '{"todos":["milk"]}'],
    ["image/png", "text/html; charset=utf-8", "<ul><li>milk</li></ul>"],
  ])("GET /todos Accept %j -> %s", async (accept, type, body) => {
    const r = await go("/todos", accept);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe(type);
    expect(r.headers.get("vary")).toBe("accept");
    expect(await r.text()).toBe(body);
  });

  it("negotiates per verb", async () => {
    expect(await (await go("/todos", "application/json", "POST")).json()).toEqual({ created: true });
    expect(await (await go("/todos", "*/*", "POST")).text()).toBe("created");
  });

  it.each([
    [undefined, 200, '{"ok":true}'],
    ["*/*", 200, '{"ok":true}'],
    ["application/xml", 200, "<ok/>"],
    ["application/json;q=0, */*", 200, "<ok/>"],
    ["text/html", 406, "<p>406 Not Acceptable</p>"],
    ["*/*;q=0", 406, "Not Acceptable"],
    ["image/*", 406, "Not Acceptable"],
  ])("GET /api-only Accept %j -> %i", async (accept, status, body) => {
    const r = await go("/api-only", accept);
    expect(r.status).toBe(status);
    expect(r.headers.get("vary")).toBe("accept");
    expect(await r.text()).toBe(body);
  });

  it("a 406 for a browser renders the error page", async () => {
    const r = await go("/api-only", "text/html");
    expect(r.status).toBe(406);
    // No layouts registered, so the page is the component alone.
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("HEAD negotiates like GET", async () => {
    const r = await fetch(server.url + "/api-only", { method: "HEAD", headers: { accept: "application/xml" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-length")).toBe("5");
  });

  it("vendor types match exactly and through type/*", async () => {
    expect((await go("/vendor", "application/vnd.api+json")).status).toBe(200);
    expect((await go("/vendor", "application/*")).status).toBe(200);
    expect((await go("/vendor", "application/json")).status).toBe(406);
  });
});

describe("negotiate() over HTTP", () => {
  it.each([
    [undefined, "text/html; charset=utf-8", "<h1>neg</h1>"],
    [BROWSER, "text/html; charset=utf-8", "<h1>neg</h1>"],
    ["application/json", "application/json; charset=utf-8", '{"neg":true}'],
    ["text/csv", "text/csv; charset=utf-8", "a,b"],
    ["application/xml", "application/xml", "<neg/>"],
    ["text/plain", "text/plain; charset=utf-8", "plain neg"],
    ["text/*", "text/html; charset=utf-8", "<h1>neg</h1>"],
    ["image/png", "text/html; charset=utf-8", "<h1>neg</h1>"],
  ])("Accept %j -> %s", async (accept, type, body) => {
    const r = await go("/neg", accept);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe(type);
    expect(r.headers.get("vary")).toBe("accept");
    expect(await r.text()).toBe(body);
  });

  it("the first key is the default, so JSON first means JSON for */*", async () => {
    const r = await go("/neg-json-first", "*/*");
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    // A string from the json variant is JSON, quoted.
    expect(await r.text()).toBe('"a string"');
  });

  it("a browser still gets the html variant when json is first", async () => {
    expect(await (await go("/neg-json-first", BROWSER)).text()).toBe("<p>h</p>");
  });

  it("null from the json variant is JSON null with a 200, not a 204", async () => {
    const r = await go("/neg-json-first", "application/json", "POST");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("null");
  });
});
