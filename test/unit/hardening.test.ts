import { describe, expect, it } from "vitest";
import { ActionForm, createGuard, guards, is, parse } from "@toyz/yerd";
import { CLASS_GUARDS, METHOD_GUARDS, type GuardRef, type GuardSpec } from "../../src/decorators/guards.js";
import { safeBack } from "../../src/actions/action.js";

const g = (label: string) => createGuard(label, () => true);
const labels = (specs: readonly GuardSpec[] | undefined) => (specs ?? []).map((s) => (typeof s === "string" ? s : (s as GuardRef).label));
const meta = (cls: Function) => (cls as unknown as Record<symbol, DecoratorMetadataObject>)[Symbol.metadata!]!;

describe("stacked guards", () => {
  it("run top to bottom on classes and methods, keeping guards(...) lists in order", () => {
    @g("c1")
    @guards("c2", g("c3"))
    @g("c4")
    class Page {
      @g("m1")
      @guards(g("m2"), "m3")
      @g("m4")
      show() {}
    }
    expect(labels(CLASS_GUARDS.from(meta(Page)))).toEqual(["c1", "c2", "c3", "c4"]);
    expect(labels(METHOD_GUARDS.from(meta(Page))?.get("show"))).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("put a subclass's guards after the ones it inherits", () => {
    @g("p1")
    @g("p2")
    class Base {
      @g("pm") show() {}
    }
    @g("s1")
    @g("s2")
    class Sub extends Base {
      @g("sm1")
      @g("sm2")
      override show() {}
    }
    expect(labels(CLASS_GUARDS.from(meta(Sub)))).toEqual(["p1", "p2", "s1", "s2"]);
    expect(labels(METHOD_GUARDS.from(meta(Sub))?.get("show"))).toEqual(["pm", "sm1", "sm2"]);
    expect(labels(CLASS_GUARDS.from(meta(Base)))).toEqual(["p1", "p2"]);
  });
});

describe("safeBack", () => {
  it("follows only paths on this site", () => {
    expect(safeBack("/todos?x=1#a", "/")).toBe("/todos?x=1#a");
    expect(safeBack("/%2F%2Fevil.com", "/")).toBe("/%2F%2Fevil.com");
    for (const bad of ["/\t/evil.com", "/\n/evil.com", "/\\evil.com", "//evil.com", "https://evil.com", "javascript:alert(1)", "", undefined]) {
      expect(safeBack(bad, "/home")).toBe("/home");
    }
  });
});

describe("DTOs", () => {
  it("lets a subclass redeclare a field, replacing the parent's spec", () => {
    class Base {
      @is.string() code!: string | number;
    }
    class Sub extends Base {
      @is.int() override code: number = 0;
    }
    // Only the int spec applies (both used to, so a number failed as "not a string").
    expect(parse(Sub, { code: 42 })).toMatchObject({ code: 42 });
    expect(() => parse(Sub, { code: "abc" })).toThrow();
    // The parent keeps its own spec.
    expect(parse(Base, { code: "abc" })).toMatchObject({ code: "abc" });
  });
});

describe("ActionForm.parse", () => {
  it("treats a __proto__ field as plain data, not a prototype (which failed validation)", () => {
    class Dto {
      @is.string() name!: string;
    }
    const fields = JSON.parse('{"name":"ada","__proto__":{"polluted":"yes"}}') as Record<string, string>;
    const out = new ActionForm(fields).parse(Dto) as Dto & { polluted?: string };
    expect(out.name).toBe("ada");
    expect(out.polluted).toBeUndefined();
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
  });
});
