import { afterAll, describe, expect, it } from "vitest";
import {
  HttpError, args, body, field, file, is, ndjsonBody, parse, post, query, route, toBool, toInt, yerd,
} from "@toyz/yerd";
import { fileProblem, isSentFile, parseBool, parseInteger, parseNumber } from "../../src/decorators/parse.js";

class Terms {
  @is.boolean() agree = false;
}

@route("/terms")
class TermsForm {
  @field("agree", { transform: toBool }) accessor agree!: Promise<boolean | undefined>;
  @post async accept() {
    return { agree: await this.agree };
  }
}

@route("/fields")
class Fields {
  @field("a") accessor a!: Promise<string | undefined>;
  @field("b", { transform: toInt }) accessor b!: Promise<number | undefined>;
  @field("c") accessor c!: Promise<string | undefined>;
  @post async read() {
    return { a: await this.a, b: await this.b, c: await this.c };
  }
}

@route("/picky")
class Picky {
  @query("n", { transform: toInt, validate: (n: number) => n % 2 === 0 }) accessor n: number | undefined;
  @post read() {
    return { n: this.n };
  }
}

@route("/photo")
class Photo {
  @file("photo", { types: ["IMAGE/PNG"] }) accessor photo!: Promise<File | undefined>;
  @post async read() {
    return { name: (await this.photo)?.name ?? null };
  }
}

@route("/even-lines")
class EvenLines {
  @post
  @args(ndjsonBody({ transform: (v: unknown) => Number(v), validate: (n: number) => n % 2 === 0 || "Must be even" }))
  async read(rows: AsyncIterable<number>) {
    const out: number[] = [];
    for await (const row of rows) out.push(row);
    return out;
  }
}

@route("/int-lines")
class IntLines {
  @post
  @args(ndjsonBody({ transform: (v: unknown) => toInt(String(v)) }))
  async read(rows: AsyncIterable<number>) {
    const out: number[] = [];
    for await (const row of rows) out.push(row);
    return out;
  }
}

const app = yerd({ routes: [TermsForm, Fields, Picky, Photo, EvenLines, IntLines], services: [], handleSignals: false, csrf: false })
  .logging({ filter: "off" });
afterAll(() => app.stop());

async function send(path: string, init: { body: string | FormData; type?: string }) {
  const headers: Record<string, string> = init.type ? { "content-type": init.type } : {};
  const r = await app.request(path, { method: "POST", body: init.body, headers });
  const text = await r.text();
  return { status: r.status, body: r.headers.get("content-type")?.startsWith("application/json") ? JSON.parse(text) : text };
}

describe("booleans", () => {
  it("@field with toBool takes a ticked checkbox", async () => {
    expect(await send("/terms", { body: "agree=on", type: "application/x-www-form-urlencoded" })).toEqual({ status: 200, body: { agree: true } });
    expect(await send("/terms", { body: "other=1", type: "application/x-www-form-urlencoded" })).toEqual({ status: 200, body: {} });
  });

  it.each(["true", "1", "on", "", "false", "0", "off", "TRUE", "yes", "no", " true"])("toBool and is.boolean agree on %j", (word) => {
    const viaToBool = (() => {
      try {
        return toBool(word);
      } catch (error) {
        return error instanceof HttpError ? "rejected" : error;
      }
    })();
    const viaIs = (() => {
      try {
        return parse(Terms, { agree: word }).agree;
      } catch (error) {
        return error instanceof HttpError ? "rejected" : error;
      }
    })();
    expect(viaIs).toBe(viaToBool);
    expect(parseBool(word) ?? "rejected").toBe(viaToBool);
  });
});

describe("number parsers", () => {
  it.each([
    ["42", 42],
    [" -7 ", -7],
    ["1.5", undefined],
    ["", undefined],
    ["0x10", undefined],
  ])("parseInteger(%j)", (raw, expected) => {
    expect(parseInteger(raw)).toBe(expected);
  });

  it("leaves the safe-range check to the caller", () => {
    expect(Number.isSafeInteger(parseInteger("9007199254740993")!)).toBe(false);
  });

  it.each([
    ["3.5", 3.5],
    [" -.5 ", -0.5],
    ["1e3", 1000],
    ["1e400", undefined],
    ["Infinity", undefined],
    ["", undefined],
  ])("parseNumber(%j)", (raw, expected) => {
    expect(parseNumber(raw)).toBe(expected);
  });
});

