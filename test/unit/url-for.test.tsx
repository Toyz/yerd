// urlFor(): a route's URL from its class, params checked when it's built.
import { describe, expect, it } from "vitest";
import { get, group, redirect, route, urlFor, yerd } from "@toyz/yerd";

@route("/")
class Home {
  @get page() {
    return <a href={urlFor(UserPage, { id: 42 })}>ada</a>;
  }
}

@route("/users/:id")
class UserPage {
  @get page() {
    return "user";
  }
}

@group("/admin")
class Admin {}

@group("/orgs/:org", { group: Admin })
class Orgs {}

@route("/members/:member", { group: Orgs })
class Member {
  @get page() {
    return redirect(urlFor(UserPage, { id: 7 }, { query: { from: "admin" } }));
  }
}

@route("/files/*path")
class Files {
  @get page() {
    return "file";
  }
}

@route("/search")
class Search {
  @get page() {
    return "search";
  }
}

class NotARoute {}

describe("urlFor", () => {
  it("fills params, percent-encoded", () => {
    expect(urlFor(UserPage, { id: 42 })).toBe("/users/42");
    expect(urlFor(UserPage, { id: "@ada lovelace" })).toBe("/users/%40ada%20lovelace");
    expect(urlFor(UserPage, { id: "a/b?c#d" })).toBe("/users/a%2Fb%3Fc%23d");
    expect(urlFor(Home)).toBe("/");
  });

  it("includes group prefixes and their params", () => {
    expect(urlFor(Member, { org: "acme", member: "ada" })).toBe("/admin/orgs/acme/members/ada");
  });

  it("takes a splat with slashes, each segment encoded, and an empty one", () => {
    expect(urlFor(Files, { path: "docs/read me.txt" })).toBe("/files/docs/read%20me.txt");
    expect(urlFor(Files, { path: "" })).toBe("/files");
    expect(urlFor(Files)).toBe("/files");
  });

  it("adds a query string and a hash", () => {
    expect(urlFor(Search, {}, { query: { q: "lamp & shade", tag: ["new", "sale"], page: undefined, sort: null, all: true } }))
      .toBe("/search?q=lamp+%26+shade&tag=new&tag=sale&all=true");
    expect(urlFor(Search, {}, { query: new URLSearchParams({ q: "x" }), hash: "results" })).toBe("/search?q=x#results");
    expect(urlFor(Search, {}, { query: {}, hash: "#top" })).toBe("/search#top");
  });

  it("throws on a missing, empty, unknown or non-finite param", () => {
    expect(() => urlFor(UserPage)).toThrow("/users/:id: :id is missing");
    expect(() => urlFor(UserPage, { id: "" })).toThrow(":id is empty");
    expect(() => urlFor(UserPage, { id: 1, tab: "posts" })).toThrow("there's no :tab param (it has :id)");
    expect(() => urlFor(Search, { q: "x" })).toThrow("(it has no params)");
    expect(() => urlFor(UserPage, { id: Number.NaN })).toThrow(":id is NaN");
  });

  it("refuses dot segments, which the browser would resolve to another path", () => {
    expect(() => urlFor(UserPage, { id: ".." })).toThrow(`:id can't be ".."`);
    expect(() => urlFor(UserPage, { id: "." })).toThrow(`:id can't be "."`);
    expect(() => urlFor(Files, { path: "a/../../admin" })).toThrow(`:path can't be ".."`);
    expect(urlFor(UserPage, { id: "..." })).toBe("/users/...");
  });

  it("throws for a class that isn't a route", () => {
    expect(() => urlFor(NotARoute)).toThrow("urlFor: NotARoute isn't a @route");
  });

  it("builds URLs the router answers", async () => {
    const app = yerd({ routes: [Home, UserPage, Member, Files, Search], services: [], handleSignals: false });
    expect(await (await app.request("/")).text()).toContain('<a href="/users/42">ada</a>');
    const moved = await app.request(urlFor(Member, { org: "acme", member: "ada" }), { redirect: "manual" });
    expect(moved.headers.get("location")).toBe("/users/7?from=admin");
    for (const url of [urlFor(UserPage, { id: "@ada lovelace" }), urlFor(Files, { path: "docs/read me.txt" }), urlFor(Search, {}, { query: { q: "x" } })]) {
      expect((await app.request(url)).status).toBe(200);
    }
  });
});
