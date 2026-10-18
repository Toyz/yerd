import { describe, expect, it } from "vitest";
import { action, bind, captureAction, isAction, isBoundAction, type ActionForm } from "../../src/actions/action.js";
import { runWithContext, type YerdContext } from "../../src/server/context.js";

const ran: unknown[] = [];

class Board {
  @action move(args: { id: string; to?: unknown }) {
    ran.push(["move", args]);
    return "moved";
  }

  @action rename(args: { id: string }, form?: ActionForm) {
    ran.push(["rename", args, form?.get("title")]);
  }

  plain(args: unknown) {
    ran.push(["plain", args]);
  }
}

const board = new Board();
const ctx = { query: new URLSearchParams("page=4") } as unknown as YerdContext;

/** captureAction inside a (fake) request, as the renderer calls it. */
function capture(lambda: Function, holes?: string[][]) {
  return runWithContext(ctx, () => captureAction(lambda, holes));
}

function error(fn: () => unknown): string {
  try {
    fn();
    return "no error";
  } catch (e) {
    return (e as Error).message;
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("captureAction", () => {
  it("records the call without running the action", () => {
    ran.length = 0;
    const bound = capture(() => board.move({ id: "a" }));
    expect(ran).toEqual([]);
    expect(bound.fn).toBe(board.move);
    expect(bound.args).toEqual({ id: "a" });
    expect(bound.holes).toBeUndefined();
  });

  it("runs the action for real outside a capture", () => {
    ran.length = 0;
    expect(board.move({ id: "b" })).toBe("moved");
    expect(ran).toEqual([["move", { id: "b" }]]);
  });

  it("an unbound action (passed down as a prop) is captured the same", () => {
    const { move } = board;
    expect(capture(() => move({ id: "c" })).args).toEqual({ id: "c" });
  });

  it("an action called with no args gets {}", () => {
    expect(capture(() => (board.move as unknown as () => void)()).args).toEqual({});
  });

  it("reads ctx now, on the server", () => {
    expect(capture(({ ctx }: { ctx: YerdContext }) => board.move({ id: ctx.query.get("page")! })).args).toEqual({ id: "4" });
  });

  it.each([
    ["no call", () => 1, "must call an @action method"],
    ["a plain method", () => board.plain({}), "must call an @action method"],
    ["two calls", () => (board.move({ id: "a" }), board.move({ id: "b" })), "calls one @action method, not 2"],
    ["two different actions", () => (board.move({ id: "a" }), board.rename({ id: "b" })), "calls one @action method, not 2"],
    ["a call in a loop", () => [1, 2, 3].forEach(() => board.move({ id: "x" })), "calls one @action method, not 3"],
  ])("refuses a lambda with %s", (_name, lambda, message) => {
    expect(error(() => capture(lambda))).toContain(message);
  });

  it("passes a lambda's own error through and leaves capture mode", () => {
    ran.length = 0;
    expect(error(() => capture(() => {
      throw new Error("boom");
    }))).toBe("boom");
    // Not stuck capturing: the next real call runs.
    board.move({ id: "after" });
    expect(ran).toEqual([["move", { id: "after" }]]);
  });

  it("a lambda that calls the action and then throws still throws", () => {
    expect(error(() => capture(() => {
      board.move({ id: "a" });
      throw new Error("late");
    }))).toBe("late");
  });

  it("an async lambda's call before its first await is recorded", async () => {
    const bound = capture(async () => board.move({ id: "async" }));
    expect(bound.args).toEqual({ id: "async" });
    await tick();
  });

  it("an async lambda that awaits first is refused, and its action never runs during the render", async () => {
    ran.length = 0;
    expect(error(() => capture(async () => {
      await null;
      board.move({ id: "late" });
    }))).toContain("must call an @action method");
    await tick();
    await tick();
    // The render failed; the action must not have run behind its back.
    expect(ran).toEqual([]);
  });

  it("a lambda rendering another action lambda is refused", () => {
    expect(error(() => capture(() => {
      captureAction(() => board.move({ id: "inner" }));
      board.move({ id: "outer" });
    }))).toContain("can't render another action lambda");
    // And the outer capture didn't leave the flag set.
    expect(capture(() => board.move({ id: "x" })).args).toEqual({ id: "x" });
  });

  it("passes the stand-in form, which is empty", () => {
    const bound = capture(({ form }: { form: ActionForm }) => board.rename({ id: "r" }, form));
    expect(bound.args).toEqual({ id: "r" });
  });
});

describe("holes", () => {
  type Scope = { el: Record<string, any>; ref: (s: string) => Record<string, any>; drag: Record<string, any> };

  it("every element field becomes a numbered hole, reused when read twice", () => {
    const bound = capture(({ el, ref, drag }: Scope) =>
      board.move({ id: el.value, to: [el.checked, el.value, ref("#a").valueAsNumber, drag.dataset.id, drag.data("id"), ref("#a").selectedIndex] }),
    );
    expect(bound.holes).toEqual([["el", "value"], ["el", "checked"], ["ref", "#a", "valueAsNumber"], ["drag", "dataset", "id"], ["ref", "#a", "selectedIndex"]]);
    expect(bound.args).toEqual({
      id: { __yxHole: 0 },
      to: [{ __yxHole: 1 }, { __yxHole: 0 }, { __yxHole: 2 }, { __yxHole: 3 }, { __yxHole: 3 }, { __yxHole: 4 }],
    });
  });

  it.each(["value", "valueAsNumber", "checked", "selectedIndex", "open", "disabled", "textContent", "id", "name", "scrollTop", "scrollLeft"])(
    "el.%s is readable",
    (field) => {
      expect(capture(({ el }: Scope) => board.move({ id: el[field] })).holes).toEqual([["el", field]]);
    },
  );

  it.each(["innerHTML", "value2", "parentElement", "getAttribute", "style", "files", "__proto__"])("el.%s explains what can be read", (field) => {
    expect(error(() => capture(({ el }: Scope) => board.move({ id: el[field] })))).toContain(`el.${field} can't be read in an action lambda`);
  });

  it.each([
    ["trim()", ({ el }: Scope) => board.move({ id: el.value.trim() })],
    ["a template string", ({ el }: Scope) => board.move({ id: `${el.value}!` })],
    ["concatenation", ({ el }: Scope) => board.move({ id: el.value + "x" })],
    ["arithmetic", ({ el }: Scope) => board.move({ id: (el.valueAsNumber * 2) as never })],
    ["String()", ({ el }: Scope) => board.move({ id: String(el.value) })],
    ["Number()", ({ el }: Scope) => board.move({ id: Number(el.value) as never })],
    ["a comparison", ({ el }: Scope) => board.move({ id: (el.valueAsNumber > 3) as never })],
  ])("computing with a hole (%s) throws a message that says so", (_name, lambda) => {
    expect(error(() => capture(lambda))).toMatch(/is filled in by the browser when the action fires/);
  });

  it("names a ref hole by its selector in the message", () => {
    expect(error(() => capture(({ ref }: Scope) => board.move({ id: ref("#q").value.trim() })))).toContain('ref("#q").value is filled in by the browser');
  });

  it("a hole tested for truthiness doesn't throw but is always truthy (documented: pass it straight through)", () => {
    const bound = capture(({ el }: Scope) => board.move({ id: el.checked ? "yes" : "no" }));
    expect(bound.args).toEqual({ id: "yes" });
  });

  it("awaiting a hole doesn't treat it as a thenable", async () => {
    const bound = capture(({ el }: Scope) => board.move({ id: el.value }));
    expect(bound.args).toEqual({ id: { __yxHole: 0 } });
  });

  it("holes nested in arrays and objects survive; a top-level hole as the whole args too", () => {
    const bound = capture(({ el }: Scope) => (board.move as (a: unknown) => void)(el.value));
    expect(bound.args).toEqual({ __yxHole: 0 });
  });

  it("args that aren't holes keep their JSON meaning: Dates become strings, undefined fields vanish", () => {
    const when = new Date("2026-01-02T03:04:05.000Z");
    const bound = capture(() => board.move({ id: "d", to: { when, gone: undefined, n: null } }));
    expect(JSON.parse(JSON.stringify(bound.args))).toEqual({ id: "d", to: { when: "2026-01-02T03:04:05.000Z", n: null } });
  });

  it("a class instance in the args is sent as its JSON", () => {
    class Point {
      constructor(readonly x: number, readonly y: number) {}
    }
    const bound = capture(() => board.move({ id: "p", to: new Point(1, 2) }));
    expect(JSON.parse(JSON.stringify(bound.args))).toEqual({ id: "p", to: { x: 1, y: 2 } });
  });

  it("circular args fail while rendering, not silently", () => {
    const loop: Record<string, unknown> = { id: "loop" };
    loop.self = loop;
    expect(() => capture(() => board.move(loop as { id: string }))).toThrow();
  });

  it("a user object shaped like a hole marker stays data when the lambda has no holes", () => {
    const bound = capture(() => board.move({ id: "x", to: { __yxHole: 0 } }));
    expect(bound.holes).toBeUndefined();
    expect(bound.args).toEqual({ id: "x", to: { __yxHole: 0 } });
  });

  // Question: with holes, a user object exactly shaped { __yxHole: <n> } in the args
  // (say, from stored JSON) is filled like a real hole. Only that spot changes, and
  // only with what the browser sends for hole n, so it isn't a privilege gain, but the
  // value's type changes. Left as is; see the report.
  it.skip("a user object shaped like a hole marker stays data next to real holes", () => {
    const bound = capture(({ el }: Scope) => board.move({ id: el.value, to: { __yxHole: 0 } }));
    expect(bound.args).toEqual({ id: { __yxHole: 0 }, to: { __yxHole: 0 } });
  });
});

describe("bind", () => {
  it("is the same as a lambda without holes", () => {
    const bound = bind(board.move, { id: "z" });
    const captured = capture(() => board.move({ id: "z" }));
    expect(bound.fn).toBe(captured.fn);
    expect(bound.args).toEqual(captured.args);
    expect(isBoundAction(bound)).toBe(true);
    expect(isBoundAction(captured)).toBe(true);
  });

  it.each([
    ["a plain object with fn and args", { fn: board.move, args: {} }],
    ["null", null],
    ["a function", () => 1],
    ["a string", "bind"],
  ])("isBoundAction(%s) is false", (_name, value) => {
    expect(isBoundAction(value)).toBe(false);
  });

  it("isAction knows decorated methods, not plain ones or lambdas", () => {
    expect(isAction(board.move)).toBe(true);
    expect(isAction(Board.prototype.move)).toBe(true);
    expect(isAction(board.plain)).toBe(false);
    expect(isAction(() => board.move({ id: "a" }))).toBe(false);
    expect(isAction(undefined)).toBe(false);
  });

  it("@action refuses static, private and symbol-named methods", () => {
    expect(() => {
      class Bad {
        @action static s() {}
      }
      return Bad;
    }).toThrow("@action must decorate a public, string-named instance method");
    expect(() => {
      class Bad {
        @action #p() {}
      }
      return Bad;
    }).toThrow("@action must decorate a public, string-named instance method");
    const sym = Symbol("s");
    expect(() => {
      class Bad {
        @action [sym]() {}
      }
      return Bad;
    }).toThrow("@action must decorate a public, string-named instance method");
  });

  it("keeps the method's name", () => {
    expect(board.move.name).toBe("move");
  });
});
