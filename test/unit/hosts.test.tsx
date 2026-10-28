// YerdOptions.hosts: requests for any other host are a 400 before anything runs.
import { describe, expect, it } from "vitest";
import { get, route, yerd } from "@toyz/yerd";

@route("/page")
class Page {
  @get show() {
    return "page";
  }
}

const app = (trustProxy = false) => yerd({ routes: [Page], services: [], handleSignals: false, trustProxy, hosts: ["shop.example", ".api.shop.example", "[::1]"] });

describe("hosts", () => {
  it.each([
    ["http://shop.example/page", 200],
    ["http://SHOP.example:8443/page", 200],
    ["http://api.shop.example/page", 200],
    ["http://v2.api.shop.example/page", 200],
    ["http://[::1]:3000/page", 200],
    ["http://www.shop.example/page", 400],
    ["http://evil.example/page", 400],
    ["http://evilapi.shop.example/page", 400],
    ["http://localhost/page", 400],
  ])("%s -> %d", async (url, status) => {
    const r = await app().request(url, { headers: { accept: "application/json" } });
    expect(r.status).toBe(status);
    if (status === 400) expect(await r.json()).toEqual({ error: "Unknown host", code: "bad_request" });
  });

  it("checks X-Forwarded-Host under trustProxy, and only then", async () => {
    const via = (forwardedHost: string, trustProxy: boolean) =>
      app(trustProxy).request("http://shop.example/page", { headers: { "x-forwarded-host": forwardedHost } });
    expect((await via("evil.example", true)).status).toBe(400);
    expect((await via("shop.example", true)).status).toBe(200);
    expect((await via("evil.example", false)).status).toBe(200);
  });

  it("refuses entries that aren't host names", () => {
    expect(() => yerd({ hosts: ["https://shop.example"] })).toThrow(`hosts: "https://shop.example" isn't a host name`);
    expect(() => yerd({ hosts: ["shop.example:443"] })).toThrow("isn't a host name");
  });
});
