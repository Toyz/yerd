import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BootError, YerdError, bare, catches, createGuard, currentContext, get, group, guards, layout, noLayout, post, res, route, setMeta, yerd,
  type Component, type LayoutProps, type RunningServer,
} from "@toyz/yerd";
import { serve } from "./edge-routing-helpers.js";

/** A layout that wraps its children in <div class=name>, and shows the page title. */
function mark(name: string): Component<LayoutProps> {
  const L = ({ children }: LayoutProps) => <div class={name}>{children}</div>;
  Object.defineProperty(L, "name", { value: name });
  return L;
}
const Root = ({ children, meta }: LayoutProps) => (
  <html><head><title>{meta.title ?? "none"}</title></head><body data-section={meta.section as string | undefined}>{children}</body></html>
);
const [Outer, Inner, C1, C2, M, R1, R2, Own] = ["outer", "inner", "c1", "c2", "m", "r1", "r2", "own"].map(mark) as Component<LayoutProps>[] as [
  Component<LayoutProps>, Component<LayoutProps>, Component<LayoutProps>, Component<LayoutProps>,
  Component<LayoutProps>, Component<LayoutProps>, Component<LayoutProps>, Component<LayoutProps>,
];

/** The class names of the <div> layouts in a page, outermost first. */
const chain = (html: string) => [...html.matchAll(/<div class="([\w-]+)">/g)].map((m) => m[1]);

// ── prefixes ──

@group("/a") class GA {}
@group("/b/", { group: GA }) class GB {}
@group("/c", { group: GB }) class GC {}
@group("/") class Slash {}
@group("/trail/") class Trail {}

@route("/d", { group: GC }) class Deep { @get s() { return currentContext().route.pattern; } }
@route("/", { group: GC }) class DeepIndex { @get s() { return currentContext().route.pattern; } }
@route("/x", { group: Slash }) class UnderSlash { @get s() { return currentContext().route.pattern; } }
@route("/", { group: Slash }) class SlashIndex { @get s() { return currentContext().route.pattern; } }
@route("/y", { group: Trail }) class UnderTrail { @get s() { return currentContext().route.pattern; } }
@route("/", { group: Trail }) class TrailIndex { @get s() { return currentContext().route.pattern; } }

describe("group prefixes", () => {
  let s: RunningServer;
  beforeAll(async () => {
    s = await serve([Deep, DeepIndex, UnderSlash, SlashIndex, UnderTrail, TrailIndex]);
  });
  afterAll(() => s.close());

  it.each([
    ["/a/b/c/d", "/a/b/c/d"],
    ["/a/b/c/d/", "/a/b/c/d"],
    ["/a/b/c", "/a/b/c"],
    ["/a/b/c/", "/a/b/c"],
    ["/x", "/x"],
    ["/", "/"],
    ["/trail/y", "/trail/y"],
    ["/trail", "/trail/"],
    ["/trail/", "/trail/"],
  ])("%s is served, ctx.route.pattern %s", async (path, pattern) => {
    const r = await fetch(s.url + path);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(pattern);
  });

  it.each(["/a/b/d", "/a//b/c/d", "/b/c/d", "/a/b/c/d/e"])("%s is a 404", async (path) => {
    expect((await fetch(s.url + path)).status).toBe(404);
  });

  it("refuses a group cycle", async () => {
    const pOptions: { group?: Function } = {};
    @group("/p", pOptions) class P {}
    @group("/q", { group: P }) class Q {}
    // Close the loop after the fact, the only way to build one.
    pOptions.group = Q;
    @route("/r", { group: Q }) class InCycle { @get s() { return 1; } }
    const error = (await yerd({ routes: [InCycle], services: [] }).boot().catch((e: unknown) => e)) as BootError;
    expect(error).toBeInstanceOf(BootError);
    expect(error.problems.join("\n")).toMatch(/InCycle: group cycle through/);
  });

  it("refuses a group option naming a class without @group", async () => {
    class NotAGroup {}
    @route("/r", { group: NotAGroup }) class Orphan { @get s() { return 1; } }
    const error = (await yerd({ routes: [Orphan], services: [] }).boot().catch((e: unknown) => e)) as BootError;
    expect(error.problems).toContain("Orphan: NotAGroup is used as a group but has no @group decorator");
  });

  it("refuses a prefix without a leading slash", () => {
    expect(() => group("admin")).toThrow(/must start with "\/"/);
  });
});

