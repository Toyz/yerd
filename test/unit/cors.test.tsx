// @cors and @csrf(false) on routes and groups: preflights, headers for allowed origins, the cross-site check.
import { describe, expect, it } from "vitest";
import { cors, csrf, get, group, post, res, route, yerd } from "@toyz/yerd";

@cors({ origins: ["https://app.example"], headers: ["content-type", "authorization"], expose: ["x-total"] })
@group("/api", { session: false })
class Api {}

@route("/quotes", { group: Api })
class Quotes {
  @get list() {
    return res({ quotes: [] }, { headers: { vary: "accept", "x-total": "0" } });
  }
  @post create() {
    return 201;
  }
}

@cors(false)
@route("/internal", { group: Api })
class Internal {
  @post poke() {
    return 204;
  }
}

@cors({ origins: "*" })
@route("/public", { session: false })
class Public {
  @get read() {
    return { open: true };
  }
}

@cors({ origins: (origin) => origin.endsWith(".partner.example"), credentials: true })
@route("/me")
class Me {
  @get read() {
    return { me: "ada" };
  }
}

@csrf(false)
@route("/payments/return")
class PaymentReturn {
  @post done() {
    return 204;
  }
}

@route("/plain")
class Plain {
  @post write() {
    return 204;
  }
}

const app = () => yerd({ routes: [Quotes, Internal, Public, Me, PaymentReturn, Plain], services: [], handleSignals: false });

const preflightFrom = (origin: string, method = "POST", headers = "content-type") => ({
  method: "OPTIONS",
  headers: { origin, "access-control-request-method": method, "access-control-request-headers": headers },
});

describe("cors", () => {
  it("answers a preflight from an allowed origin", async () => {
    const r = await app().request("/api/quotes", preflightFrom("https://app.example"));
    expect(r.status).toBe(204);
    expect(Object.fromEntries(r.headers)).toMatchObject({
      "access-control-allow-origin": "https://app.example",
      "access-control-allow-methods": "GET, POST, HEAD",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-expose-headers": "x-total",
      "access-control-max-age": "600",
      vary: "origin",
    });
  });

  it("answers a preflight from another origin without the allow headers", async () => {
    const r = await app().request("/api/quotes", preflightFrom("https://evil.example"));
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(r.headers.get("vary")).toBe("origin");
  });

  it("adds its headers to the real request, merging Vary with the handler's", async () => {
    const r = await app().request("/api/quotes", { headers: { origin: "https://app.example" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(r.headers.get("access-control-expose-headers")).toBe("x-total");
    expect(r.headers.get("vary")).toBe("origin, accept");
    // Another origin: no allow header, but still Vary, so a cache keeps them apart.
    const other = await app().request("/api/quotes", { headers: { origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    expect(other.headers.get("vary")).toBe("origin, accept");
  });

  it("lets an allowed origin past the cross-site check, and only it", async () => {
    const from = (origin: string) => app().request("/api/quotes", { method: "POST", headers: { origin, "sec-fetch-site": "cross-site" } });
    expect((await from("https://app.example")).status).toBe(201);
    expect((await from("https://evil.example")).status).toBe(403);
  });

  it("is turned off by @cors(false) under a group that has it", async () => {
    const r = await app().request("/api/internal", { method: "POST", headers: { origin: "https://app.example", "sec-fetch-site": "cross-site" } });
    expect(r.status).toBe(403);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect((await app().request("/api/internal", preflightFrom("https://app.example"))).status).toBe(405);
  });

  it("origins: \"*\" answers anyone with *, and no Vary", async () => {
    const r = await app().request("/public", { headers: { origin: "https://anyone.example" } });
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("vary")).toBeNull();
    const pre = await app().request("/public", preflightFrom("https://anyone.example", "GET", "x-custom"));
    expect(pre.headers.get("access-control-allow-headers")).toBe("x-custom");
    expect(pre.headers.get("vary")).toBe("access-control-request-headers");
  });

  it("takes a function, echoes the origin with credentials, and never allows the opaque origin", async () => {
    const r = await app().request("/me", { headers: { origin: "https://shop.partner.example" } });
    expect(r.headers.get("access-control-allow-origin")).toBe("https://shop.partner.example");
    expect(r.headers.get("access-control-allow-credentials")).toBe("true");
    expect((await app().request("/me", { headers: { origin: "https://partner.example.evil" } })).headers.get("access-control-allow-origin")).toBeNull();
    expect((await app().request("/me", { headers: { origin: "null" } })).headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses bad options where the class is decorated", () => {
    expect(() => cors({ origins: "*", credentials: true })).toThrow(`@cors: origins "*" can't be used with credentials; list the origins`);
    expect(() => cors({ origins: ["https://app.example/path"] })).toThrow(`@cors: "https://app.example/path" isn't an origin`);
    expect(() => cors({ origins: ["app.example"] })).toThrow(`@cors: "app.example" isn't an origin`);
  });
});

describe("@csrf(false)", () => {
  it("skips the cross-site check for that route only", async () => {
    const crossSite = { method: "POST", headers: { origin: "https://pay.example", "sec-fetch-site": "cross-site" } };
    expect((await app().request("/payments/return", crossSite)).status).toBe(204);
    expect((await app().request("/plain", crossSite)).status).toBe(403);
  });
});
