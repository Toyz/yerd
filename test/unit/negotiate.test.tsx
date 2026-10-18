import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BootError, accepts, get, negotiate, route, yerd, type RunningServer } from "@toyz/yerd";
import { choose } from "../../src/respond/negotiate.js";

const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

@route("/things")
class Things {
  @get page() {
    return <ul><li>thing</li></ul>;
  }

  @get @accepts("json") data() {
    return { things: ["thing"] };
  }

  @get @accepts("ndjson", "text/csv") rows() {
    return "row\n";
  }
}

@route("/only-json")
class OnlyJson {
  @get @accepts("json") data() {
    return { ok: true };
  }
}

@route("/both")
class Both {
  @get show() {
    return negotiate({
      html: () => <p>hi</p>,
      json: () => ({ hi: true }),
      csv: () => "hi\n",
    });
  }
}

let server: RunningServer;
beforeAll(async () => {
  server = await yerd({ routes: [Things, OnlyJson, Both], services: [], handleSignals: false }).listen(0, "127.0.0.1");
});
afterAll(() => server.close());

const at = (path: string, accept?: string) => fetch(server.url + path, accept ? { headers: { accept } } : {});

describe("@accepts", () => {
  it("gives browsers the default HTML handler", async () => {
    const r = await at("/things", BROWSER);
    expect(await r.text()).toBe("<ul><li>thing</li></ul>");
    expect(r.headers.get("vary")).toBe("accept");
  });

  it("gives API clients the JSON handler", async () => {
    const r = await at("/things", "application/json");
    expect(await r.json()).toEqual({ things: ["thing"] });
    expect(r.headers.get("vary")).toBe("accept");
  });

  it("matches type ranges and respects q-values", async () => {
    expect(await (await at("/things", "application/*")).json()).toEqual({ things: ["thing"] });
    expect(await (await at("/things", "text/html, application/json;q=0.5")).text()).toContain("<ul>");
    expect(await (await at("/things", "text/html;q=0.4, application/json")).json()).toEqual({ things: ["thing"] });
    expect(await (await at("/things", "text/csv")).text()).toBe("row\n");
  });

  it("uses the default for */* and missing Accept", async () => {
    expect(await (await at("/things", "*/*")).text()).toContain("<ul>");
    expect(await (await at("/things")).text()).toContain("<ul>");
  });

  it("answers 406 when nothing fits and there's no default", async () => {
    expect((await at("/only-json", "text/html")).status).toBe(406);
    expect(await (await at("/only-json", "*/*")).json()).toEqual({ ok: true });
  });
});

describe("negotiate()", () => {
  it("runs only the chosen variant, first key as default", async () => {
    expect(await (await at("/both", BROWSER)).text()).toBe("<p>hi</p>");
    const json = await at("/both", "application/json");
    expect(json.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await json.json()).toEqual({ hi: true });
    const csv = await at("/both", "text/csv");
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(await csv.text()).toBe("hi\n");
    expect(csv.headers.get("vary")).toBe("accept");
  });
});

describe("choose()", () => {
  it("never lets a bare wildcard beat the default", () => {
    expect(choose([["application/json"]], BROWSER, true)).toBe("default");
    expect(choose([["application/json"]], "application/json", true)).toBe(0);
    expect(choose([["application/json"]], "application/json;q=0", true)).toBe("default");
    expect(choose([["application/json"]], "text/html", false)).toBeUndefined();
  });
});

describe("@accepts boot checks", () => {
  it("refuses two defaults and overlapping variants", async () => {
    @route("/dup")
    class A {
      @get a() {
        return 1;
      }
      @get @accepts("json") j() {
        return 1;
      }
    }
    @route("/dup")
    class B {
      @get b() {
        return 1;
      }
      @get @accepts("application/json") j2() {
        return 1;
      }
    }
    const error = (await yerd({ routes: [A, B], services: [] }).boot().catch((e: unknown) => e)) as BootError;
    expect(error.problems).toEqual([
      "Duplicate route: GET /dup (B.b and A.a; give one of them @accepts)",
      "B.j2 and A.j both @accepts the same type for GET /dup",
    ]);
  });
});
