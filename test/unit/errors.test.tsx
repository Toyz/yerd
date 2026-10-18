// YerdError and its subclasses: what each one sends, writing your own, and yerd's own failures as instances of them.
import { describe, expect, it } from "vitest";
import {
  BadRequest, Conflict, Forbidden, Gone, MethodNotAllowed, NotAcceptable, NotFound, PayloadTooLarge, ServiceUnavailable,
  TooManyRequests, Unauthorized, UnsupportedMediaType, ValidationFailed, YerdError,
  body, catches, get, is, post, res, route, yerd,
} from "@toyz/yerd";

describe("the subclasses", () => {
  it.each([
    [BadRequest, 400, "Bad Request", "bad_request"],
    [Unauthorized, 401, "Unauthorized", "unauthorized"],
    [Forbidden, 403, "Forbidden", "forbidden"],
    [NotFound, 404, "Not Found", "not_found"],
    [MethodNotAllowed, 405, "Method Not Allowed", "method_not_allowed"],
    [NotAcceptable, 406, "Not Acceptable", "not_acceptable"],
    [Conflict, 409, "Conflict", "conflict"],
    [Gone, 410, "Gone", "gone"],
    [PayloadTooLarge, 413, "Content Too Large", "payload_too_large"],
    [UnsupportedMediaType, 415, "Unsupported Media Type", "unsupported_media_type"],
    [ValidationFailed, 400, "Validation failed", "validation_failed"],
    [TooManyRequests, 429, "Too Many Requests", "too_many_requests"],
    [ServiceUnavailable, 503, "Service Unavailable", "service_unavailable"],
  ] as const)("%o: %i %s, code %s", (Class, status, message, code) => {
    const error = new Class();
    expect(error).toBeInstanceOf(YerdError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ status, message, code, name: Class.name, expose: status < 500 });
  });

  it("take a message and override the code, details and headers", () => {
    const error = new NotFound("No such cat", { code: "cat_missing", details: { id: 7 }, headers: { "X-Hint": "try /cats" } });
    expect(error.toJSON()).toEqual({ error: "No such cat", code: "cat_missing", id: 7 });
    expect(error.headers).toEqual({ "x-hint": "try /cats" });
  });

  it("set the headers their own options stand for", () => {
    expect(new Unauthorized(undefined, { challenge: 'Bearer realm="api"' }).headers).toEqual({ "www-authenticate": 'Bearer realm="api"' });
    expect(new MethodNotAllowed(undefined, { allow: ["GET", "HEAD"] })).toMatchObject({ allow: ["GET", "HEAD"], headers: { allow: "GET, HEAD" } });
    expect(new TooManyRequests(undefined, { retryAfter: 29.2 }).headers).toEqual({ "retry-after": "30" });
    const at = new Date("2026-10-18T12:00:00Z");
    expect(new ServiceUnavailable(undefined, { retryAfter: at })).toMatchObject({ retryAfter: at, headers: { "retry-after": "Sun, 18 Oct 2026 12:00:00 GMT" } });
  });

  it("refuse a header or Retry-After that can't be sent", () => {
    expect(() => new TooManyRequests(undefined, { retryAfter: -1 })).toThrow(TypeError);
    expect(() => new TooManyRequests(undefined, { retryAfter: Number.NaN })).toThrow(TypeError);
    expect(() => new ServiceUnavailable(undefined, { retryAfter: new Date("nope") })).toThrow(TypeError);
    expect(() => new Unauthorized(undefined, { challenge: "Basic\r\nx: y" })).toThrow(TypeError);
    expect(() => new YerdError(418, "teapot", { headers: { "bad name": "x" } })).toThrow(TypeError);
  });

  it("ValidationFailed keeps its issues on the error and in the body; without any, the message is one", () => {
    const issues = [{ path: "email", message: "Already registered" }];
    const error = new ValidationFailed(undefined, { issues });
    expect(error.issues).toBe(issues);
    expect(error.toJSON()).toEqual({ error: "Validation failed", code: "validation_failed", issues });
    expect(new ValidationFailed("Too early").issues).toEqual([{ path: "(root)", message: "Too early" }]);
  });

  it("a plain YerdError has no code unless given", () => {
    expect(new YerdError(418).code).toBeUndefined();
    expect(new YerdError(418, "teapot").toJSON()).toEqual({ error: "teapot" });
  });
});

class OutOfStock extends Conflict {
  constructor(readonly sku: string) {
    super(`${sku} is out of stock`, { code: "out_of_stock", details: { sku } });
  }
}

class Problem extends YerdError {
  override toJSON() {
    return { type: `https://example.com/problems/${this.code}`, title: this.message, status: this.status };
  }
}

@route("/throw")
class Throws {
  @get thrown(): never {
    throw new OutOfStock("gnome-42");
  }
  @post plain(): never {
    throw new YerdError(418, "I'm a teapot");
  }
}

@route("/problem")
class Problems {
  @get problem(): never {
    throw new Problem(422, "Quantity must be positive", { code: "bad_qty", headers: { "content-type": "application/problem+json" } });
  }
}

@route("/down")
class Down {
  @get down(): never {
    throw new ServiceUnavailable("the primary is on fire", { code: "db_down", details: { host: "db-1" }, retryAfter: 120 });
  }
}

@route("/returned")
class Returned {
  @get returned() {
    return new NotFound("No such product");
  }
}

@route("/returned-crash")
class ReturnedCrash {
  @get crash() {
    return new Error("oops");
  }
}

