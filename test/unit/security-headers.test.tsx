// app.securityHeaders(): CSP, HSTS (HTTPS only), framing, referrer and opener policy on every response.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NotFound, currentContext, get, res, route, yerd, type SecurityHeadersOptions } from "@toyz/yerd";
import { compileSecurityHeaders } from "../../src/server/security-headers.js";

const DEFAULT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";

async function Slow() {
  await new Promise((r) => setTimeout(r, 5));
  return <p>later</p>;
}

@route("/")
class Home {
  @get page() {
    return <main><h1>home</h1><Slow /></main>;
  }
}

@route("/widget")
class Widget {
  @get page() {
    return res(<p>embedded</p>, { headers: { "content-security-policy": "frame-ancestors https://partner.example", "x-frame-options": "ALLOW-FROM" } });
  }
}

@route("/set")
class SetHeader {
  @get page() {
    currentContext().setHeader("referrer-policy", "no-referrer");
    return "set";
  }
}

@route("/gone")
class Gone {
  @get page() {
    throw new NotFound();
  }
}

const dir = mkdtempSync(join(tmpdir(), "yerd-security-"));
writeFileSync(join(dir, "robots.txt"), "User-agent: *\n");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function app(options?: SecurityHeadersOptions, trustProxy = false) {
  return yerd({ routes: [Home, Widget, SetHeader, Gone], services: [], handleSignals: false, trustProxy }).static("/", dir).securityHeaders(options);
}

describe("app.securityHeaders()", () => {
  it("sends the defaults on pages, errors, unmatched paths and static files", async () => {
    const server = app();
    for (const path of ["/", "/gone", "/nowhere", "/robots.txt"]) {
      const r = await server.request(path);
      expect(r.headers.get("content-security-policy"), path).toBe(DEFAULT_CSP);
      expect(r.headers.get("x-frame-options"), path).toBe("SAMEORIGIN");
      expect(r.headers.get("referrer-policy"), path).toBe("strict-origin-when-cross-origin");
      expect(r.headers.get("cross-origin-opener-policy"), path).toBe("same-origin");
      expect(r.headers.get("x-content-type-options"), path).toBe("nosniff");
      // Plain HTTP: no HSTS.
      expect(r.headers.get("strict-transport-security"), path).toBeNull();
    }
    expect(await (await server.request("/")).text()).toContain("<p>later</p>");
  });

  it("lets a handler's own headers win, for that response only", async () => {
    const server = app();
    const widget = await server.request("/widget");
    expect(widget.headers.get("content-security-policy")).toBe("frame-ancestors https://partner.example");
    expect(widget.headers.get("x-frame-options")).toBe("ALLOW-FROM");
    expect((await server.request("/set")).headers.get("referrer-policy")).toBe("no-referrer");
    expect((await server.request("/")).headers.get("content-security-policy")).toBe(DEFAULT_CSP);
  });

  it("does the same over a real socket, streamed pages included", async () => {
    const server = await app().listen(0, "127.0.0.1");
    try {
      const page = await fetch(server.url + "/");
      expect(page.headers.get("content-security-policy")).toBe(DEFAULT_CSP);
      expect(await page.text()).toContain("<p>later</p>");
      const widget = await fetch(server.url + "/widget");
      expect(widget.headers.get("content-security-policy")).toBe("frame-ancestors https://partner.example");
      expect(widget.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect((await fetch(server.url + "/robots.txt")).headers.get("x-frame-options")).toBe("SAMEORIGIN");
    } finally {
      await server.close();
    }
  });

  it("leaves requests it passes on (next()) to the host app's own headers", async () => {
    const app = yerd({ routes: [Home], services: [], handleSignals: false }).securityHeaders();
    await app.start();
    const host = createServer((req, res) => app.handle(req, res, () => res.end("host app")));
    await new Promise<void>((r) => host.listen(0, "127.0.0.1", r));
    try {
      const base = `http://127.0.0.1:${(host.address() as { port: number }).port}`;
      const passed = await fetch(`${base}/not-yerds`);
      expect(await passed.text()).toBe("host app");
      expect(passed.headers.get("content-security-policy")).toBeNull();
      expect(passed.headers.get("x-frame-options")).toBeNull();
      expect((await fetch(`${base}/`)).headers.get("content-security-policy")).toBe(DEFAULT_CSP);
    } finally {
      host.close();
      await app.stop();
    }
  });

  it("sends HSTS over HTTPS only, as told by X-Forwarded-Proto under trustProxy", async () => {
    const proxied = app({ hsts: { maxAge: 600, includeSubDomains: true, preload: true } }, true);
    const https = await proxied.request("/", { headers: { "x-forwarded-proto": "https" } });
    expect(https.headers.get("strict-transport-security")).toBe("max-age=600; includeSubDomains; preload");
    expect((await proxied.request("/")).headers.get("strict-transport-security")).toBeNull();
    // Without trustProxy, the header is anyone's to send.
    const direct = await app().request("/", { headers: { "x-forwarded-proto": "https" } });
    expect(direct.headers.get("strict-transport-security")).toBeNull();
    expect((await app().request("https://localhost/")).headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  it("turns each header off with false", async () => {
    const r = await app({ csp: false, hsts: false, frame: false, referrerPolicy: false, crossOriginOpenerPolicy: false }).request("https://localhost/");
    for (const name of ["content-security-policy", "strict-transport-security", "x-frame-options", "referrer-policy", "cross-origin-opener-policy"]) {
      expect(r.headers.get(name), name).toBeNull();
    }
  });
});

describe("compileSecurityHeaders", () => {
  const csp = (options: SecurityHeadersOptions) => Object.fromEntries(compileSecurityHeaders(options).always)["content-security-policy"];

  it("merges directives over the defaults: replace, add, drop, valueless", () => {
    expect(csp({ csp: { "img-src": ["'self'", "https://images.example"], "upgrade-insecure-requests": true, "object-src": false } })).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://images.example; " +
        "font-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests; frame-ancestors 'self'",
    );
  });

  it("ties frame-ancestors to `frame` unless the CSP names its own", () => {
    expect(csp({ frame: "deny" })).toContain("frame-ancestors 'none'");
    expect(Object.fromEntries(compileSecurityHeaders({ frame: "deny" }).always)["x-frame-options"]).toBe("DENY");
    expect(csp({ frame: "deny", csp: { "frame-ancestors": "https://partner.example" } })).toContain("frame-ancestors https://partner.example");
    expect(csp({ frame: false })).not.toContain("frame-ancestors");
  });

  it("sends report-only when asked", () => {
    const headers = Object.fromEntries(compileSecurityHeaders({ cspReportOnly: true }).always);
    expect(headers["content-security-policy-report-only"]).toBe(DEFAULT_CSP);
    expect(headers["content-security-policy"]).toBeUndefined();
  });

  it("refuses sources and names that would break the header", () => {
    expect(() => compileSecurityHeaders({ csp: { "script-src": "'self'; script-src *" } })).toThrow("isn't a single source");
    expect(() => compileSecurityHeaders({ csp: { "script-src": "a b" } })).toThrow("isn't a single source");
    expect(() => compileSecurityHeaders({ csp: { "img-src": ["https://x.example\r\nset-cookie: a=b"] } })).toThrow("isn't a single source");
    expect(() => compileSecurityHeaders({ csp: { "img-src": "" } })).toThrow("isn't a single source");
    expect(() => compileSecurityHeaders({ csp: { "Img Src": "'self'" } })).toThrow("isn't a directive name");
    expect(() => compileSecurityHeaders({ hsts: { maxAge: -1 } })).toThrow("whole number of seconds");
  });
});
