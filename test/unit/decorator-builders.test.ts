import { describe, expect, it } from "vitest";
import {
  classFlag, classList, classValue, createMethodDecorator, metadataOf, methodFlag, methodList, methodValue,
} from "@toyz/yerd";

/** Apply a decorator by hand to a fake context, for misuse a type checker would stop. */
const call = (decorator: unknown, ...args: unknown[]) => (decorator as (...a: unknown[]) => unknown)(...args);

describe("methodFlag", () => {
  it("flags methods and reads them by class or metadata", () => {
    const audit = methodFlag("audit");
    class Invoice {
      @audit refund() {}
      @audit void() {}
      show() {}
    }
    expect(audit.has(Invoice, "refund")).toBe(true);
    expect(audit.has(Invoice, "show")).toBe(false);
    expect(audit.has(metadataOf(Invoice), "void")).toBe(true);
    expect([...audit.members(Invoice)]).toEqual(["refund", "void"]);
  });

  it("is empty for a class it never touched", () => {
    const audit = methodFlag("audit");
    class Plain {}
    expect(audit.has(Plain, "x")).toBe(false);
    expect(audit.members(Plain).size).toBe(0);
  });

  it("lets a subclass add flags without changing its parent's", () => {
    const audit = methodFlag("audit");
    class Base {
      @audit a() {}
    }
    class Child extends Base {
      @audit b() {}
    }
    class Sibling extends Base {}
    expect([...audit.members(Base)]).toEqual(["a"]);
    expect([...audit.members(Child)]).toEqual(["a", "b"]);
    expect([...audit.members(Sibling)]).toEqual(["a"]);
  });

  it("refuses static, private and called use", () => {
    const audit = methodFlag("audit");
    expect(() => {
      class Bad {
        @audit static s() {}
      }
      return Bad;
    }).toThrow("@audit must decorate a public instance method (got s)");
    expect(() => {
      class Bad {
        @audit #p() {}
      }
      return Bad;
    }).toThrow("@audit must decorate a public instance method (got #p)");
    expect(() => call(audit)).toThrow("@audit takes no arguments: write @audit, not @audit()");
  });

  it("refuses anything but a method", () => {
    const audit = methodFlag("audit");
    expect(() => call(audit, undefined, { kind: "field", name: "f", static: false, private: false, metadata: {} })).toThrow(
      "@audit must decorate a method (got field f)",
    );
  });

  it("marks from inside another decorator", () => {
    const audit = methodFlag("audit");
    const sensitive = (_method: Function, context: ClassMethodDecoratorContext) => audit.mark(context);
    class Page {
      @sensitive delete() {}
    }
    expect(audit.has(Page, "delete")).toBe(true);
  });
});

describe("methodValue", () => {
  it("stores one value per method; the top one wins when stacked", () => {
    const rateLimit = methodValue<number>("rateLimit");
    class Search {
      @rateLimit(10) results() {}
      @rateLimit(1) @rateLimit(2) stacked() {}
    }
    expect(rateLimit.get(Search, "results")).toBe(10);
    expect(rateLimit.get(Search, "stacked")).toBe(1);
    expect(rateLimit.get(Search, "missing")).toBeUndefined();
    expect([...rateLimit.entries(metadataOf(Search))]).toEqual([["results", 10], ["stacked", 1]]);
  });

  it("lets a subclass override a value without changing its parent's", () => {
    const rateLimit = methodValue<number>("rateLimit");
    class Base {
      @rateLimit(10) a() {}
      @rateLimit(20) b() {}
    }
    class Child extends Base {
      @rateLimit(5) override a() {}
    }
    expect(rateLimit.get(Base, "a")).toBe(10);
    expect(rateLimit.get(Child, "a")).toBe(5);
    expect(rateLimit.get(Child, "b")).toBe(20);
  });

  it("validates as it's called, naming the decorator", () => {
    const rateLimit = methodValue<number>("rateLimit", { validate: (n) => (n > 0 ? undefined : `${n} isn't positive`) });
    expect(() => rateLimit(0)).toThrow("@rateLimit: 0 isn't positive");
    expect(() => {
      class Bad {
        @rateLimit(0) search() {}
      }
      return Bad;
    }).toThrow("@rateLimit: 0 isn't positive");
    // A validator may throw its own error instead.
    const strict = methodValue<number>("strict", {
      validate: (n) => {
        if (n < 0) throw new RangeError("negative");
      },
    });
    expect(() => strict(-1)).toThrow(RangeError);
  });

  it("validates values stored from inside another decorator too", () => {
    const rateLimit = methodValue<number>("rateLimit", { validate: (n) => (n > 0 ? undefined : `${n} isn't positive`) });
    const broken = (_method: Function, context: ClassMethodDecoratorContext) => rateLimit.set(context, -1);
    expect(() => {
      class Bad {
        @broken search() {}
      }
      return Bad;
    }).toThrow("@rateLimit: -1 isn't positive");
  });

  it("works bare only when declared with `bare`", () => {
    const cache = methodValue("cache", { bare: () => 60 });
    class Page {
      @cache a() {}
      @cache(300) b() {}
      @cache() c() {}
    }
    expect(cache.get(Page, "a")).toBe(60);
    expect(cache.get(Page, "b")).toBe(300);
    expect(cache.get(Page, "c")).toBe(60);

    const rateLimit = methodValue<number>("rateLimit");
    const context = { kind: "method", name: "m", static: false, private: false, metadata: {} };
    expect(() => call(rateLimit, () => {}, context)).toThrow("@rateLimit takes arguments: write @rateLimit(...)");
  });

  it("refuses static methods", () => {
    const rateLimit = methodValue<number>("rateLimit");
    expect(() => {
      class Bad {
        @rateLimit(1) static s() {}
      }
      return Bad;
    }).toThrow("@rateLimit must decorate a public instance method (got s)");
  });
});