// ── layouts ──

@group("/l", { layout: Outer, meta: { section: "outer", title: "Outer" } }) class LOuter {}
@group("/in", { group: LOuter, layout: Inner, meta: { title: "Inner", extra: "kept" } }) class LInner {}
@group("/iso", { group: LOuter, layout: Own, inheritLayouts: false }) class LIso {}
@group("/deco", { group: LOuter }) @layout(Own, { inherit: false }) class LDeco {}
@group("/arr", { layout: [C1, C2] }) class LArr {}

@route("/full", { group: LInner, meta: { title: "Route" } })
@layout(C1, C2)
class Full {
  @get @layout(M) page() { return <p>full</p>; }
  @post @layout(M) withRes() { return res(<p>res</p>, { layout: [R1, R2] }); }
}

@route("/again", { group: LInner })
@layout(Root, Outer, C1)
class Again {
  @get page() { return <p>again</p>; }
}

@route("/stacked")
@layout(C1)
@layout(C2)
class Stacked {
  @get @layout(R1) @layout(R2) page() { return <p>stacked</p>; }
}

@route("/p", { group: LIso }) class InIso { @get @layout(M) page() { return <p>iso</p>; } }
@route("/p", { group: LDeco }) class InDeco { @get page() { return <p>deco</p>; } }
@route("/p", { group: LArr }) class InArr { @get page() { return <p>arr</p>; } }

@route("/variants", { group: LInner })
class Variants {
  @get @noLayout frag() { return <li>frag</li>; }
  @post bareResult() { return bare(<li>bare</li>); }
  @get(() => currentContext().headers["x-v"] === "iso") @layout(R1, { inherit: false }) iso() { return <p>iso</p>; }
  @get(() => currentContext().headers["x-v"] === "res-iso") resIso() { return res(<p>r</p>, { layout: R1, inherit: false }); }
  @get(() => currentContext().headers["x-v"] === "res-none") resNone() { return res(<p>none</p>, { inherit: false }); }
  @get(() => currentContext().headers["x-v"] === "res-dup") resDup() { return res(<p>dup</p>, { layout: [Outer, R1] }); }
}

@route("/meta", { group: LInner, meta: { title: "Route" } })
class Meta {
  @get page() {
    if (currentContext().query.get("set")) setMeta({ title: "Set", section: "changed" });
    return <p>{String(currentContext().meta.extra)}</p>;
  }
}

