import { describe, expect, it } from "vitest";
import { Router, paramNames } from "../../src/router/trie.js";

function router(patterns: string[]) {
  const r = new Router<string>();
  for (const p of patterns) r.add(p, "GET", p);
  return r;
}

describe("Router", () => {
  it("matches static, param and root routes", () => {
    const r = router(["/", "/about", "/users/:id"]);
    expect(r.match("/")?.pattern).toBe("/");
    expect(r.match("/about")?.pattern).toBe("/about");
    expect(r.match("/users/7")).toMatchObject({ pattern: "/users/:id", params: { id: "7" } });
    expect(r.match("/nope")).toBeNull();
  });

  it("prefers static segments over params regardless of registration order", () => {
    const r = router(["/users/:id", "/users/new"]);
    expect(r.match("/users/new")?.pattern).toBe("/users/new");
    expect(r.match("/users/42")?.pattern).toBe("/users/:id");
  });

  it("backtracks when a static branch dead-ends", () => {
    const r = router(["/a/b/c", "/a/:x/d"]);
    expect(r.match("/a/b/d")).toMatchObject({ pattern: "/a/:x/d", params: { x: "b" } });
  });

  it("matches splats, including zero segments", () => {
    const r = router(["/files/*path"]);
    expect(r.match("/files/a/b.txt")?.params).toEqual({ path: "a/b.txt" });
    expect(r.match("/files")?.params).toEqual({ path: "" });
  });

  it("decodes params and tolerates malformed escapes", () => {
    const r = router(["/u/:name"]);
    expect(r.match("/u/Ada%20Lovelace")?.params.name).toBe("Ada Lovelace");
    expect(r.match("/u/100%")?.params.name).toBe("100%");
  });

  it("ignores one trailing slash", () => {
    expect(router(["/about"]).match("/about/")?.pattern).toBe("/about");
  });

  it("does not match an empty segment as a param", () => {
    expect(router(["/users/:id"]).match("/users/")).toBeNull();
  });

  it("rejects duplicate routes and conflicting param names", () => {
    expect(() => router(["/a/:id", "/a/:id"])).toThrow(/Duplicate route/);
    expect(() => router(["/a/:id", "/a/:slug/x"])).toThrow(/already named it :id/);
    expect(() => router(["/a/*rest/b"])).toThrow(/last segment/);
  });

  it("lists param names", () => {
    expect(paramNames("/org/:org/repos/:repo/*rest")).toEqual(["org", "repo", "rest"]);
  });
});
