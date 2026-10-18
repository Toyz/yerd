import { request as httpRequest, type IncomingMessage } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HttpError, args, between, body, email, field, file, files, get, header, is, length, lower, matches, oneOf, param, params, post,
  query, request, route, signal, toBool, toInt, toNumber, trim, uuid, yerd,
  type RunningServer,
} from "@toyz/yerd";

@route("/q")
class Q {
  @query("pick", { required: true }) accessor pick!: string;
  @query("v", { transform: toInt }) accessor int: number | undefined;
  @query("v", { transform: toNumber }) accessor num: number | undefined;
  @query("v", { transform: toBool }) accessor bool: boolean | undefined;
  @query("v", { transform: [trim, lower] }) accessor tl: string | undefined;
  @query("v", { transform: [trim, lower, oneOf("asc", "desc")] }) accessor sort: "asc" | "desc" | undefined;
  @query("v", { transform: toInt, validate: between(1, 10) }) accessor ranged: number | undefined;
  @query("v", { validate: length(2, 4) }) accessor len: string | undefined;
  @query("v", { validate: length(0, 2) }) accessor short: string | undefined;
  @query("v", { validate: length(3) }) accessor long: string | undefined;
  @query("v", { validate: matches(/^[a-z]+$/g) }) accessor letters: string | undefined;
  @query("v", { validate: matches(/^\d+$/, "digits please") }) accessor digits: string | undefined;
  @query("v", { validate: uuid() }) accessor id: string | undefined;
  @query("v", { validate: uuid(4) }) accessor id4: string | undefined;
  @query("v", { validate: email() }) accessor mail: string | undefined;
  @query("v", { validate: (s: string) => s !== "bad" }) accessor generic: string | undefined;
  @query("v", { validate: [(s: string) => s.length > 1 || "too short", (s: string) => s !== "no" || "not no"] }) accessor chain: string | undefined;
  @query("v", { required: true }) accessor req!: string;
  @query("v") accessor plain = "default";
  @query("V") accessor upper: string | undefined;

  @get read() {
    const value = (this as unknown as Record<string, unknown>)[this.pick];
    return { value: value === undefined ? "(undefined)" : value };
  }
}

@route("/s/:name")
class Seg {
  @param("name") accessor name!: string;
  @params accessor all!: Record<string, string>;
  @get read() {
    return { name: this.name, all: this.all };
  }
}

@route("/n/:id")
class Num {
  @param("id", { transform: toInt, validate: between(1, 1000) }) accessor id!: number;
  @get read() {
    return { id: this.id };
  }
}

@route("/h")
class H {
  @header("X-Custom") accessor custom: string | undefined;
  @header("x-count", { transform: toInt }) accessor count: number | undefined;
  @header("x-token", { required: true }) accessor token!: string;
  @header("x-mode", { transform: [trim, lower, oneOf("a", "b")] }) accessor mode: "a" | "b" = "a";

  @get read() {
    return { custom: this.custom ?? null, count: this.count ?? null, token: this.token, mode: this.mode };
  }
}

class Signup {
  @is.string({ transform: [trim, lower], validate: matches(/@/, "That is not an email") }) email!: string;
  @is.int({ validate: between(13, 120) }) age!: number;
  @is.boolean({ optional: true }) newsletter?: boolean;
  @is.array(is.string(), { optional: true }) tags?: string[];
  isAdmin = false;
}

class Profile {
  @is.string() name!: string;
  @is.file({ types: ["image/*"], maxSize: 10, optional: true }) avatar?: File;
  @is.files({ optional: true, max: 2 }) attachments?: File[];
}

@route("/dto")
class DtoRoute {
  @body(Signup) accessor signup!: Promise<Signup>;
  @post async create() {
    const s = await this.signup;
    return { instance: s instanceof Signup, ...s };
  }
}

