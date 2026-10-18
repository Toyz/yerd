import { describe, expect, it } from "vitest";
import { YerdError, accepts, catches, get, guards, negotiate, noLayout, metadataOf, res, status } from "@toyz/yerd";
import { assertStatus } from "../../src/respond/response.js";
import { coerce } from "../../src/respond/coerce.js";
import { ACCEPTS } from "../../src/decorators/route.js";
import { expandType, isMediaType, type MediaType } from "../../src/respond/negotiate.js";
import { assertPublicInstance, isAsyncIterable, isDecoratorContext } from "../../src/decorators/util.js";

describe("media type shorthands", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("%s isn't a shorthand", (key) => {
    expect(isMediaType(key)).toBe(false);
    expect(() => negotiate({ [key]: () => "x" } as never)).toThrow(TypeError);
    expect(() => accepts(key as MediaType)).toThrow(TypeError);
    expect(expandType(key)).toBe(key.toLowerCase());
  });

  it("still takes real shorthands and type/subtype", () => {
    expect(isMediaType("json")).toBe(true);
    expect(isMediaType("application/vnd.api+json")).toBe(true);
    expect(isMediaType("jsno")).toBe(false);
    expect(expandType("json")).toBe("application/json");
  });
});

describe("@accepts and @noLayout", () => {
  it("refuse static methods", () => {
    expect(() => {
      class Bad {
        @accepts("json") static data() {}
      }
      return Bad;
    }).toThrow("@accepts must decorate a public instance method (got data)");
    expect(() => {
      class Bad {
        @noLayout static part() {}
      }
      return Bad;
    }).toThrow("@noLayout must decorate a public instance method (got part)");
  });

  it("keep a subclass's entries out of its parent", () => {
    class Base {
      @get @accepts("json") data() {}
      @get @noLayout part() {}
    }
    class Child extends Base {
      @get @accepts("csv") csv() {}
      @get @noLayout other() {}
    }
    expect([...ACCEPTS.entries(Base).keys()]).toEqual(["data"]);
    expect([...ACCEPTS.entries(Child).keys()]).toEqual(["data", "csv"]);
    expect([...noLayout.members(metadataOf(Base))]).toEqual(["part"]);
    expect([...noLayout.members(metadataOf(Child))]).toEqual(["part", "other"]);
  });
});

describe("assertPublicInstance", () => {
  const context = (over: object) => ({ kind: "method", name: "m", static: false, private: false, ...over });

  it("names the decorator, the member kind and the member", () => {
    expect(() => assertPublicInstance(context({ static: true }), "@x")).toThrow("@x must decorate a public instance method (got m)");
    expect(() => assertPublicInstance(context({ kind: "accessor", private: true, name: "#a" }), "@y")).toThrow(
      "@y must decorate a public instance accessor (got #a)",
    );
    expect(() => assertPublicInstance(context({}), "@x")).not.toThrow();
  });

  it("refuses symbol names when asked to", () => {
    const sym = Symbol("s");
    expect(() => assertPublicInstance(context({ name: sym }), "@x")).not.toThrow();
    expect(() => assertPublicInstance(context({ name: sym }), "@x", { stringNamed: true })).toThrow(
      "@x must decorate a public, string-named instance method (got Symbol(s))",
    );
  });

  it("is what guards and @catches use", () => {
    expect(() => {
      class Bad {
        @guards("auth") static s() {}
      }
      return Bad;
    }).toThrow("@guards must decorate a public instance method (got s)");
    expect(() => {
      class Bad {
        @catches() static s() {}
      }
      return Bad;
    }).toThrow("@catches must decorate a public instance method (got s)");
  });
});

describe("isDecoratorContext", () => {
  it("matches a context, optionally of one kind", () => {
    const ctx = { kind: "method", name: "m", metadata: {} };
    expect(isDecoratorContext(ctx)).toBe(true);
    expect(isDecoratorContext(ctx, "method")).toBe(true);
    expect(isDecoratorContext(ctx, "class")).toBe(false);
    expect(isDecoratorContext({ kind: "method" })).toBe(false);
    expect(isDecoratorContext({ heartbeat: 5 }, "method")).toBe(false);
    expect(isDecoratorContext(null)).toBe(false);
  });
});

describe("isAsyncIterable", () => {
  it("tells async iterables from everything else", () => {
    expect(isAsyncIterable((async function* () {})())).toBe(true);
    expect(isAsyncIterable([1])).toBe(false);
    expect(isAsyncIterable(async function* () {})).toBe(false);
    expect(isAsyncIterable(null)).toBe(false);
  });
});

describe("assertStatus", () => {
  it("is the one status check, naming its caller", async () => {
    expect(() => assertStatus(199, "here")).toThrow("here: 199 isn't a response status code (200-599)");
    expect(() => assertStatus(200.5, "here")).toThrow(TypeError);
    expect(() => assertStatus(599, "here")).not.toThrow();
    expect(() => res(null, { status: 600 })).toThrow("res(): 600 isn't a response status code (200-599)");
    expect(() => new YerdError(102)).toThrow("new YerdError(): 102 isn't a response status code (200-599)");
    expect(() => status(1000)).toThrow("@status: 1000 isn't a response status code (200-599)");
    expect(() => coerce(42, { layouts: [] })).toThrow("A handler's returned status: 42 isn't a response status code (200-599)");
  });
});
