// app.health() and drainDelay: 200 while up, 503 once close() begins (still serving for drainDelay), 503 when the check fails.
import { describe, expect, it } from "vitest";
import { Unauthorized, createGuard, get, route, yerd } from "@toyz/yerd";

@route("/page")
class Page {
  @get show() {
    return "page";
  }
}

const app = (options: { drainDelay?: number } = {}) => yerd({ routes: [Page], services: [], handleSignals: false, ...options });

describe("app.health()", () => {
  it("answers 200 while up, before any guard or middleware", async () => {
    const locked = createGuard("locked", () => new Unauthorized());
    await using server = await app().guard(locked).health().listen(0, "127.0.0.1");
    const r = await fetch(`${server.url}/health`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ status: "ok" });
    expect((await fetch(`${server.url}/page`)).status).toBe(401);
  });

  it("answers 503 when the check says false or throws", async () => {
    let healthy: boolean | Error = false;
    const check = () => {
      if (healthy instanceof Error) throw healthy;
      return healthy;
    };
    await using server = await app().health("/ready", { check: async () => check() }).listen(0, "127.0.0.1");
    expect([(await fetch(`${server.url}/ready`)).status, await (await fetch(`${server.url}/ready`)).json()]).toEqual([503, { status: "unhealthy" }]);
    healthy = new Error("db down");
    expect((await fetch(`${server.url}/ready`)).status).toBe(503);
    healthy = true;
    expect((await fetch(`${server.url}/ready`)).status).toBe(200);
  });

  it("answers 503 from the start of close(), still serving everything else for drainDelay", async () => {
    const server = await app({ drainDelay: 300 }).health().listen(0, "127.0.0.1");
    const started = Date.now();
    const closing = server.close();
    await new Promise((r) => setTimeout(r, 50));
    const health = await fetch(`${server.url}/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ status: "draining" });
    expect((await fetch(`${server.url}/page`)).status).toBe(200);
    await closing;
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(server.server.listening).toBe(false);
  });

  it("refuses a path that isn't one", () => {
    expect(() => app().health("health")).toThrow(`health: the path must start with "/"`);
  });
});