describe("methodList", () => {
  it("collects values top to bottom, across stacked uses", () => {
    const tags = methodList<string>("tags");
    class Reports {
      @tags("billing") @tags("admin", "finance") monthly() {}
      @tags() untagged() {}
    }
    expect(tags.get(Reports, "monthly")).toEqual(["billing", "admin", "finance"]);
    expect(tags.get(Reports, "untagged")).toEqual([]);
    expect(tags.get(Reports, "missing")).toEqual([]);
    expect([...tags.entries(Reports).keys()]).toEqual(["monthly", "untagged"]);
  });

  it("puts a subclass's values after its parent's, leaving the parent alone", () => {
    const tags = methodList<string>("tags");
    class Base {
      @tags("p1") @tags("p2") show() {}
    }
    class Child extends Base {
      @tags("c1") @tags("c2") override show() {}
    }
    expect(tags.get(Base, "show")).toEqual(["p1", "p2"]);
    expect(tags.get(Child, "show")).toEqual(["p1", "p2", "c1", "c2"]);
  });

  it("validates each value", () => {
    const tags = methodList<string>("tags", { validate: (tag) => (/^[a-z]+$/.test(tag) ? undefined : `"${tag}" isn't lowercase`) });
    expect(() => {
      class Bad {
        @tags("ok", "Nope") list() {}
      }
      return Bad;
    }).toThrow('@tags: "Nope" isn\'t lowercase');
  });

  it("adds from inside another decorator", () => {
    const tags = methodList<string>("tags");
    const billing = (_method: Function, context: ClassMethodDecoratorContext) => tags.add(context, "billing");
    class Page {
      @billing @tags("admin") list() {}
    }
    expect(tags.get(Page, "list")).toEqual(["billing", "admin"]);
  });
});

describe("classFlag", () => {
  it("flags classes, inherited by subclasses", () => {
    const internal = classFlag("internal");
    @internal
    class Health {}
    class Deep extends Health {}
    class Other {}
    expect(internal.has(Health)).toBe(true);
    expect(internal.has(metadataOf(Deep))).toBe(true);
    expect(internal.has(Other)).toBe(false);
  });

  it("refuses called use and anything but a class", () => {
    const internal = classFlag("internal");
    expect(() => call(internal)).toThrow("@internal takes no arguments: write @internal, not @internal()");
    expect(() => call(internal, () => {}, { kind: "method", name: "m", metadata: {} })).toThrow("@internal must decorate a class (got method m)");
  });
});

describe("classValue", () => {
  it("stores a value per class; a subclass inherits or overrides it", () => {
    const feature = classValue<string>("feature");
    @feature("beta")
    class Billing {}
    class Invoices extends Billing {}
    @feature("alpha")
    class Payouts extends Billing {}
    expect(feature.get(Billing)).toBe("beta");
    expect(feature.get(Invoices)).toBe("beta");
    expect(feature.get(Payouts)).toBe("alpha");
    expect(feature.get(Billing)).toBe("beta");
    class Plain {}
    expect(feature.get(Plain)).toBeUndefined();
  });

  it("works bare, called empty and called with a value when declared with `bare`", () => {
    const prerendered = classValue<{ paths?: string[] }>("prerendered", { bare: () => ({}) });
    @prerendered
    class A {}
    @prerendered()
    class B {}
    @prerendered({ paths: ["/x"] })
    class C {}
    expect(prerendered.get(A)).toEqual({});
    expect(prerendered.get(B)).toEqual({});
    expect(prerendered.get(C)).toEqual({ paths: ["/x"] });
  });

  it("refuses bare use otherwise, and validates as it is called", () => {
    const feature = classValue<string>("feature", { validate: (flag) => (/^[a-z]+$/.test(flag) ? undefined : `"${flag}" isn't a flag name`) });
    expect(() => call(feature, class {}, { kind: "class", name: "X", metadata: {} })).toThrow("@feature takes arguments: write @feature(...)");
    expect(() => {
      @feature("Beta!")
      class Billing {}
      return Billing;
    }).toThrow('@feature: "Beta!" isn\'t a flag name');
  });
});

