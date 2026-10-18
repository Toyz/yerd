import { describe, expect, it } from "vitest";
import { HttpError, between, dto, is, length, lower, matches, parse, trim, type Issue } from "@toyz/yerd";

/** The issues parse() reports, or [] when it succeeds. */
function issuesOf<T>(cls: new () => T, raw: unknown): Issue[] {
  try {
    parse(cls, raw);
    return [];
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    expect(error.status).toBe(400);
    expect(error.message).toBe("Validation failed");
    return (error.details as { issues: Issue[] }).issues;
  }
}

/** The parsed value of a single field `v`, or the first issue's message. */
function one<T>(cls: new () => { v?: T }, value: unknown): { ok: T } | { error: string } {
  try {
    return { ok: parse(cls, { v: value }).v as T };
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return { error: (error.details as { issues: Issue[] }).issues[0]!.message };
  }
}

class Str { @is.string() v!: string; }
class Int { @is.int() v!: number; }
class Num { @is.number() v!: number; }
class Bool { @is.boolean() v!: boolean; }
class Choice { @is.oneOf(["a", "b", "toString"]) v!: "a" | "b" | "toString"; }
class Uuid { @is.uuid() v!: string; }
class Uuid4 { @is.uuid({ version: 4 }) v!: string; }
class Email { @is.email() v!: string; }
class Url { @is.url() v!: string; }
class FtpUrl { @is.url({ protocols: ["ftp:", "HTTPS"] }) v!: string; }
class When { @is.date() v!: Date; }

describe("is.string", () => {
  it.each([
    ["hello", { ok: "hello" }],
    ["", { ok: "" }],
    ["  padded  ", { ok: "  padded  " }],
    [42, { error: "Expected a string" }],
    [true, { error: "Expected a string" }],
    [null, { error: "Expected a string" }],
    [["a"], { error: "Expected a string" }],
    [{ toString: "x" }, { error: "Expected a string" }],
  ])("%j -> %j", (value, expected) => {
    expect(one(Str, value)).toEqual(expected);
  });
});

describe("is.int", () => {
  it.each([
    [0, { ok: 0 }],
    [42, { ok: 42 }],
    [-7, { ok: -7 }],
    [1.0, { ok: 1 }],
    [Number.MAX_SAFE_INTEGER, { ok: Number.MAX_SAFE_INTEGER }],
    [Number.MIN_SAFE_INTEGER, { ok: Number.MIN_SAFE_INTEGER }],
    ["42", { ok: 42 }],
    ["-42", { ok: -42 }],
    ["007", { ok: 7 }],
    ["9007199254740991", { ok: 9007199254740991 }],
    [1.5, { error: "Expected an integer" }],
    [NaN, { error: "Expected an integer" }],
    [Infinity, { error: "Expected an integer" }],
    [-Infinity, { error: "Expected an integer" }],
    [Number.MAX_SAFE_INTEGER + 1, { error: "Expected an integer" }],
    [1e21, { error: "Expected an integer" }],
    ["9007199254740992", { error: "Expected an integer" }],
    ["99999999999999999999999", { error: "Expected an integer" }],
    ["1.5", { error: "Expected an integer" }],
    ["1e3", { error: "Expected an integer" }],
    [" 42 ", { ok: 42 }],
    ["+1", { error: "Expected an integer" }],
    ["0x10", { error: "Expected an integer" }],
    ["", { error: "Expected an integer" }],
    ["-", { error: "Expected an integer" }],
    ["١٢", { error: "Expected an integer" }],
    [null, { error: "Expected an integer" }],
    [true, { error: "Expected an integer" }],
    [[1], { error: "Expected an integer" }],
    [{}, { error: "Expected an integer" }],
  ])("%j -> %j", (value, expected) => {
    expect(one(Int, value)).toEqual(expected);
  });

  it("keeps -0 as a number (JSON renders it 0)", () => {
    expect(Object.is(parse(Int, { v: -0 }).v, -0)).toBe(true);
    expect(JSON.stringify(parse(Int, { v: "-0" }))).toBe('{"v":0}');
  });
});

