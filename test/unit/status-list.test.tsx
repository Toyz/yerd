import { afterEach, describe, expect, it, vi } from "vitest";
import { Conflict, HttpStatus, ILogger, get, post, put, route, status, yerd, type LogRecord } from "@toyz/yerd";

afterEach(() => vi.unstubAllEnvs());

@route("/things")
class Things {
  @post @status(HttpStatus.Created) create() {
    return { id: 1 };
  }

  @put @status([HttpStatus.Ok, HttpStatus.Created, HttpStatus.Conflict]) upsert() {
    return { id: 1 };
  }

  @get @status([HttpStatus.Ok, HttpStatus.NotFound]) show() {
    return new Conflict("not on the list");
  }
}

function app() {
  const records: LogRecord[] = [];
  const instance = yerd({ routes: [Things], services: [], handleSignals: false })
    .logging({ filter: "warn" })
    .services((s) => s.value(ILogger, { write: (r) => records.push(r) }));
  return { instance, records };
}

describe("HttpStatus", () => {
  it("names the codes", () => {
    expect(HttpStatus.NoContent).toBe(204);
    expect(HttpStatus.ContentTooLarge).toBe(413);
    expect(HttpStatus.UnprocessableContent).toBe(422);
    expect(Object.isFrozen(HttpStatus)).toBe(true);
  });
});

describe("@status with a list", () => {
  it("uses the first as the default, like a single status", async () => {
    const { instance } = app();
    expect((await instance.request("/things", { method: "POST", headers: { origin: "http://localhost" } })).status).toBe(201);
    expect((await instance.request("/things", { method: "PUT", headers: { origin: "http://localhost" } })).status).toBe(200);
  });

  it("can be read back for tooling", () => {
    expect(status.get(Things, "upsert")).toBe(200);
    expect(status.listed(Things, "upsert")).toEqual([200, 201, 409]);
    expect(status.get(Things, "create")).toBe(201);
    expect(status.listed(Things, "create")).toBeUndefined();
  });

  it("warns in development when the handler answers a status it didn't list, once", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { instance, records } = app();
    expect((await instance.request("/things")).status).toBe(409);
    await instance.request("/things");
    const warnings = records.filter((r) => /doesn't list/.test(r.message));
    expect(warnings.map((r) => r.message)).toEqual(["Things.show answered 409, which its @status([200, 404]) doesn't list"]);
  });

  it("stays quiet in production, and for a single status", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { instance, records } = app();
    await instance.request("/things");
    expect(records.filter((r) => /doesn't list/.test(r.message))).toEqual([]);
  });

  it("refuses an empty list or a bad status when decorating", () => {
    expect(() => status([])).toThrow(/@status: give at least one status/);
    expect(() => status([200, 1000])).toThrow(/1000/);
  });
});