describe("@field on a JSON body", () => {
  it("reads several fields of one body", async () => {
    expect(await send("/fields", { body: JSON.stringify({ a: "x", b: 2, c: true }), type: "application/json" })).toEqual({
      status: 200,
      body: { a: "x", b: 2, c: "true" },
    });
  });

  it("treats a text body as having no fields", async () => {
    expect(await send("/fields", { body: "a=x", type: "text/plain" })).toEqual({ status: 200, body: {} });
  });
});

describe("validators", () => {
  it("a bare false names the field", async () => {
    expect(await send("/picky?n=3", { body: "" })).toEqual({ status: 400, body: "Invalid query parameter: n" });
    expect(await send("/picky?n=4", { body: "" })).toEqual({ status: 200, body: { n: 4 } });
  });
});

describe("files", () => {
  const png = (name: string, size = 4, type = "image/png") => new File([new Uint8Array(size)], name, { type });

  it("match types case-insensitively", async () => {
    const fd = new FormData();
    fd.append("photo", png("a.png"));
    expect(await send("/photo", { body: fd })).toEqual({ status: 200, body: { name: "a.png" } });
    expect(fileProblem(png("a.png", 1, "Image/PNG"), { types: ["image/*"] })).toBeUndefined();
    expect(fileProblem(png("a.gif", 1, "image/gif"), { types: ["image/png"] })).toEqual({
      status: 415,
      message: "File type image/gif isn't accepted (image/png)",
    });
    expect(fileProblem(png("a.png", 9), { maxSize: 8 })).toEqual({ status: 413, message: "File is larger than 8 bytes" });
  });

  it("an empty file input isn't a file", () => {
    expect(isSentFile(new File([], ""))).toBe(false);
    expect(isSentFile(new File([], "empty.txt"))).toBe(true);
    expect(isSentFile(new File(["x"], ""))).toBe(true);
  });
});

describe("ndjsonBody with transform and validate", () => {
  it("validates each line", async () => {
    expect(await send("/even-lines", { body: "2\n4\n", type: "application/x-ndjson" })).toEqual({ status: 200, body: [2, 4] });
  });

  it("names the line a validator refused", async () => {
    expect(await send("/even-lines", { body: "2\n3\n", type: "application/x-ndjson" })).toEqual({
      status: 400,
      body: { error: "Line 2 failed validation", line: 2, issues: [{ path: "(root)", message: "Must be even" }] },
    });
  });

  it("names the line a transform refused", async () => {
    expect(await send("/int-lines", { body: "1\n1.5\n", type: "application/x-ndjson" })).toEqual({
      status: 400,
      body: { error: "Line 2 failed validation", line: 2, issues: [{ path: "(root)", message: 'Expected an integer, got "1.5"' }] },
    });
  });
});

describe("DTO classes without is.* fields", () => {
  class Empty {
    x = 1;
  }

  it("are refused where they're handed over, not on the first request", () => {
    expect(() => body(Empty)).toThrow("Empty has no is.* field decorators");
    expect(() => ndjsonBody(Empty)).toThrow(TypeError);
    expect(() => is.object(Empty)).toThrow(TypeError);
  });

  it("are a TypeError from parse() whatever the input", () => {
    expect(() => parse(Empty, "not an object")).toThrow(TypeError);
  });
});

describe("DTO issue paths", () => {
  class Leaf {
    @is.int() n!: number;
  }
  class Branch {
    @is.array(is.object(Leaf)) leaves!: Leaf[];
  }
  class Root {
    @is.object(Branch) branch!: Branch;
    @is.url() site!: string;
  }

  it("are joined only for the values that fail", () => {
    try {
      parse(Root, { branch: { leaves: [{ n: 1 }, { n: "x" }] }, site: "not a url" });
      expect.unreachable();
    } catch (error) {
      expect((error as HttpError).details!.issues).toEqual([
        { path: "branch.leaves[1].n", message: "Expected an integer" },
        { path: "site", message: "Expected a http or https URL" },
      ]);
    }
  });

  it("is.url normalizes what it accepts", () => {
    expect(parse(Root, { branch: { leaves: [] }, site: " HTTPS://Example.com " }).site).toBe("https://example.com/");
  });
});