describe("is.number", () => {
  it.each([
    [0, { ok: 0 }],
    [1.5, { ok: 1.5 }],
    [-1e-7, { ok: -1e-7 }],
    [Number.MAX_VALUE, { ok: Number.MAX_VALUE }],
    ["1.5", { ok: 1.5 }],
    ["-.5", { ok: -0.5 }],
    ["1.", { ok: 1 }],
    ["1e3", { ok: 1000 }],
    ["1E-3", { ok: 0.001 }],
    [" 42 ", { ok: 42 }],
    ["\t7\n", { ok: 7 }],
    [NaN, { error: "Expected a number" }],
    [Infinity, { error: "Expected a number" }],
    [-Infinity, { error: "Expected a number" }],
    ["Infinity", { error: "Expected a number" }],
    ["NaN", { error: "Expected a number" }],
    ["0x10", { error: "Expected a number" }],
    ["0b11", { error: "Expected a number" }],
    ["1_000", { error: "Expected a number" }],
    ["+1", { error: "Expected a number" }],
    [".", { error: "Expected a number" }],
    ["", { error: "Expected a number" }],
    ["   ", { error: "Expected a number" }],
    ["1e", { error: "Expected a number" }],
    ["1,5", { error: "Expected a number" }],
    [null, { error: "Expected a number" }],
    [false, { error: "Expected a number" }],
    [[1], { error: "Expected a number" }],
  ])("%j -> %j", (value, expected) => {
    expect(one(Num, value)).toEqual(expected);
  });

  // Regression: the string path skipped the finite check the number path had,
  // so "1e400" came through as Infinity.
  it.each(["1e400", "-1e400", "1" + "0".repeat(400)])("rejects %s, which overflows to Infinity", (value) => {
    expect(one(Num, value)).toEqual({ error: "Expected a number" });
  });
});

describe("is.boolean", () => {
  it.each([
    [true, { ok: true }],
    [false, { ok: false }],
    ["true", { ok: true }],
    ["1", { ok: true }],
    ["on", { ok: true }],
    ["false", { ok: false }],
    ["0", { ok: false }],
    ["off", { ok: false }],
    ["TRUE", { error: "Expected a boolean" }],
    ["yes", { error: "Expected a boolean" }],
    [" true", { error: "Expected a boolean" }],
    ["", { error: "Expected a boolean" }],
    [1, { error: "Expected a boolean" }],
    [0, { error: "Expected a boolean" }],
    [null, { error: "Expected a boolean" }],
    [["true"], { error: "Expected a boolean" }],
  ])("%j -> %j", (value, expected) => {
    expect(one(Bool, value)).toEqual(expected);
  });
});

describe("is.oneOf", () => {
  it.each([
    ["a", { ok: "a" }],
    ["toString", { ok: "toString" }],
    ["A", { error: "Expected one of a, b, toString" }],
    [" a", { error: "Expected one of a, b, toString" }],
    ["constructor", { error: "Expected one of a, b, toString" }],
    ["__proto__", { error: "Expected one of a, b, toString" }],
    ["", { error: "Expected one of a, b, toString" }],
    [["a"], { error: "Expected one of a, b, toString" }],
    [null, { error: "Expected one of a, b, toString" }],
  ])("%j -> %j", (value, expected) => {
    expect(one(Choice, value)).toEqual(expected);
  });
});