describe("classList", () => {
  it("collects values top to bottom, a subclass's after its parent's", () => {
    const scopes = classList<string>("scopes");
    @scopes("read")
    @scopes("write", "admin")
    class Billing {}
    @scopes("refund")
    class Refunds extends Billing {}
    expect(scopes.get(Billing)).toEqual(["read", "write", "admin"]);
    expect(scopes.get(Refunds)).toEqual(["read", "write", "admin", "refund"]);
    expect(scopes.get(Billing)).toEqual(["read", "write", "admin"]);
  });
});

describe("createMethodDecorator", () => {
  it("wraps the method with the decorator's arguments", () => {
    const calls: string[] = [];
    const logged = createMethodDecorator("logged", {
      wrap: (method, context, prefix: string) =>
        function (this: unknown, ...args: unknown[]) {
          calls.push(`${prefix}:${String(context.name)}`);
          return method.apply(this, args);
        },
    });
    class Service {
      @logged("svc") double(n: number) {
        return n * 2;
      }
    }
    expect(new Service().double(4)).toBe(8);
    expect(calls).toEqual(["svc:double"]);
    expect(logged.get(Service, "double")).toEqual([["svc"]]);
  });

  it("runs apply where it's applied, and records each use", () => {
    const seen: string[] = [];
    const register = createMethodDecorator("register", {
      apply: (context, name?: string) => {
        if (name === "") throw new TypeError("@register needs a name");
        seen.push(name ?? String(context.name));
      },
      bare: true,
    });
    class Jobs {
      @register nightly() {}
      @register("weekly-report") @register("report") weekly() {}
    }
    expect(seen).toEqual(["nightly", "report", "weekly-report"]);
    expect(register.has(Jobs, "nightly")).toBe(true);
    expect(register.get(Jobs, "nightly")).toEqual([[]]);
    expect(register.get(Jobs, "weekly")).toEqual([["weekly-report"], ["report"]]);
    expect([...register.entries(Jobs).keys()]).toEqual(["nightly", "weekly"]);
    expect(() => {
      class Bad {
        @register("") m() {}
      }
      return Bad;
    }).toThrow("@register needs a name");
  });

  it("validates a called use's arguments as it's called", () => {
    const retry = createMethodDecorator("retry", {
      validate: (times: number) => (Number.isInteger(times) && times > 0 ? undefined : `${times} isn't a positive whole number`),
      bare: true,
    });
    expect(() => retry(0)).toThrow("@retry: 0 isn't a positive whole number");
    expect(() => {
      class Fine {
        @retry a() {}
        @retry(2) b() {}
      }
      return Fine;
    }).not.toThrow();
  });

  it("refuses bare use unless declared, and static or private methods unless anyMember", () => {
    const strict = createMethodDecorator("strict", { apply: (_context, _n: number) => {} });
    const context = { kind: "method", name: "m", static: false, private: false, metadata: {} };
    expect(() => call(strict, () => {}, context)).toThrow("@strict takes arguments: write @strict(...)");
    expect(() => {
      class Bad {
        @strict(1) static s() {}
      }
      return Bad;
    }).toThrow("@strict must decorate a public instance method (got s)");

    const timed = createMethodDecorator("timed", { bare: true, anyMember: true, wrap: (method) => method });
    expect(() => {
      class Fine {
        @timed static s() {}
        @timed #p() {}
      }
      return Fine;
    }).not.toThrow();
  });

  it("refuses symbol-named methods with stringNamed", () => {
    const named = createMethodDecorator("named", { bare: true, stringNamed: true });
    const key = Symbol("k");
    expect(() => {
      class Bad {
        @named [key]() {}
      }
      return Bad;
    }).toThrow("@named must decorate a public, string-named instance method (got Symbol(k))");
  });

  it("keeps a subclass's uses out of its parent", () => {
    const mark = createMethodDecorator("mark", { bare: true });
    class Base {
      @mark a() {}
    }
    class Child extends Base {
      @mark b() {}
    }
    expect([...mark.entries(Base).keys()]).toEqual(["a"]);
    expect([...mark.entries(Child).keys()]).toEqual(["a", "b"]);
  });
});

describe("builder names", () => {
  it("must be plain identifiers", () => {
    expect(() => methodFlag("@audit")).toThrow(/plain identifier/);
    expect(() => methodValue("")).toThrow(/plain identifier/);
  });
});