@route("/profile")
class ProfileRoute {
  @body(Profile) accessor profile!: Promise<Profile>;
  @post async save() {
    const p = await this.profile;
    return { name: p.name, avatar: p.avatar?.name ?? null, attachments: p.attachments?.map((f) => f.name) ?? null };
  }
}

@route("/raw")
class RawBody {
  @body() accessor raw!: Promise<unknown>;
  @post async read() {
    const value = await this.raw;
    return { value: value === undefined ? "(undefined)" : value };
  }
}

@route("/raw-required")
class RawRequired {
  @body({ required: true, transform: (v: unknown) => (typeof v === "string" ? v.toUpperCase() : v) }) accessor raw!: Promise<unknown>;
  @post async read() {
    return { value: await this.raw };
  }
}

@route("/field")
class FieldRoute {
  @field("email", { transform: [trim, lower], validate: matches(/@/, "That is not an email"), required: true }) accessor email!: Promise<string>;
  @field("n", { transform: toInt }) accessor n!: Promise<number | undefined>;

  @post async read() {
    return { email: await this.email };
  }

  @get async readN() {
    return { n: (await this.n) ?? null };
  }
}

@route("/optional-field")
class OptionalField {
  @field("source", { transform: trim }) accessor source!: Promise<string | undefined>;
  @post async read() {
    return { source: (await this.source) ?? null };
  }
}

@route("/upload")
class Upload {
  @file("avatar", { required: true, types: ["image/png", "image/jpeg"], maxSize: 8 }) accessor avatar!: Promise<File>;
  @files("extras", { types: ["image/*"] }) accessor extras!: Promise<File[]>;
  @post async upload() {
    const avatar = await this.avatar;
    return { name: avatar.name, bytes: avatar.size, extras: (await this.extras).map((f) => f.name) };
  }
}

@route("/args/:id")
class ArgsRoute {
  @post
  @args(param("id", { transform: toInt }), query("dry", { transform: toBool }), body(Signup), signal, request)
  update(id: number, dry: boolean | undefined, s: Signup, stop: AbortSignal, req: IncomingMessage) {
    return { id, dry: dry ?? null, email: s.email, aborted: stop.aborted, method: req.method };
  }
}

@route("/crash")
class Crash {
  @query("v", {
    transform: (): string => {
      throw new Error("not an HttpError");
    },
  })
  accessor v: string | undefined;
  @query("w", {
    transform: (): string => {
      throw new HttpError(422, "custom status");
    },
  })
  accessor w: string | undefined;

  @get read() {
    return { v: this.v ?? null, w: this.w ?? null };
  }
}

let server: RunningServer;
beforeAll(async () => {
  server = await yerd({
    routes: [Q, Seg, Num, H, DtoRoute, ProfileRoute, RawBody, RawRequired, FieldRoute, OptionalField, Upload, ArgsRoute, Crash],
    bodyLimit: 64 * 1024,
  })
    .logging({ filter: "off" })
    .listen(0, "127.0.0.1");
});
afterAll(() => server.close());

async function read(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const r = await fetch(server.url + path, init);
  const body = r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text();
  return { status: r.status, body };
}

/**
 * A multipart body the way a browser sends it. fetch's FormData leaves the
 * filename out for a File named "", which turns it into a text field, so
 * empty file inputs have to be built by hand.
 */