describe("is.uuid", () => {
  const v4 = "3f2b8c1e-9a7d-4e6f-8b5c-1d2e3f4a5b6c";
  const v7 = "01890a5d-ac96-774b-bcce-b302099a8057";
  it.each([
    [v4, { ok: v4 }],
    [v4.toUpperCase(), { ok: v4 }],
    [`  ${v4}  `, { ok: v4 }],
    [v4.replaceAll("-", ""), { error: "Expected a UUID" }],
    [`{${v4}}`, { error: "Expected a UUID" }],
    [v4.slice(0, -1), { error: "Expected a UUID" }],
    [v4.replace("3", "g"), { error: "Expected a UUID" }],
    ["", { error: "Expected a UUID" }],
    [42, { error: "Expected a UUID" }],
  ])("%j -> %j", (value, expected) => {
    expect(one(Uuid, value)).toEqual(expected);
  });

  it("checks the version when asked", () => {
    expect(one(Uuid4, v4)).toEqual({ ok: v4 });
    expect(one(Uuid4, v7)).toEqual({ error: "Expected a version 4 UUID" });
  });
});

describe("is.email", () => {
  it.each([
    ["ada@example.com", { ok: "ada@example.com" }],
    ["  ada@example.com\n", { ok: "ada@example.com" }],
    ["Ada+tag@Sub.Example.co.uk", { ok: "Ada+tag@Sub.Example.co.uk" }],
    ["ada@localhost", { error: "Expected an email address" }],
    ["ada@@example.com", { error: "Expected an email address" }],
    ["ada example@example.com", { error: "Expected an email address" }],
    ["@example.com", { error: "Expected an email address" }],
    ["", { error: "Expected an email address" }],
    [`${"a".repeat(250)}@b.co`, { error: "Expected an email address" }],
    [null, { error: "Expected an email address" }],
  ])("%j -> %j", (value, expected) => {
    expect(one(Email, value)).toEqual(expected);
  });
});

describe("is.url", () => {
  it.each([
    ["https://example.com", { ok: "https://example.com/" }],
    ["  HTTP://EXAMPLE.com/a/../b  ", { ok: "http://example.com/b" }],
    ["https://user:pw@example.com:8443/x?y#z", { ok: "https://user:pw@example.com:8443/x?y#z" }],
    ["javascript:alert(1)", { error: "Expected a http or https URL" }],
    ["JaVaScRiPt:alert(1)", { error: "Expected a http or https URL" }],
    ["data:text/html,<script>", { error: "Expected a http or https URL" }],
    ["file:///etc/passwd", { error: "Expected a http or https URL" }],
    ["//example.com", { error: "Expected a http or https URL" }],
    ["/relative", { error: "Expected a http or https URL" }],
    ["", { error: "Expected a http or https URL" }],
    [42, { error: "Expected a http or https URL" }],
  ])("%j -> %j", (value, expected) => {
    expect(one(Url, value)).toEqual(expected);
  });

  it("normalizes the protocols option (trailing colon, case)", () => {
    expect(one(FtpUrl, "ftp://files.example.com/a")).toEqual({ ok: "ftp://files.example.com/a" });
    expect(one(FtpUrl, "https://example.com")).toEqual({ ok: "https://example.com/" });
    expect(one(FtpUrl, "http://example.com")).toEqual({ error: "Expected a ftp or https URL" });
  });
});

