// The small HTTP rules shared across the server, sessions, auth and logging.
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { forwarded, isDevelopment, isStreamBody, mergeVary, requestIdFrom, requestIsHttps, splitTarget, wantsPage } from "../../src/server/http.js";

const req = (headers: Record<string, string | string[]>, encrypted = false) => ({ headers, socket: { encrypted } }) as unknown as IncomingMessage;

describe("mergeVary", () => {
  it.each([
    [undefined, "accept", "accept"],
    ["", "accept", "accept"],
    ["Accept", "accept", "Accept"],
    ["accept", "user-agent", "accept, user-agent"],
    ["accept, cookie", "Cookie, user-agent", "accept, cookie, user-agent"],
    ["accept", "", "accept"],
  ])("%j + %j = %j", (existing, added, expected) => {
    expect(mergeVary(existing, added)).toBe(expected);
  });
});

describe("forwarded", () => {
  it.each([
    [undefined, undefined],
    ["", undefined],
    ["  ", undefined],
    ["https", "https"],
    [" https , http", "https"],
    [["a, b", "c"], "a"],
  ])("%j -> %j", (value, expected) => {
    expect(forwarded(value as string | string[] | undefined)).toBe(expected);
  });
});

describe("requestIsHttps", () => {
  it.each([
    ["plain http", {}, false, false, false],
    ["TLS socket", {}, true, false, true],
    ["header ignored without trustProxy", { "x-forwarded-proto": "https" }, false, false, false],
    ["header believed with trustProxy", { "x-forwarded-proto": "https" }, false, true, true],
    ["upper case", { "x-forwarded-proto": "HTTPS" }, false, true, true],
    ["chained, client first", { "x-forwarded-proto": "https, http" }, false, true, true],
    ["a header can't downgrade TLS", { "x-forwarded-proto": "http" }, true, true, true],
  ])("%s", (_label, headers, encrypted, trust, expected) => {
    expect(requestIsHttps(req(headers, encrypted), trust)).toBe(expected);
  });
});

describe("requestIdFrom", () => {
  it("takes a well-formed id and refuses anything else", () => {
    expect(requestIdFrom(req({ "x-request-id": "abc-123.x:y@z" }))).toBe("abc-123.x:y@z");
    expect(requestIdFrom(req({}))).toBeUndefined();
    expect(requestIdFrom(req({ "x-request-id": "has space" }))).toBeUndefined();
    expect(requestIdFrom(req({ "x-request-id": "x".repeat(129) }))).toBeUndefined();
    expect(requestIdFrom(req({ "x-request-id": ["a", "b"] }))).toBeUndefined();
  });
});

describe("wantsPage", () => {
  it.each([
    [{}, false],
    [{ accept: "application/json" }, false],
    [{ accept: "text/html,*/*;q=0.8" }, true],
    [{ yx: "1" }, true],
    [{ "yx-dynamic": "1", accept: "*/*" }, true],
  ])("%j -> %s", (headers, expected) => {
    expect(wantsPage(headers)).toBe(expected);
  });
});

describe("splitTarget and isStreamBody", () => {
  it("splits at the first ?", () => {
    expect(splitTarget("/a/b")).toEqual({ path: "/a/b", search: "" });
    expect(splitTarget("/a?x=1?y")).toEqual({ path: "/a", search: "?x=1?y" });
  });

  it("only iterables are stream bodies", () => {
    expect(isStreamBody(null)).toBe(false);
    expect(isStreamBody("x")).toBe(false);
    expect(isStreamBody(new Uint8Array(1))).toBe(false);
    expect(isStreamBody((async function* () {})())).toBe(true);
  });
});

describe("isDevelopment", () => {
  const saved = process.env.NODE_ENV;
  afterEach(() => {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  });

  it("is development or unset", () => {
    delete process.env.NODE_ENV;
    expect(isDevelopment()).toBe(true);
    process.env.NODE_ENV = "development";
    expect(isDevelopment()).toBe(true);
    process.env.NODE_ENV = "production";
    expect(isDevelopment()).toBe(false);
    process.env.NODE_ENV = "test";
    expect(isDevelopment()).toBe(false);
  });
});