function browserForm(parts: { name: string; value?: string; filename?: string; type?: string }[]): RequestInit {
  const boundary = "----BrowserBoundary7MA4YWxkTrZu0gW";
  let text = "";
  for (const part of parts) {
    text += `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) text += `; filename="${part.filename}"\r\nContent-Type: ${part.type ?? "application/octet-stream"}`;
    text += `\r\n\r\n${part.value ?? ""}\r\n`;
  }
  return { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body: `${text}--${boundary}--\r\n` };
}

const q = (pick: string, v?: string) => read(`/q?pick=${pick}${v === undefined ? "" : `&v=${v}`}`);
const ok = (value: unknown) => ({ status: 200, body: { value } });
const bad = (message: string) => ({ status: 400, body: message });

describe("@query with transforms", () => {
  it.each<[string, string | undefined, unknown]>([
    ["int", "42", ok(42)],
    ["int", "-7", ok(-7)],
    ["int", "-0", ok(0)],
    ["int", "007", ok(7)],
    ["int", "9007199254740991", ok(9007199254740991)],
    ["int", "9007199254740992", bad("Integer out of range: 9007199254740992")],
    ["int", "1.5", bad('Expected an integer, got "1.5"')],
    ["int", "1e3", bad('Expected an integer, got "1e3"')],
    ["int", "0x10", bad('Expected an integer, got "0x10"')],
    ["int", "%2042%20", bad('Expected an integer, got " 42 "')],
    ["int", "%2B1", bad('Expected an integer, got "+1"')],
    ["int", "", bad('Expected an integer, got ""')],
    ["int", undefined, ok("(undefined)")],
    ["num", "1.5", ok(1.5)],
    ["num", "-.5", ok(-0.5)],
    ["num", "1e3", ok(1000)],
    ["num", "%2042%20", ok(42)],
    ["num", "1e999", bad('Expected a number, got "1e999"')],
    ["num", "Infinity", bad('Expected a number, got "Infinity"')],
    ["num", "NaN", bad('Expected a number, got "NaN"')],
    ["num", "0x10", bad('Expected a number, got "0x10"')],
    ["num", "", bad('Expected a number, got ""')],
    ["num", "%20", bad('Expected a number, got " "')],
    ["bool", "true", ok(true)],
    ["bool", "1", ok(true)],
    ["bool", "", ok(true)],
    ["bool", "false", ok(false)],
    ["bool", "0", ok(false)],
    ["bool", "TRUE", bad('Expected a boolean, got "TRUE"')],
    ["bool", "on", bad('Expected a boolean, got "on"')],
    ["bool", "yes", bad('Expected a boolean, got "yes"')],
    ["tl", "%20%20MiXeD%20", ok("mixed")],
    ["sort", "%20DESC", ok("desc")],
    ["sort", "up", bad('Expected one of asc, desc, got "up"')],
    ["ranged", "1", ok(1)],
    ["ranged", "10", ok(10)],
    ["ranged", "0", bad("Must be from 1 to 10 (got 0)")],
    ["ranged", "11", bad("Must be from 1 to 10 (got 11)")],
    ["len", "ab", ok("ab")],
    ["len", "abcd", ok("abcd")],
    ["len", "a", bad("Must be 2 to 4 characters (got 1)")],
    ["len", "abcde", bad("Must be 2 to 4 characters (got 5)")],
    ["len", "", bad("Can't be empty")],
    ["short", "", ok("")],
    ["short", "abc", bad("Must be at most 2 characters (got 3)")],
    ["long", "ab", bad("Must be at least 3 characters (got 2)")],
    ["letters", "abc", ok("abc")],
    ["letters", "abc1", bad("Isn't in the expected format")],
    ["digits", "12a", bad("digits please")],
    ["id", "3F2B8C1E-9A7D-4E6F-8B5C-1D2E3F4A5B6C", ok("3F2B8C1E-9A7D-4E6F-8B5C-1D2E3F4A5B6C")],
    ["id", "3f2b8c1e9a7d4e6f8b5c1d2e3f4a5b6c", bad("Expected a UUID")],
    ["id4", "01890a5d-ac96-774b-bcce-b302099a8057", bad("Expected a version 4 UUID")],
    ["mail", "a%40b.co", ok("a@b.co")],
    ["mail", "a%40b", bad("Expected an email address")],
    ["generic", "bad", bad("Invalid query parameter: v")],
    ["chain", "x", bad("too short")],
    ["chain", "no", bad("not no")],
    ["req", undefined, bad("Missing required query parameter: v")],
    ["req", "", ok("")],
    ["plain", undefined, ok("default")],
    ["plain", "", ok("")],
    ["plain", "a+b%20c", ok("a b c")],
    ["plain", "%ZZ", ok("%ZZ")],
    ["plain", "%E2%9C%93", ok("✓")],
    ["plain", "%FF", ok("�")],
  ])("%s=%j", async (pick, v, expected) => {
    expect(await q(pick, v)).toEqual(expected);
  });

  it("a global regex in matches() gives the same answer every time", async () => {
    for (let i = 0; i < 3; i++) expect(await q("letters", "abc")).toEqual(ok("abc"));
  });

  it("takes the first of repeated keys", async () => {
    expect(await read("/q?pick=int&v=1&v=2")).toEqual(ok(1));
    expect(await read("/q?pick=int&v=x&v=2")).toEqual(bad('Expected an integer, got "x"'));
  });

  it("a bare ?v counts as present and empty", async () => {
    expect(await read("/q?pick=plain&v")).toEqual(ok(""));
    expect(await read("/q?pick=req&v")).toEqual(ok(""));
  });

  it("query names are case-sensitive", async () => {
    expect(await read("/q?pick=upper&v=lower")).toEqual(ok("(undefined)"));
    expect(await read("/q?pick=upper&V=x")).toEqual(ok("x"));
  });

  it("an encoded name matches its decoded form", async () => {
    expect(await read("/q?pick=plain&%76=enc")).toEqual(ok("enc"));
  });

  it("the required pick itself missing is a 400", async () => {
    expect(await read("/q")).toEqual(bad("Missing required query parameter: pick"));
  });
});

describe("@param and @params", () => {
  it.each([
    ["/s/plain", "plain"],
    ["/s/a%20b", "a b"],
    ["/s/a+b", "a+b"],
    ["/s/a%2Fb", "a/b"],
    ["/s/%E2%9C%93", "✓"],
    ["/s/%ZZ", "%ZZ"],
    ["/s/%E0%A4%A", "%E0%A4%A"],
    ["/s/__proto__", "__proto__"],
  ])("%s -> %j", async (path, name) => {
    expect(await read(path)).toEqual({ status: 200, body: { name, all: { name } } });
  });

  it.each([
    ["/n/1", { status: 200, body: { id: 1 } }],
    ["/n/1000", { status: 200, body: { id: 1000 } }],
    ["/n/0", bad("Must be from 1 to 1000 (got 0)")],
    ["/n/1001", bad("Must be from 1 to 1000 (got 1001)")],
    ["/n/abc", bad('Expected an integer, got "abc"')],
    ["/n/1.0", bad('Expected an integer, got "1.0"')],
    ["/n/%201", bad('Expected an integer, got " 1"')],
    ["/n/99999999999999999999", bad("Integer out of range: 99999999999999999999")],
  ])("%s", async (path, expected) => {
    expect(await read(path)).toEqual(expected);
  });
});

describe("@header", () => {
  const h = (headers: Record<string, string>) => read("/h", { headers: { "x-token": "t", ...headers } });

  it("matches the name case-insensitively and uses defaults", async () => {
    expect(await h({ "x-CUSTOM": "v" })).toEqual({ status: 200, body: { custom: "v", count: null, token: "t", mode: "a" } });
  });

  it("transforms and validates", async () => {
    expect(await h({ "x-count": "12", "x-mode": " B " })).toEqual({ status: 200, body: { custom: null, count: 12, token: "t", mode: "b" } });
    expect(await h({ "x-count": "twelve" })).toEqual(bad('Expected an integer, got "twelve"'));
    expect(await h({ "x-mode": "c" })).toEqual(bad('Expected one of a, b, got "c"'));
  });

  it("a required header that's missing is a 400 naming it as declared", async () => {
    expect(await read("/h")).toEqual(bad("Missing required header: x-token"));
  });

  it("an empty header value is present, not missing", async () => {
    expect(await h({ "x-custom": "" })).toMatchObject({ body: { custom: "" } });
  });

  it("repeated headers are joined with a comma", async () => {
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(server.url + "/h", { headers: { "x-token": "t", "x-custom": ["a", "b"] } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve(text));
      });
      req.on("error", reject);
      req.end();
    });
    expect(JSON.parse(body)).toMatchObject({ custom: "a, b" });
  });
});

describe("@body(Dto)", () => {
  const post = (path: string, type: string, data: BodyInit) => read(path, { method: "POST", headers: { "content-type": type }, body: data });
  const json = (data: unknown) => post("/dto", "application/json", JSON.stringify(data));

  it("validates JSON into an instance, dropping unknown keys", async () => {
    expect(await json({ email: " A@B.co ", age: "30", isAdmin: true, role: "root" })).toEqual({
      status: 200,
      body: { instance: true, email: "a@b.co", age: 30, isAdmin: false },
    });
  });

  it("answers a 400 with every issue as JSON", async () => {
    const r = await fetch(server.url + "/dto", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "nope", age: 7, tags: ["a", 1] }) });
    expect(r.status).toBe(400);
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await r.json()).toEqual({
      error: "Validation failed",
      issues: [
        { path: "email", message: "That is not an email" },
        { path: "age", message: "Must be from 13 to 120 (got 7)" },
        { path: "tags[1]", message: "Expected a string" },
      ],
    });
  });

  it.each([
    ["application/json", "[]"],
    ["application/json", "null"],
    ["application/json", '"string"'],
    ["application/json", "42"],
    ["text/plain", "email=a@b.co&age=30"],
    ["application/octet-stream", "\u0000\u0001"],
    ["application/x-ndjson", '{"email":"a@b.co","age":30}'],
  ])("a %s body of %j is a (root) issue, not a crash", async (type, data) => {
    expect(await post("/dto", type, data)).toEqual({ status: 400, body: { error: "Validation failed", issues: [{ path: "(root)", message: "Expected an object" }] } });
  });

  it("no body at all is a 400", async () => {
    expect(await read("/dto", { method: "POST" })).toEqual(bad("Missing required request body: body"));
  });

  it("malformed JSON is a 400 before validation", async () => {
    expect(await post("/dto", "application/json", "{")).toEqual(bad("Request body is not valid JSON"));
  });

  it("validates a URL-encoded form with string coercion and repeated keys", async () => {
    expect(await post("/dto", "application/x-www-form-urlencoded", "email=a%40b.co&age=30&newsletter=on&tags=x&tags=y&isAdmin=true")).toEqual({
      status: 200,
      body: { instance: true, email: "a@b.co", age: 30, newsletter: true, tags: ["x", "y"], isAdmin: false },
    });
  });

  it("a form field sent once still fills an array field", async () => {
    expect(await post("/dto", "application/x-www-form-urlencoded", "email=a%40b.co&age=30&tags=x")).toMatchObject({ body: { tags: ["x"] } });
  });

  it("a repeated form field where a scalar is expected is an issue", async () => {
    expect(await post("/dto", "application/x-www-form-urlencoded", "email=a%40b.co&age=30&age=31")).toEqual({
      status: 400,
      body: { error: "Validation failed", issues: [{ path: "age", message: "Expected an integer" }] },
    });
  });

  it("prototype keys in JSON and forms are ignored", async () => {
    expect(await post("/dto", "application/json", '{"email":"a@b.co","age":30,"__proto__":{"isAdmin":true}}')).toMatchObject({ body: { isAdmin: false } });
    expect(await post("/dto", "application/x-www-form-urlencoded", "email=a%40b.co&age=30&__proto__=x&constructor=y")).toMatchObject({ status: 200, body: { isAdmin: false } });
  });

  it("an empty JSON object reports each required field", async () => {
    expect(await json({})).toEqual({
      status: 400,
      body: { error: "Validation failed", issues: [{ path: "email", message: "Required" }, { path: "age", message: "Required" }] },
    });
  });
});

describe("@body(Dto) with uploads", () => {
  const send = (fd: FormData) => read("/profile", { method: "POST", body: fd });

  it("puts files next to fields", async () => {
    const fd = new FormData();
    fd.append("name", "ada");
    fd.append("avatar", new File(["png"], "a.png", { type: "image/png" }));
    fd.append("attachments", new File(["1"], "1.txt"));
    expect(await send(fd)).toEqual({ status: 200, body: { name: "ada", avatar: "a.png", attachments: ["1.txt"] } });
  });

  it("an empty file input is the same as not sending the field", async () => {
    const init = browserForm([{ name: "name", value: "ada" }, { name: "avatar", filename: "" }, { name: "attachments", filename: "" }]);
    expect(await read("/profile", init)).toEqual({ status: 200, body: { name: "ada", avatar: null, attachments: null } });
  });

  it("an empty file input next to real files is dropped from the list", async () => {
    const init = browserForm([
      { name: "name", value: "ada" },
      { name: "attachments", filename: "" },
      { name: "attachments", filename: "real.txt", value: "x" },
    ]);
    expect(await read("/profile", init)).toEqual({ status: 200, body: { name: "ada", avatar: null, attachments: ["real.txt"] } });
  });

  it("reports file problems as issues", async () => {
    const fd = new FormData();
    fd.append("name", "ada");
    fd.append("avatar", new File(["x".repeat(11)], "a.png", { type: "image/png" }));
    for (const n of ["1", "2", "3"]) fd.append("attachments", new File([n], `${n}.txt`));
    expect(await send(fd)).toEqual({
      status: 400,
      body: {
        error: "Validation failed",
        issues: [
          { path: "avatar", message: "File is larger than 10 bytes" },
          { path: "attachments", message: "Expected at most 2 files" },
        ],
      },
    });
  });

  it("a text value where a file is expected is an issue, and several files where one is expected too", async () => {
    const fd = new FormData();
    fd.append("name", "ada");
    fd.append("avatar", "not a file");
    expect(await send(fd)).toMatchObject({ status: 400, body: { issues: [{ path: "avatar", message: "Expected a file" }] } });
    const two = new FormData();
    two.append("name", "ada");
    two.append("avatar", new File(["a"], "a.png", { type: "image/png" }));
    two.append("avatar", new File(["b"], "b.png", { type: "image/png" }));
    expect(await send(two)).toMatchObject({ status: 400, body: { issues: [{ path: "avatar", message: "Expected one file" }] } });
  });

  it("a file where a string is expected is an issue", async () => {
    const fd = new FormData();
    fd.append("name", new File(["x"], "x.txt"));
    expect(await send(fd)).toMatchObject({ status: 400, body: { issues: [{ path: "name", message: "Expected a string" }] } });
  });

  it("a file with the same name as a text field wins in the DTO", async () => {
    const fd = new FormData();
    fd.append("name", "ada");
    fd.append("avatar", "text");
    fd.append("avatar", new File(["p"], "p.png", { type: "image/png" }));
    expect(await send(fd)).toEqual({ status: 200, body: { name: "ada", avatar: "p.png", attachments: null } });
  });
});

describe("@body() without a DTO", () => {
  const post = (path: string, init: RequestInit) => read(path, { method: "POST", ...init });

  it("no body resolves to undefined", async () => {
    expect(await post("/raw", {})).toEqual(ok("(undefined)"));
  });

  it("JSON null is null, not missing", async () => {
    expect(await post("/raw", { headers: { "content-type": "application/json" }, body: "null" })).toEqual(ok(null));
  });

  it("a form is an object of strings and arrays", async () => {
    expect(await post("/raw", { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=1&a=2&b=3" })).toEqual(ok({ a: ["1", "2"], b: "3" }));
  });

  it("required: true turns no body into a 400 and runs the transform otherwise", async () => {
    expect(await post("/raw-required", {})).toEqual(bad("Missing required request body: body"));
    expect(await post("/raw-required", { headers: { "content-type": "text/plain" }, body: "shout" })).toEqual(ok("SHOUT"));
  });
});

describe("@field", () => {
  const post = (path: string, type: string, data: string) => read(path, { method: "POST", headers: { "content-type": type }, body: data });

  it.each<[string, string, unknown]>([
    ["application/x-www-form-urlencoded", "email=%20A%40B.co%20", { status: 200, body: { email: "a@b.co" } }],
    ["application/x-www-form-urlencoded", "email=a%40b.co&email=c%40d.co", { status: 200, body: { email: "a@b.co" } }],
    ["application/x-www-form-urlencoded", "email=nope", bad("That is not an email")],
    ["application/x-www-form-urlencoded", "other=1", bad("Missing required form field: email")],
    ["application/json", '{"email":"A@B.co"}', { status: 200, body: { email: "a@b.co" } }],
    ["application/json", '{"email":["a@b.co","c@d.co"]}', { status: 200, body: { email: "a@b.co" } }],
    ["application/json", '{"email":{"nested":"a@b.co"}}', bad("Missing required form field: email")],
    ["application/json", '{"email":null}', bad("Missing required form field: email")],
    ["application/json", '{"email":["a@b.co",1]}', bad("Missing required form field: email")],
    ["application/json", '["a@b.co"]', bad("Missing required form field: email")],
    ["application/json", '"a@b.co"', bad("Missing required form field: email")],
    ["text/plain", "email=a@b.co", bad("Missing required form field: email")],
    ["application/octet-stream", "email=a@b.co", bad("Missing required form field: email")],
    ["application/x-ndjson", '{"email":"a@b.co"}', bad("Missing required form field: email")],
  ])("%s %s", async (type, data, expected) => {
    expect(await post("/field", type, data)).toEqual(expected);
  });

  // Regression: an empty JSON array passed the "array of strings" check, so
  // its missing first item went into the pipeline as undefined (a 500 from trim).
  it("an empty JSON array counts as missing", async () => {
    expect(await post("/field", "application/json", '{"email":[]}')).toEqual(bad("Missing required form field: email"));
    expect(await post("/optional-field", "application/json", '{"source":[]}')).toEqual({ status: 200, body: { source: null } });
  });

  it("stringifies JSON numbers and booleans", async () => {
    expect(await post("/optional-field", "application/json", '{"source":42}')).toEqual({ status: 200, body: { source: "42" } });
    expect(await post("/optional-field", "application/json", '{"source":false}')).toEqual({ status: 200, body: { source: "false" } });
  });

  it("reads multipart text fields but not files", async () => {
    const fd = new FormData();
    fd.append("email", "a@b.co");
    expect(await read("/field", { method: "POST", body: fd })).toEqual({ status: 200, body: { email: "a@b.co" } });
    const onlyFile = new FormData();
    onlyFile.append("email", new File(["a@b.co"], "e.txt"));
    expect(await read("/field", { method: "POST", body: onlyFile })).toEqual(bad("Missing required form field: email"));
  });

  it("a GET with no body leaves an optional field undefined, and a required one is a 400", async () => {
    expect(await read("/field")).toEqual({ status: 200, body: { n: null } });
  });

  it("__proto__ is not a field unless sent", async () => {
    expect(await post("/optional-field", "application/x-www-form-urlencoded", "constructor=x")).toEqual({ status: 200, body: { source: null } });
  });
});

describe("@file and @files", () => {
  const upload = (fd: FormData) => read("/upload", { method: "POST", body: fd });
  const png = (name: string, size = 4, type = "image/png") => new File([new Uint8Array(size)], name, { type });

  it("returns the first file and every extra", async () => {
    const fd = new FormData();
    fd.append("avatar", png("a.png"));
    fd.append("avatar", png("ignored.png"));
    fd.append("extras", png("e1.gif", 2, "image/gif"));
    fd.append("extras", png("e2.webp", 2, "image/webp"));
    expect(await upload(fd)).toEqual({ status: 200, body: { name: "a.png", bytes: 4, extras: ["e1.gif", "e2.webp"] } });
  });

  it("checks every file, not only the first", async () => {
    const fd = new FormData();
    fd.append("avatar", png("a.png"));
    fd.append("avatar", png("big.png", 9));
    expect(await upload(fd)).toEqual({ status: 413, body: "avatar: big.png is larger than 8 bytes" });
  });

  it.each<[string, () => FormData, unknown]>([
    ["no avatar", () => new FormData(), bad("Missing file: avatar")],
    [
      "a text field named avatar",
      () => {
        const fd = new FormData();
        fd.append("avatar", "a.png");
        return fd;
      },
      bad("Missing file: avatar"),
    ],
    [
      "a file one byte too big",
      () => {
        const fd = new FormData();
        fd.append("avatar", png("a.png", 9));
        return fd;
      },
      { status: 413, body: "avatar: a.png is larger than 8 bytes" },
    ],
    [
      "a gif",
      () => {
        const fd = new FormData();
        fd.append("avatar", png("a.gif", 4, "image/gif"));
        return fd;
      },
      { status: 415, body: "avatar: image/gif isn't accepted (image/png, image/jpeg)" },
    ],
    [
      "an untyped file",
      () => {
        const fd = new FormData();
        fd.append("avatar", new File(["x"], "x"));
        return fd;
      },
      { status: 415, body: "avatar: application/octet-stream isn't accepted (image/png, image/jpeg)" },
    ],
    [
      "an extra that isn't an image",
      () => {
        const fd = new FormData();
        fd.append("avatar", png("a.png"));
        fd.append("extras", png("x.txt", 1, "text/plain"));
        return fd;
      },
      { status: 415, body: "extras: text/plain isn't accepted (image/*)" },
    ],
  ])("%s", async (_label, make, expected) => {
    expect(await upload(make())).toEqual(expected);
  });

  it("an empty file input (filename=\"\", no bytes) is no file", async () => {
    expect(await read("/upload", browserForm([{ name: "avatar", filename: "", type: "image/png" }]))).toEqual(bad("Missing file: avatar"));
  });

  it("a file with no filename but real bytes still counts", async () => {
    const init = browserForm([{ name: "avatar", filename: "", type: "image/png", value: "1234" }]);
    expect(await read("/upload", init)).toEqual({ status: 200, body: { name: "", bytes: 4, extras: [] } });
  });

  it("a non-multipart body has no files", async () => {
    expect(await read("/upload", { method: "POST", headers: { "content-type": "application/json" }, body: '{"avatar":"a.png"}' })).toEqual(bad("Missing file: avatar"));
  });
});

describe("@args, @signal and @request", () => {
  it("resolves every argument in order, awaiting the body", async () => {
    const r = await read("/args/7?dry=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@b.co", age: 20 }) });
    expect(r).toEqual({ status: 200, body: { id: 7, dry: true, email: "a@b.co", aborted: false, method: "POST" } });
  });

  it("a failing argument rejects the request with its own error", async () => {
    expect(await read("/args/x", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).toEqual(bad('Expected an integer, got "x"'));
    expect(await read("/args/1?dry=maybe", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).toEqual(bad('Expected a boolean, got "maybe"'));
    expect(await read("/args/1", { method: "POST", headers: { "content-type": "application/json" }, body: '{"email":"a@b.co"}' })).toEqual({
      status: 400,
      body: { error: "Validation failed", issues: [{ path: "age", message: "Required" }] },
    });
  });
});

describe("transforms that throw something other than a 400", () => {
  it("a plain Error from a custom transform is a 500 with no detail leaked", async () => {
    expect(await read("/crash?v=1")).toEqual({ status: 500, body: "Internal Server Error" });
  });

  it("an HttpError keeps its own status", async () => {
    expect(await read("/crash?w=1")).toEqual({ status: 422, body: "custom status" });
  });

  it("neither runs when the value is missing", async () => {
    expect(await read("/crash")).toEqual({ status: 200, body: { v: null, w: null } });
  });
});