describe("is.date", () => {
  it.each([
    ["2026-10-17", "2026-10-17T00:00:00.000Z"],
    ["2024-02-29", "2024-02-29T00:00:00.000Z"],
    ["2026-10-17T09:30:00Z", "2026-10-17T09:30:00.000Z"],
    ["2026-10-17T09:30Z", "2026-10-17T09:30:00.000Z"],
    ["2026-10-17T09:30:00.123456789Z", "2026-10-17T09:30:00.123Z"],
    ["2026-10-17T09:30:00+02:00", "2026-10-17T07:30:00.000Z"],
    ["2026-02-28T23:00:00-05:00", "2026-03-01T04:00:00.000Z"],
    ["  2026-10-17  ", "2026-10-17T00:00:00.000Z"],
    // Regression: Date.UTC maps years 0-99 to 1900-1999, so these real dates were rejected.
    ["0099-12-31", "0099-12-31T00:00:00.000Z"],
    ["0001-01-01", "0001-01-01T00:00:00.000Z"],
  ])("accepts %s", (value, iso) => {
    const result = one(When, value);
    expect("ok" in result && (result.ok as Date).toISOString()).toBe(iso);
  });

  it.each([
    "2026-02-29",
    "2026-02-30",
    "2026-13-01",
    "2026-00-10",
    "2026-04-31",
    "2026-02-30T10:00:00Z",
    "2026-10-17T25:00:00Z",
    "2026-10-17T09:60:00Z",
    "26-10-17",
    "2026/10/17",
    "17-10-2026",
    "2026-10-17 09:30",
    "Sat Oct 17 2026",
    "1792000000000",
    "",
  ])("rejects %j", (value) => {
    expect(one(When, value)).toEqual({ error: "Expected an ISO 8601 date" });
  });

  it("takes a valid Date as is, rejects an invalid one and numbers", () => {
    const d = new Date("2026-10-17T00:00:00Z");
    expect(parse(When, { v: d }).v).toBe(d);
    expect(one(When, new Date(NaN))).toEqual({ error: "Expected an ISO 8601 date" });
    expect(one(When, 1792000000000)).toEqual({ error: "Expected an ISO 8601 date" });
  });
});

describe("is.custom", () => {
  class Hex {
    @is.custom((v) => {
      if (typeof v !== "string" || !/^[0-9a-f]+$/.test(v)) throw new Error("Expected hex");
      return parseInt(v, 16);
    })
    v!: number;
  }
  class Throws {
    @is.custom((): string => {
      throw "a bare string";
    })
    v!: string;
  }
  class Undef {
    @is.custom((): string | undefined => undefined) v?: string;
  }

  it("returns what the function returns, or its error message", () => {
    expect(one(Hex, "ff")).toEqual({ ok: 255 });
    expect(one(Hex, "zz")).toEqual({ error: "Expected hex" });
    expect(one(Hex, null)).toEqual({ error: "Expected hex" });
  });

  it("turns a non-Error throw into a message", () => {
    expect(one(Throws, 1)).toEqual({ error: "a bare string" });
  });

  it("is not called for a missing value", () => {
    let calls = 0;
    class Counted {
      @is.custom((v) => {
        calls++;
        return String(v);
      }, { optional: true })
      v?: string;
    }
    parse(Counted, {});
    expect(calls).toBe(0);
  });

  it("may return undefined", () => {
    const out = parse(Undef, { v: 1 });
    expect(out.v).toBeUndefined();
  });
});

describe("optional fields and defaults (PATCH semantics)", () => {
  class Changes {
    @is.string({ optional: true }) title?: string;
    @is.boolean({ optional: true }) done?: boolean;
    @is.int() priority = 3;
  }

  it("leaves a missing optional field off the instance entirely", () => {
    const out = parse(Changes, {});
    expect(Object.keys(out)).toEqual(["priority"]);
    expect("title" in out).toBe(false);
    expect({ ...out }).toEqual({ priority: 3 });
  });

  it("treats an explicit undefined like a missing key", () => {
    const out = parse(Changes, { title: undefined, priority: undefined });
    expect("title" in out).toBe(false);
    expect(out.priority).toBe(3);
  });

  it("rejects null for an optional field (null isn't missing)", () => {
    expect(issuesOf(Changes, { title: null })).toEqual([{ path: "title", message: "Expected a string" }]);
  });

  it("rejects null for a defaulted field rather than falling back to the default", () => {
    expect(issuesOf(Changes, { priority: null })).toEqual([{ path: "priority", message: "Expected an integer" }]);
  });

  it("validates a sent value even when the field has a default", () => {
    expect(issuesOf(Changes, { priority: "high" })).toEqual([{ path: "priority", message: "Expected an integer" }]);
    expect(parse(Changes, { priority: "7" }).priority).toBe(7);
  });

  it("merging a partial update keeps unsent fields", () => {
    const todo = { title: "milk", done: false, priority: 1 };
    const { priority: _drop, ...changes } = parse(Changes, { done: true });
    Object.assign(todo, changes);
    expect(todo).toEqual({ title: "milk", done: true, priority: 1 });
  });

  it("does not run the default's validators (initializers are trusted)", () => {
    class Weird {
      @is.int({ validate: between(10, 20) }) n = 1;
    }
    expect(parse(Weird, {}).n).toBe(1);
  });

  it("reports Required for every missing required field, in declaration order", () => {
    class Three {
      @is.string() a!: string;
      @is.int() b!: number;
      @is.boolean() c!: boolean;
    }
    expect(issuesOf(Three, {})).toEqual([
      { path: "a", message: "Required" },
      { path: "b", message: "Required" },
      { path: "c", message: "Required" },
    ]);
  });
});

