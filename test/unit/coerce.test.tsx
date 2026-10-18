import { describe, expect, it } from "vitest";
import { bare, redirect, res, type Child } from "@toyz/yerd";
import { coerce } from "../../src/respond/coerce.js";

const opts = { layouts: [] };

async function text(body: unknown): Promise<string> {
  if (body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  let out = "";
  for await (const chunk of body as AsyncIterable<string>) out += chunk;
  return out;
}

describe("coerce", () => {
  it("string -> text/plain", async () => {
    const out = await coerce("pong", opts);
    expect(out).toMatchObject({ status: 200, body: "pong" });
    expect(out.headers["content-type"]).toMatch(/^text\/plain/);
  });

  it("number -> bare status", async () => {
    expect(await coerce(418, opts)).toEqual({ status: 418, headers: {}, body: null, explicitStatus: true });
    expect(() => coerce(1.5, opts)).toThrow(/status code/);
    expect(() => coerce(42, opts)).toThrow(/status code/);
  });

  it("undefined / null -> 204", async () => {
    expect((await coerce(undefined, opts)).status).toBe(204);
    expect((await coerce(null, opts)).status).toBe(204);
  });

  it("plain objects, arrays and booleans -> json", async () => {
    const out = await coerce({ ok: true }, opts);
    expect(out.headers["content-type"]).toMatch(/^application\/json/);
    expect(out.body).toBe('{"ok":true}');
    expect((await coerce([1], opts)).body).toBe("[1]");
    expect((await coerce(false, opts)).body).toBe("false");
  });

  it("sends your own class instances and toJSON values as JSON", async () => {
    class Signup {
      email = "a@b.c";
      plan = "pro";
    }
    expect((await coerce(new Signup(), opts)).body).toBe('{"email":"a@b.c","plan":"pro"}');
    expect((await coerce({ at: new Date(0) }, opts)).body).toBe('{"at":"1970-01-01T00:00:00.000Z"}');
    expect((await coerce(new Date(0), opts)).body).toBe('"1970-01-01T00:00:00.000Z"');
  });

  it("refuses built-ins JSON can't represent, saying what to do", async () => {
    expect(() => coerce(new Map(), opts)).toThrow(/a Map \(JSON can't represent it/);
    expect(() => coerce(new Error("x"), opts)).toThrow(/answer with a response, not another error/);
  });

  it("Uint8Array -> octet-stream", async () => {
    const out = await coerce(new Uint8Array([1, 2]), opts);
    expect(out.headers["content-type"]).toBe("application/octet-stream");
  });

  it("async iterables -> stream", async () => {
    async function* gen() {
      yield "a";
      yield "b";
    }
    expect(await text((await coerce(gen(), opts)).body)).toBe("ab");
  });

  it("awaits promises", async () => {
    expect((await coerce(Promise.resolve("x"), opts)).body).toBe("x");
  });

  it("JSX -> html document wrapped in layouts, outermost first", async () => {
    const Outer = ({ children }: { children: Child }) => <html><body>{children}</body></html>;
    const Inner = ({ children }: { children: Child }) => <main>{children}</main>;
    const out = await coerce(<h1>hi</h1>, { layouts: [Outer, Inner] });
    expect(out.headers["content-type"]).toMatch(/^text\/html/);
    expect(await text(out.body)).toBe("<!doctype html><html><body><main><h1>hi</h1></main></body></html>");
  });

  it("bare() skips layouts", async () => {
    const Outer = ({ children }: { children: Child }) => <html>{children}</html>;
    expect(await text((await coerce(bare(<li>x</li>), { layouts: [Outer] })).body)).toBe("<li>x</li>");
  });

  it("res() sets status and headers and coerces its body", async () => {
    const out = await coerce(res(<p>made</p>, { status: 201, headers: { "x-a": "1" } }), opts);
    expect(out.status).toBe(201);
    expect(out.headers).toMatchObject({ "x-a": "1", "content-type": "text/html; charset=utf-8" });
    expect(await text(out.body)).toBe("<p>made</p>");
  });

  it("redirect() is a 303 with a location", async () => {
    expect(await coerce(redirect("/login"), opts)).toEqual({ status: 303, headers: { location: "/login" }, body: null, explicitStatus: true });
  });
});
