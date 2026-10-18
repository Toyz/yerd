import { describe, expect, it } from "vitest";
import { ILogger, instrument, log, yerd, type LogRecord } from "@toyz/yerd";

interface Signup {
  email: string;
  secret: string;
  profile: { name: string; billing: { card: string; cvc: string } };
  tags: Array<{ label: string; key: string }>;
}

describe("@instrument skip paths", () => {
  it("drops whole arguments by name or position, and nested fields by path, without touching the arguments", async () => {
    class Accounts {
      @instrument({ level: "info", skip: ["input.secret", "input.profile.billing.cvc", "input.tags.0.key", "2"] })
      create(input: Signup, note: string, pin: string) {
        return input.email + note + pin;
      }
    }
    const records: LogRecord[] = [];
    const app = yerd({ routes: [], services: [] })
      .logging({ filter: "info" })
      .services((s) => s.value(ILogger, { write: (r) => records.push(r) }));
    const signup: Signup = {
      email: "a@b.c",
      secret: "s",
      profile: { name: "ada", billing: { card: "4242", cvc: "123" } },
      tags: [{ label: "x", key: "k1" }, { label: "y", key: "k2" }],
    };
    const result = await app.scope(() => new Accounts().create(signup, "hi", "0000"));
    expect(result).toBe("a@b.chi0000");
    const enter = records.find((r) => r.kind === "span-enter")!;
    expect(enter.spans.at(-1)!.fields).toEqual({
      input: { email: "a@b.c", profile: { name: "ada", billing: { card: "4242" } }, tags: [{ label: "x" }, { label: "y", key: "k2" }] },
      note: "hi",
    });
    // The real argument is untouched.
    expect(signup.secret).toBe("s");
    expect(signup.profile.billing.cvc).toBe("123");
  });

  it("throws when the class loads if a skip names a parameter that doesn't exist", () => {
    expect(() => {
      class Wrong {
        @instrument({ skip: ["pasword"] })
        login(password: string) {
          return password;
        }
      }
      void Wrong;
    }).toThrow(/login\(password\) has no parameter "pasword"/);
  });
});

describe("@instrument targets and filters", () => {
  function capture(filter: string) {
    const records: LogRecord[] = [];
    const app = yerd({ routes: [], services: [] })
      .logging({ filter })
      .services((s) => s.value(ILogger, { write: (r) => records.push(r) }));
    return { app, records };
  }

  it("names spans after the calling class, a subclass and its base taking turns", async () => {
    class Base {
      @instrument({ level: "info" })
      run(n: number) {
        return n;
      }
    }
    class Sub extends Base {}
    const { app, records } = capture("info");
    await app.scope(() => [new Base().run(1), new Sub().run(2), new Base().run(3), new Sub().run(4)]);
    const entered = records.filter((r) => r.kind === "span-enter");
    expect(entered.map((r) => `${r.target} ${r.message}`)).toEqual(["Base Base::run", "Sub Sub::run", "Base Base::run", "Sub Sub::run"]);
  });

  it("is called directly when off, with its own this and arguments, building no fields", async () => {
    let built = 0;
    class Quiet {
      factor = 3;
      @instrument({ fields: () => (built++, {}) })
      times(n: number) {
        return n * this.factor;
      }
    }
    const { app, records } = capture("info");
    expect(await app.scope(() => new Quiet().times(5))).toBe(15);
    expect(built).toBe(0);
    expect(records).toEqual([]);
  });

  it("follows span directives: on inside a span the filter opens, off outside it", async () => {
    class Deep {
      @instrument()
      dig() {
        log.debug("digging");
        return "dug";
      }
    }
    const { app, records } = capture("info,[mine]=debug");
    await app.scope(() => new Deep().dig());
    expect(records).toEqual([]);
    await app.scope(() => log.span("mine", {}, () => new Deep().dig()));
    expect(records.filter((r) => r.kind === "span-enter").map((r) => r.message)).toEqual(["mine", "Deep::dig"]);
    expect(records.find((r) => r.kind === "event")?.message).toBe("digging");
  });
});