describe("layout chains", () => {
  let s: RunningServer;
  beforeAll(async () => {
    s = await serve([Full, Again, Stacked, InIso, InDeco, InArr, Variants, Meta], (app) => app.layout(Root));
  });
  afterAll(() => s.close());
  const html = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(s.url + path, init);
    expect(r.status).toBe(200);
    return r.text();
  };

  it("nests app, outer group, inner group, class, method layouts in that order", async () => {
    const page = await html("/l/in/full");
    expect(page.startsWith("<!doctype html><html>")).toBe(true);
    expect(chain(page)).toEqual(["outer", "inner", "c1", "c2", "m"]);
  });

  it("puts res() layouts innermost, in array order", async () => {
    expect(chain(await html("/l/in/full", { method: "POST" }))).toEqual(["outer", "inner", "c1", "c2", "m", "r1", "r2"]);
  });

  it("does not repeat a layout already in the chain", async () => {
    const page = await html("/l/in/again");
    expect(page.match(/<html>/g)).toHaveLength(1);
    expect(chain(page)).toEqual(["outer", "inner", "c1"]);
  });

  it("reads stacked @layouts top to bottom on classes and methods", async () => {
    expect(chain(await html("/stacked"))).toEqual(["c1", "c2", "r1", "r2"]);
  });

  it("inheritLayouts: false drops the app's and outer groups' layouts, keeps the route's", async () => {
    const page = await html("/l/iso/p");
    expect(page).not.toContain("<html>");
    expect(chain(page)).toEqual(["own", "m"]);
  });

  it("@layout(X, { inherit: false }) on a group class does the same", async () => {
    const page = await html("/l/deco/p");
    expect(page).not.toContain("<html>");
    expect(chain(page)).toEqual(["own"]);
  });

  it("a group's layout array nests in order", async () => {
    expect(chain(await html("/arr/p"))).toEqual(["c1", "c2"]);
  });

  it.each([
    [{}, "<li>frag</li>"],
  ])("@noLayout renders just the fragment", async (headers, body) => {
    expect(await html("/l/in/variants", { headers })).toBe(body);
  });

  it("bare() renders just the fragment", async () => {
    expect(await html("/l/in/variants", { method: "POST" })).toBe("<li>bare</li>");
  });

  it.each([
    ["iso", ["r1"], false],
    ["res-iso", ["r1"], false],
    ["res-none", [], false],
    ["res-dup", ["outer", "inner", "r1"], true],
  ])("variant %s -> layouts %j", async (v, layouts, document) => {
    const page = await html("/l/in/variants", { headers: { "x-v": v } });
    expect(chain(page)).toEqual(layouts);
    expect(page.includes("<html>")).toBe(document);
  });

  it("merges meta app -> outer -> inner -> route; the deeper value wins per key", async () => {
    const page = await html("/l/in/meta");
    expect(page).toContain("<title>Route</title>");
    expect(page).toContain('data-section="outer"');
    expect(page).toContain("<p>kept</p>");
  });

  it("setMeta() changes this request only", async () => {
    const set = await html("/l/in/meta?set=1");
    expect(set).toContain("<title>Set</title>");
    expect(set).toContain('data-section="changed"');
    const after = await html("/l/in/meta");
    expect(after).toContain("<title>Route</title>");
    expect(after).toContain('data-section="outer"');
  });

  it.each([
    [[], /at least one layout/],
    [["not a component"], /takes layout components/],
    [[{ inherit: true }], /at least one layout/],
  ])("@layout(%j) is refused", (args, message) => {
    expect(() => (layout as (...a: unknown[]) => unknown)(...args)).toThrow(message);
  });
});

// ── guards ──

let trail: string[] = [];
const step = (label: string, result: unknown = true) => createGuard(label, () => {
  trail.push(label);
  return result;
});

@group("/g", { guards: [step("group-outer")] }) class GOuter {}
@group("/h", { group: GOuter, guards: [step("group-inner")] }) @guards(step("group-class")) class GInner {}

@route("/order", { group: GInner, guards: [step("route-option")] })
@step("class-1")
@guards(step("class-2"), step("class-3"))
class Ordered {
  @get @step("method-1") @step("method-2") page() {
    trail.push("handler");
    return "ok";
  }
  @post @step("method-stop", false) @step("never") stop() {
    trail.push("handler");
    return "ok";
  }
}

describe("guard order", () => {
  let s: RunningServer;
  beforeAll(async () => {
    s = await serve([Ordered], (app) => app.guard(step("app")));
  });
  afterAll(() => s.close());

  it("app, outer group, inner group (options then class), route option, class, method, then handler", async () => {
    trail = [];
    expect(await (await fetch(s.url + "/g/h/order")).text()).toBe("ok");
    expect(trail).toEqual([
      "app", "group-outer", "group-inner", "group-class", "route-option", "class-1", "class-2", "class-3", "method-1", "method-2", "handler",
    ]);
  });

  it("stops at the first guard that doesn't continue", async () => {
    trail = [];
    const r = await fetch(s.url + "/g/h/order", { method: "POST" });
    expect(r.status).toBe(403);
    expect(trail.at(-1)).toBe("method-stop");
    expect(trail).not.toContain("never");
    expect(trail).not.toContain("handler");
  });

  it("app.guard() after the app started is refused", () => {
    // The server above is running, so this app has booted.
    const app = yerd({ routes: [], services: [] });
    return app.boot().then(() => expect(() => app.guard(step("late"))).toThrow(/before the app starts/));
  });
});

class Teapot extends Error {}

