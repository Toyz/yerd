import { describe, expect, it } from "vitest";
import { accepts, catches, get, guards, negotiate, noLayout, metadataOf } from "@toyz/yerd";
import { ACCEPTS, NO_LAYOUT } from "../../src/decorators/route.js";
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
    expect([...ACCEPTS.from(metadataOf(Base))!.keys()]).toEqual(["data"]);
    expect([...ACCEPTS.from(metadataOf(Child))!.keys()]).toEqual(["data", "csv"]);
    expect([...NO_LAYOUT.from(metadataOf(Base))!]).toEqual(["part"]);
    expect([...NO_LAYOUT.from(metadataOf(Child))!]).toEqual(["part", "other"]);
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