describe("the root value", () => {
  it.each([
    [null],
    [undefined],
    ["string"],
    [42],
    [[]],
    [[{ v: "x" }]],
    [new Uint8Array(2)],
    [new Date()],
    [new Map()],
    [Object.create({ v: "inherited" })],
  ])("rejects %j with a (root) issue", (raw) => {
    expect(issuesOf(Str, raw)).toEqual([{ path: "(root)", message: "Expected an object" }]);
  });

  it("accepts a null-prototype object (parsed forms are)", () => {
    const raw = Object.assign(Object.create(null), { v: "x" });
    expect(parse(Str, raw).v).toBe("x");
  });

  it("a null-prototype object missing the key is Required", () => {
    expect(issuesOf(Str, Object.create(null))).toEqual([{ path: "v", message: "Required" }]);
  });

  it("throws a TypeError (a programming error, not a 400) for a class with no is.* fields", () => {
    class Empty {
      x = 1;
    }
    expect(() => parse(Empty, {})).toThrow(TypeError);
  });
});

describe("unknown keys and prototype pollution", () => {
  class User {
    @is.string() name!: string;
    isAdmin = false;
  }

  it("drops keys the class doesn't declare, even ones matching a plain field", () => {
    const out = parse(User, { name: "ada", isAdmin: true, extra: 1 });
    expect(out.isAdmin).toBe(false);
    expect("extra" in out).toBe(false);
    expect(out).toBeInstanceOf(User);
  });

  it.each([
    ['{"name":"ada","__proto__":{"polluted":true}}'],
    ['{"name":"ada","constructor":{"prototype":{"polluted":true}}}'],
    ['{"name":"ada","__proto__":{"isAdmin":true}}'],
  ])("JSON %s pollutes nothing", (text) => {
    const out = parse(User, JSON.parse(text));
    expect(out.isAdmin).toBe(false);
    expect(Object.getPrototypeOf(out)).toBe(User.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((out as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("nested DTOs don't adopt an attacker's prototype either", () => {
    class Inner {
      @is.string() city!: string;
    }
    class Outer {
      @is.object(Inner) address!: Inner;
    }
    const out = parse(Outer, JSON.parse('{"address":{"city":"x","__proto__":{"admin":true}}}'));
    expect(out.address).toBeInstanceOf(Inner);
    expect((out.address as unknown as Record<string, unknown>).admin).toBeUndefined();
  });

  it("a field named like an Object.prototype member is read only from own keys", () => {
    class Tricky {
      @is.string({ optional: true }) toString?: string;
      @is.string({ optional: true }) hasOwnProperty?: string;
    }
    const out = parse(Tricky, {});
    expect(Object.hasOwn(out, "toString")).toBe(false);
    expect(parse(Tricky, { toString: "x" }).toString).toBe("x");
  });

  it("an array of objects with __proto__ keys stays plain data", () => {
    class Tag {
      @is.string() name!: string;
    }
    class Tags {
      @is.array(is.object(Tag)) tags!: Tag[];
    }
    const out = parse(Tags, JSON.parse('{"tags":[{"name":"a","__proto__":{"x":1}}]}'));
    expect(out.tags[0]).toBeInstanceOf(Tag);
    expect((out.tags[0] as unknown as Record<string, unknown>).x).toBeUndefined();
  });
});

describe("nested objects and arrays", () => {
  class Address {
    @is.string({ transform: trim, validate: length(1) }) city!: string;
    @is.string({ optional: true }) zip?: string;
  }
  class Line {
    @is.string() sku!: string;
    @is.int({ validate: between(1, 99) }) qty!: number;
  }
  class Order {
    @is.object(Address) ship!: Address;
    @is.array(is.object(Line), { min: 1, max: 3 }) lines!: Line[];
    @is.array(is.array(is.int()), { optional: true }) grid?: number[][];
  }

  it("parses into instances all the way down", () => {
    const out = parse(Order, { ship: { city: " Paris " }, lines: [{ sku: "a", qty: "2" }], grid: [[1, "2"], [3]] });
    expect(out.ship).toBeInstanceOf(Address);
    expect(out.ship.city).toBe("Paris");
    expect(out.lines[0]).toBeInstanceOf(Line);
    expect(out.lines[0]!.qty).toBe(2);
    expect(out.grid).toEqual([[1, 2], [3]]);
  });

  it("reports nested issue paths and aggregates them all", () => {
    expect(
      issuesOf(Order, {
        ship: { city: "  " },
        lines: [{ sku: "a", qty: 0 }, { qty: 2 }, { sku: 3, qty: "x" }],
        grid: [[1], ["a", 2, 1.5]],
      }),
    ).toEqual([
      { path: "ship.city", message: "Can't be empty" },
      { path: "lines[0].qty", message: "Must be from 1 to 99 (got 0)" },
      { path: "lines[1].sku", message: "Required" },
      { path: "lines[2].sku", message: "Expected a string" },
      { path: "lines[2].qty", message: "Expected an integer" },
      { path: "grid[1][0]", message: "Expected an integer" },
      { path: "grid[1][2]", message: "Expected an integer" },
    ]);
  });

  it("reports a nested non-object at its own path", () => {
    expect(issuesOf(Order, { ship: "Paris", lines: ["x"] })).toEqual([
      { path: "ship", message: "Expected an object" },
      { path: "lines[0]", message: "Expected an object" },
    ]);
  });

  it("checks min and max before the items", () => {
    expect(issuesOf(Order, { ship: { city: "x" }, lines: [] })).toEqual([{ path: "lines", message: "Expected at least 1 items" }]);
    const four = Array.from({ length: 4 }, () => ({ sku: 1 }));
    expect(issuesOf(Order, { ship: { city: "x" }, lines: four })).toEqual([{ path: "lines", message: "Expected at most 3 items" }]);
  });

  it("treats a lone value as a one-item array (a form field sent once)", () => {
    class Tags {
      @is.array(is.string()) tags!: string[];
    }
    expect(parse(Tags, { tags: "a" }).tags).toEqual(["a"]);
    expect(parse(Tags, { tags: [] }).tags).toEqual([]);
    expect(issuesOf(Tags, { tags: null })).toEqual([{ path: "tags[0]", message: "Expected a string" }]);
    expect(issuesOf(Tags, { tags: { 0: "a" } })).toEqual([{ path: "tags[0]", message: "Expected a string" }]);
  });

  it("runs the array's own transform and validate on the parsed list", () => {
    class Tags {
      @is.array(is.string({ transform: [trim, lower] }), { transform: (t: string[]) => [...new Set(t)], validate: (t: string[]) => t.length <= 2 || "Too many distinct tags" })
      tags!: string[];
    }
    expect(parse(Tags, { tags: [" A", "a ", "b"] }).tags).toEqual(["a", "b"]);
    expect(issuesOf(Tags, { tags: ["a", "b", "c"] })).toEqual([{ path: "tags", message: "Too many distinct tags" }]);
  });

  it("an array of scalars expected but objects given, and vice versa", () => {
    class Mixed {
      @is.string() name!: string;
      @is.array(is.int()) ids!: number[];
    }
    expect(issuesOf(Mixed, { name: ["a"], ids: [{ id: 1 }] })).toEqual([
      { path: "name", message: "Expected a string" },
      { path: "ids[0]", message: "Expected an integer" },
    ]);
  });
});

describe("inheritance", () => {
  class Base {
    @is.string() name!: string;
    @is.int({ optional: true }) age?: number;
  }
  class Child extends Base {
    @is.string() role!: string;
    // Redeclared: now defaulted, with a range.
    @is.int({ validate: between(18, 99) }) override age: number = 18;
  }

  it("subclasses inherit fields and add their own", () => {
    const out = parse(Child, { name: "ada", role: "admin", age: 30 });
    expect(out).toBeInstanceOf(Child);
    expect({ ...out }).toEqual({ name: "ada", role: "admin", age: 30 });
  });

  it("a redeclared field uses the subclass's spec only, once", () => {
    expect(parse(Child, { name: "ada", role: "x" }).age).toBe(18);
    expect(issuesOf(Child, { name: "ada", role: "x", age: 5 })).toEqual([{ path: "age", message: "Must be from 18 to 99 (got 5)" }]);
  });

  it("the parent is unaffected by the subclass", () => {
    expect({ ...parse(Base, { name: "ada", role: "dropped" }) }).toEqual({ name: "ada" });
    expect(parse(Base, { name: "ada", age: 5 }).age).toBe(5);
  });

  it("siblings don't see each other's fields", () => {
    class A extends Base {
      @is.string() a!: string;
    }
    class B extends Base {
      @is.string() b!: string;
    }
    expect(issuesOf(A, { name: "x" })).toEqual([{ path: "a", message: "Required" }]);
    expect(issuesOf(B, { name: "x" })).toEqual([{ path: "b", message: "Required" }]);
  });
});

describe("transform pipelines", () => {
  it("can change the type, step by step", () => {
    class Cents {
      @is.string({ transform: [trim, (s: string) => Number(s), (n: number) => Math.round(n * 100)] }) v!: number;
    }
    expect(parse(Cents, { v: " 12.345 " }).v).toBe(1235);
  });

  it("a throwing step becomes an issue with its message; later steps don't run", () => {
    let later = 0;
    class Steps {
      @is.string({
        transform: [
          (s: string) => {
            if (s === "bad") throw new Error("Step one refused");
            return s;
          },
          (s: string) => {
            later++;
            return s;
          },
        ],
      })
      v!: string;
    }
    expect(one(Steps, "bad")).toEqual({ error: "Step one refused" });
    expect(later).toBe(0);
  });

  it("an HttpError thrown in a step is still collected as an issue (400), not its own status", () => {
    class Steps {
      @is.string({
        transform: () => {
          throw new HttpError(418, "teapot");
        },
      })
      v!: string;
    }
    expect(issuesOf(Steps, { v: "x" })).toEqual([{ path: "v", message: "teapot" }]);
  });

  it("validate sees the transformed value; false is a generic message, a string is used verbatim", () => {
    class V {
      @is.string({ transform: lower, validate: [(s: string) => s !== "admin", matches(/^[a-z]+$/, "letters only")] }) v!: string;
    }
    expect(one(V, "ADMIN")).toEqual({ error: "Invalid value" });
    expect(one(V, "ab1")).toEqual({ error: "letters only" });
    expect(one(V, "Ada")).toEqual({ ok: "ada" });
  });

  it("validators stop at the first failure; void counts as a pass", () => {
    let second = 0;
    class V {
      @is.int({ validate: [() => undefined, (n: number) => n > 0 || "positive", () => void second++] }) v!: number;
    }
    expect(one(V, -1)).toEqual({ error: "positive" });
    expect(second).toBe(0);
    expect(one(V, 1)).toEqual({ ok: 1 });
    expect(second).toBe(1);
  });

  it("a throwing validator becomes an issue", () => {
    class V {
      @is.string({
        validate: () => {
          throw new TypeError("boom");
        },
      })
      v!: string;
    }
    expect(one(V, "x")).toEqual({ error: "boom" });
  });

  it("type check failures skip the pipeline", () => {
    let ran = 0;
    class V {
      @is.int({ transform: (n: number) => (ran++, n) }) v!: number;
    }
    expect(one(V, "x")).toEqual({ error: "Expected an integer" });
    expect(ran).toBe(0);
  });

  it("dto() works as a transform and nests its own issues under the message", () => {
    class Inner {
      @is.int() n!: number;
    }
    class Outer {
      @is.custom(dto(Inner)) inner!: Inner;
    }
    expect(parse(Outer, { inner: { n: "4" } }).inner).toBeInstanceOf(Inner);
    expect(issuesOf(Outer, { inner: { n: "x" } })).toEqual([{ path: "inner", message: "Validation failed" }]);
  });
});

describe("is.file / is.files", () => {
  const png = (name = "a.png", size = 3) => new File([new Uint8Array(size)], name, { type: "image/png" });
  const txt = new File(["hi"], "a.txt", { type: "text/plain" });
  const untyped = new File(["hi"], "blob");
  class One {
    @is.file({ types: ["image/*"], maxSize: 4 }) v!: File;
  }
  class Many {
    @is.files({ types: ["image/png"], min: 1, max: 2 }) v!: File[];
  }

  it.each([
    [png(), "ok"],
    [png("a.png", 5), "File is larger than 4 bytes"],
    [txt, "File type text/plain isn't accepted (image/*)"],
    [untyped, "File type (unknown) isn't accepted (image/*)"],
    [[png(), png()], "Expected one file"],
    ["a.png", "Expected a file"],
    [{ name: "a.png", size: 1, type: "image/png" }, "Expected a file"],
    [new Blob(["x"], { type: "image/png" }), "Expected a file"],
  ])("is.file %#", (value, expected) => {
    const result = one(One, value);
    expect("ok" in result ? "ok" : result.error).toBe(expected);
  });

  it("is.files takes one file as a list of one, and checks each with an indexed path", () => {
    expect(parse(Many, { v: png() }).v).toHaveLength(1);
    expect(issuesOf(Many, { v: [png(), txt] })).toEqual([{ path: "v[1]", message: "File type text/plain isn't accepted (image/png)" }]);
    expect(issuesOf(Many, { v: [png(), png(), png()] })).toEqual([{ path: "v", message: "Expected at most 2 files" }]);
    expect(issuesOf(Many, { v: [] })).toEqual([{ path: "v", message: "Expected at least 1 files" }]);
    expect(issuesOf(Many, { v: [png(), "x"] })).toEqual([{ path: "v", message: "Expected files" }]);
  });

  it("an image/* wildcard does not match a type that merely starts with image", () => {
    class Img {
      @is.file({ types: ["image/*"] }) v!: File;
    }
    const sneaky = new File(["x"], "x", { type: "imagex/png" });
    expect(one(Img, sneaky)).toEqual({ error: "File type imagex/png isn't accepted (image/*)" });
  });
});

describe("the 400 shape", () => {
  it("is an exposed HttpError with details.issues only", () => {
    try {
      parse(Int, { v: "x" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      const e = error as HttpError;
      expect(e.status).toBe(400);
      expect(e.expose).toBe(true);
      expect(e.details).toEqual({ issues: [{ path: "v", message: "Expected an integer" }] });
    }
  });
});