const results: Record<string, () => unknown> = {
  true: () => true,
  undefined: () => undefined,
  false: () => false,
  redirect: () => "/login?next=%2Fx",
  emptyString: () => "",
  crlf: () => "/ok\r\nSet-Cookie: pwned=1",
  httpError: () => new YerdError(401, "Who are you"),
  thrownYerdError: () => { throw new YerdError(429, "Slow down", { details: { retryIn: 5 } }); },
  error: () => new Error("internal guard detail"),
  thrown: () => { throw new Error("thrown guard detail"); },
  custom: () => new Teapot("short"),
  number: () => 402,
  zero: () => 0,
  object: () => ({ denied: true }),
  null: () => null,
  jsx: () => <p>blocked</p>,
  response: () => res("later", { status: 503, headers: { "retry-after": "10" } }),
  asyncFalse: async () => false,
  asyncTrue: async () => true,
  asyncThrow: async () => { throw new YerdError(400, "Bad guard input"); },
};
const pick = createGuard("pick", (ctx) => results[ctx.query.get("r")!]!());

@route("/guarded")
@pick
class Guarded {
  @get page() { return "passed"; }
  @catches(Teapot) teapot() { return res("caught teapot", { status: 418 }); }
}

describe("guard results", () => {
  let s: RunningServer;
  beforeAll(async () => {
    s = await serve([Guarded], (app) => app.layout(Root));
  });
  afterAll(() => s.close());

  it.each([
    ["true", 200, "passed", {}],
    ["undefined", 200, "passed", {}],
    ["asyncTrue", 200, "passed", {}],
    ["false", 403, '{"error":"Forbidden","code":"forbidden"}', {}],
    ["asyncFalse", 403, '{"error":"Forbidden","code":"forbidden"}', {}],
    ["redirect", 303, "", { location: "/login?next=%2Fx" }],
    ["httpError", 401, "Who are you", {}],
    ["thrownYerdError", 429, '{"error":"Slow down","retryIn":5}', { "content-type": "application/json; charset=utf-8" }],
    ["asyncThrow", 400, "Bad guard input", {}],
    ["error", 500, "Internal Server Error", {}],
    ["thrown", 500, "Internal Server Error", {}],
    ["custom", 418, "caught teapot", {}],
    ["number", 402, "", {}],
    ["object", 200, '{"denied":true}', {}],
    ["null", 204, "", {}],
    ["response", 503, "later", { "retry-after": "10" }],
  ])("a guard returning %s -> %i", async (key, status, body, headers) => {
    const r = await fetch(`${s.url}/guarded?r=${key}`, { redirect: "manual" });
    expect(r.status).toBe(status);
    expect(await r.text()).toBe(body);
    for (const [name, value] of Object.entries(headers)) expect(r.headers.get(name)).toBe(value);
  });

  it("a guard returning JSX renders it in the route's layouts", async () => {
    const r = await fetch(`${s.url}/guarded?r=jsx`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("<!doctype html><html><head><title>none</title></head><body><p>blocked</p></body></html>");
  });

  it("a redirect string with a line break is a 500, never a second header", async () => {
    const r = await fetch(`${s.url}/guarded?r=crlf`, { redirect: "manual" });
    expect(r.status).toBe(500);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("location")).toBeNull();
  });

  it("a guard returning 0 is a 500 (not a status)", async () => {
    expect((await fetch(`${s.url}/guarded?r=zero`)).status).toBe(500);
  });

  it("an empty string redirects to an empty Location (strings always redirect)", async () => {
    const r = await fetch(`${s.url}/guarded?r=emptyString`, { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("");
  });
});

describe("guards as variant tests vs gates", () => {
  const vip = createGuard("vip", (ctx) => (ctx.headers["x-vip"] === "1" ? true : "/join"));

  @route("/club")
  class Club {
    @get(vip) lounge() { return "lounge"; }
    @get floor() { return "floor"; }
  }

  @route("/door")
  class Door {
    @get @vip inside() { return "inside"; }
  }

  let s: RunningServer;
  beforeAll(async () => {
    s = await serve([Club, Door]);
  });
  afterAll(() => s.close());

  it.each([
    ["/club", {}, 200, "floor"],
    ["/club", { "x-vip": "1" }, 200, "lounge"],
    ["/door", {}, 303, ""],
    ["/door", { "x-vip": "1" }, 200, "inside"],
  ])("%s %j -> %i %s", async (path, headers, status, body) => {
    const r = await fetch(s.url + path, { headers, redirect: "manual" });
    expect(r.status).toBe(status);
    expect(await r.text()).toBe(body);
  });
});
