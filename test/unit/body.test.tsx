import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  args, between, body, field, get, is, length, lower, matches, param, patch, post, put, query, route, toBool, toInt, trim, yerd,
  type RunningServer,
} from "@toyz/yerd";

class Address {
  @is.string({ transform: trim, validate: length(1) }) city!: string;
  @is.string({ optional: true }) zip?: string;
}

class Signup {
  @is.string({ transform: [trim, lower], validate: matches(/@/, "that is not an email") }) email!: string;
  @is.int({ validate: between(13, 120) }) age!: number;
  @is.oneOf(["free", "pro"]) plan: "free" | "pro" = "free";
  @is.string({ optional: true }) referrer?: string;
  @is.object(Address, { optional: true }) address?: Address;
  @is.array(is.string({ transform: trim }), { optional: true, max: 3 }) tags?: string[];

  get isAdult() {
    return this.age >= 18;
  }
}

@route("/signup/:id")
class SignupPage {
  @body(Signup) accessor signup!: Promise<Signup>;
  @field("email", { transform: [trim, lower], validate: matches(/@/, "that is not an email"), required: true })
  accessor email!: Promise<string>;

  @get form() {
    return "signup form";
  }

  @post async create() {
    const s = await this.signup;
    return { instance: s instanceof Signup, adult: s.isAdult, ...s };
  }

  @put async fromForm() {
    return { email: await this.email };
  }

  @patch
  @args(param("id", { transform: toInt }), query("dry", { transform: toBool }), body(Signup))
  update(id: number, dry: boolean | undefined, s: Signup) {
    return { id, dry: dry ?? false, email: s.email };
  }
}

@route("/raw")
class Raw {
  @body() accessor raw!: Promise<unknown>;
  @post async echo() {
    const value = await this.raw;
    return { type: value instanceof Uint8Array ? "bytes" : typeof value, value: value instanceof Uint8Array ? value.length : value };
  }
}

let server: RunningServer;
beforeAll(async () => {
  server = await yerd({ routes: [SignupPage, Raw], bodyLimit: 1024 }).listen(0, "127.0.0.1");
});
afterAll(() => server.close());

const json = (path: string, method: string, data: unknown) =>
  fetch(server.url + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

describe("DTO bodies", () => {
  it("validates into a real instance, applying transforms and defaults", async () => {
    const r = await json("/signup/1", "POST", { email: "  ADA@Example.com ", age: 30, address: { city: " Paris " }, tags: [" a ", "b"] });
    expect(await r.json()).toEqual({
      instance: true,
      adult: true,
      email: "ada@example.com",
      age: 30,
      plan: "free",
      address: { city: "Paris" },
      tags: ["a", "b"],
    });
  });

  it("drops keys the DTO doesn't declare", async () => {
    const r = await json("/signup/1", "POST", { email: "a@b.c", age: 20, isAdmin: true });
    expect(await r.json()).not.toHaveProperty("isAdmin");
  });

  it("reports every issue with its path as JSON", async () => {
    const r = await json("/signup/1", "POST", { email: "nope", age: 7, plan: "gold", address: { city: "" }, tags: ["a", 2] });
    expect(r.status).toBe(400);
    expect(r.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await r.json()).toEqual({
      error: "Validation failed",
      issues: [
        { path: "email", message: "that is not an email" },
        { path: "age", message: "Must be from 13 to 120 (got 7)" },
        { path: "plan", message: "Expected one of free, pro" },
        { path: "address.city", message: "Can't be empty" },
        { path: "tags[1]", message: "Expected a string" },
      ],
    });
  });

  it("requires declared fields without defaults", async () => {
    const r = await json("/signup/1", "POST", {});
    expect(await r.json()).toEqual({
      error: "Validation failed",
      issues: [
        { path: "email", message: "Required" },
        { path: "age", message: "Required" },
      ],
    });
  });

  it("rejects a non-object body", async () => {
    const r = await json("/signup/1", "POST", [1, 2]);
    expect(await r.json()).toEqual({ error: "Validation failed", issues: [{ path: "(root)", message: "Expected an object" }] });
  });

  it("accepts the same DTO from a URL-encoded form, converting numeric strings", async () => {
    const r = await fetch(server.url + "/signup/1", { method: "POST", body: new URLSearchParams({ email: "a@b.c", age: "40", plan: "pro" }) });
    expect(await r.json()).toMatchObject({ email: "a@b.c", age: 40, plan: "pro" });
  });

  it("is required: no body is a 400", async () => {
    const r = await fetch(server.url + "/signup/1", { method: "POST" });
    expect(r.status).toBe(400);
    expect(await r.text()).toBe("Missing required request body: body");
  });

  it("passes the validated instance through @args", async () => {
    const r = await json("/signup/42?dry=1", "PATCH", { email: "a@b.c", age: 18 });
    expect(await r.json()).toEqual({ id: 42, dry: true, email: "a@b.c" });
  });
});

describe("raw bodies and fields", () => {
  it("answers 400 for invalid JSON", async () => {
    const r = await fetch(server.url + "/signup/1", { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
    expect(r.status).toBe(400);
    expect(await r.text()).toBe("Request body is not valid JSON");
  });

  it("doesn't read or require the body for handlers that don't touch it", async () => {
    const r = await fetch(server.url + "/signup/1");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("signup form");
  });

  it("reads form fields through a pipeline and validator", async () => {
    const ok = await fetch(server.url + "/signup/1", { method: "PUT", body: new URLSearchParams({ email: "  ADA@Example.com " }) });
    expect(await ok.json()).toEqual({ email: "ada@example.com" });
    const bad = await fetch(server.url + "/signup/1", { method: "PUT", body: new URLSearchParams({ email: "nope" }) });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toBe("that is not an email");
  });

  it("reads form fields from a JSON object body too", async () => {
    expect(await (await json("/signup/1", "PUT", { email: "X@Y.Z" })).json()).toEqual({ email: "x@y.z" });
  });

  it("parses text and bytes by content type", async () => {
    const text = await fetch(server.url + "/raw", { method: "POST", headers: { "content-type": "text/plain" }, body: "hi" });
    expect(await text.json()).toEqual({ type: "string", value: "hi" });
    const bytes = await fetch(server.url + "/raw", { method: "POST", body: new Uint8Array([1, 2, 3]) });
    expect(await bytes.json()).toEqual({ type: "bytes", value: 3 });
  });

  it("refuses bodies over the limit with 413", async () => {
    const r = await fetch(server.url + "/raw", { method: "POST", headers: { "content-type": "text/plain" }, body: "x".repeat(2048) });
    expect(r.status).toBe(413);
  });
});