@route("/returned-caught")
class ReturnedCaught {
  @get show() {
    return new NotFound();
  }
  @catches(NotFound) missing() {
    return "caught";
  }
}

class Signup {
  @is.email() email!: string;
}

@route("/signup")
class SignupPage {
  @body(Signup) accessor signup!: Promise<Signup>;
  @post async save() {
    return { email: (await this.signup).email };
  }
  @catches(ValidationFailed)
  invalid(error: ValidationFailed) {
    return res({ fix: error.issues.map((i) => i.path) }, { status: 422 });
  }
}

@route("/stock")
class Stock {
  @get buy(): never {
    throw new OutOfStock("gnome-7");
  }
  @catches(Conflict)
  conflict(error: Conflict) {
    return res(error instanceof OutOfStock ? `sorry, ${error.sku} is gone` : "conflict", { status: 409 });
  }
}

const app = () => yerd({ routes: [Throws, Problems, Down, Returned, ReturnedCrash, ReturnedCaught, SignupPage, Stock], services: [], handleSignals: false });

describe("writing your own", () => {
  it("a subclass is named after itself, instanceof its parents, with a stack", () => {
    const error = new OutOfStock("gnome-42");
    expect(error.name).toBe("OutOfStock");
    expect(error).toBeInstanceOf(Conflict);
    expect(error).toBeInstanceOf(YerdError);
    expect(error.stack).toContain("OutOfStock: gnome-42 is out of stock");
    expect(error.status).toBe(409);
  });

  it("answers with its JSON body", async () => {
    const r = await app().request("/throw");
    expect(r.status).toBe(409);
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await r.json()).toEqual({ error: "gnome-42 is out of stock", code: "out_of_stock", sku: "gnome-42" });
  });

  it("is caught by its parent's class, and is still itself", async () => {
    const r = await app().request("/stock");
    expect(await r.text()).toBe("sorry, gnome-7 is gone");
  });

  it("an overridden toJSON() is the body, with the content type its headers set", async () => {
    const r = await app().request("/problem");
    expect(r.status).toBe(422);
    expect(r.headers.get("content-type")).toBe("application/problem+json");
    expect(await r.json()).toEqual({ type: "https://example.com/problems/bad_qty", title: "Quantity must be positive", status: 422 });
  });

  it("an error without a code or details answers in plain text", async () => {
    const r = await app().request("/throw", { method: "POST" });
    expect(r.status).toBe(418);
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await r.text()).toBe("I'm a teapot");
  });

  it("returning one counts as throwing it, for `?? new NotFound()`", async () => {
    const r = await app().request("/returned");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "No such product", code: "not_found" });
    // @catches sees it too; its answer keeps the error's status.
    const caught = await app().request("/returned-caught");
    expect(caught.status).toBe(404);
    expect(await caught.text()).toBe("caught");
  });

  it("a returned plain Error is a crash, like a thrown one", async () => {
    expect((await app().request("/returned-crash")).status).toBe(500);
  });
});

describe("unexposed errors", () => {
  it("send the status text and their headers, never the message, code or details", async () => {
    const r = await app().request("/down");
    expect(r.status).toBe(503);
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(r.headers.get("retry-after")).toBe("120");
    const text = await r.text();
    expect(text).toBe("Service Unavailable");
    expect(text).not.toMatch(/fire|db_down|db-1/);
  });
});

describe("error headers", () => {
  it("go on the error page too", async () => {
    const r = await app()
      .errorPage(({ status, message }) => <main>{status} {message}</main>)
      .request("/down", { headers: { accept: "text/html" } });
    expect(r.status).toBe(503);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(r.headers.get("retry-after")).toBe("120");
    expect(await r.text()).toContain("Service Unavailable");
  });

  it("go on an onError answer, unless it set the header itself", async () => {
    const r = await app()
      .onError(() => res("later", { status: 503, headers: { "x-own": "1" } }))
      .request("/down");
    expect(r.status).toBe(503);
    expect(await r.text()).toBe("later");
    expect(r.headers.get("retry-after")).toBe("120");
    const own = await app()
      .onError(() => res("later", { status: 503, headers: { "retry-after": "5" } }))
      .request("/down");
    expect(own.headers.get("retry-after")).toBe("5");
  });
});

describe("yerd's own failures", () => {
  it("an unmatched path reaches onError as a NotFound", async () => {
    let seen: unknown;
    const r = await app()
      .onError((error) => {
        seen = error;
        return undefined;
      })
      .request("/nowhere");
    expect(seen).toBeInstanceOf(NotFound);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "Not Found", code: "not_found" });
  });

  it("a method a route doesn't answer is a MethodNotAllowed carrying Allow", async () => {
    let seen: unknown;
    const r = await app()
      .onError((error) => {
        seen = error;
        return undefined;
      })
      .request("/returned", { method: "DELETE" });
    expect(seen).toBeInstanceOf(MethodNotAllowed);
    expect((seen as MethodNotAllowed).allow).toEqual(["GET", "HEAD"]);
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET, HEAD");
  });

  it("a failed DTO is a ValidationFailed with its issues, for @catches", async () => {
    const r = await app().request("/signup", { method: "POST", headers: { "content-type": "application/json" }, body: '{"email":"nope"}' });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ fix: ["email"] });
  });

  it("a cross-site post is a Forbidden", async () => {
    let seen: unknown;
    const r = await app()
      .onError((error) => {
        seen = error;
        return undefined;
      })
      .request("/signup", { method: "POST", headers: { "sec-fetch-site": "cross-site" } });
    expect(seen).toBeInstanceOf(Forbidden);
    expect(r.status).toBe(403);
  });
});
