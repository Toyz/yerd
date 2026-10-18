import { describe, expect, it } from "vitest";
import { BootError, ILogger, instrument, log, yerd, type LogRecord } from "@toyz/yerd";
import { compilePath, prunePaths } from "../../src/log/paths.js";

const order = {
  id: "o-1",
  card: { number: "4242", cvc: "123", exp: "12/30" },
  user: { name: "ada", password: "pw", profile: { password: "pw2", ssn: "000" } },
  items: [{ sku: "a", secret: "s1" }, { sku: "b", secret: "s2" }],
};

const prune = (paths: string[], replace?: string) => prunePaths(order, paths.map(compilePath), replace);

describe("field path patterns", () => {
  it.each([
    [["card.number"], { card: { cvc: "123", exp: "12/30" } }],
    [["card.*"], { card: {} }],
    [["*.password"], { user: { name: "ada", profile: { password: "pw2", ssn: "000" } } }],
    [["**.password"], { user: { name: "ada", profile: { ssn: "000" } } }],
    [["items.*.secret"], { items: [{ sku: "a" }, { sku: "b" }] }],
    [["**.ssn", "card.cvc"], { card: { number: "4242", exp: "12/30" }, user: { profile: { password: "pw2" } } }],
  ])("%j removes what it names", (paths, expected) => {
    expect(prune(paths)).toMatchObject(expected);
  });

  it("masks instead of removing, and never touches the original", () => {
    const masked = prune(["**.password", "card.number"], "[redacted]") as typeof order;
    expect(masked.card.number).toBe("[redacted]");
    expect(masked.user.profile.password).toBe("[redacted]");
    expect(order.card.number).toBe("4242");
    // Values no pattern can reach are shared, not copied.
    expect((prune(["card.number"]) as typeof order).items).toBe(order.items);
  });

  it("removes array items as [skipped], keeping positions", () => {
    expect(prune(["items.0"])).toMatchObject({ items: ["[skipped]", { sku: "b" }] });
  });

  it.each(["card..number", "card.num*", "**x"])("refuses %j", (bad) => {
    expect(() => compilePath(bad)).toThrow(TypeError);
  });
});

function capture(options: { redact?: string[] } = {}) {
  const records: LogRecord[] = [];
  const app = yerd({ routes: [], services: [], handleSignals: false })
    .logging({ filter: "debug", ...options })
    .services((s) => s.value(ILogger, { write: (r) => records.push(r) }));
  return { app, records };
}

class Billing {
  @instrument({ level: "info", skip: ["card.*", "**.cvc", "*.password"] })
  charge(card: { number: string; cvc: string }, user: { name: string; password: string; nested: { cvc: string } }) {
    log.info("charging");
    return { ok: true };
  }
}

describe("@instrument skip wildcards", () => {
  it("drop matching argument fields from the span", async () => {
    const { app, records } = capture();
    await app.scope(() => new Billing().charge({ number: "4242", cvc: "1" }, { name: "ada", password: "pw", nested: { cvc: "2" } }));
    const enter = records.find((r) => r.kind === "span-enter")!;
    expect(enter.spans[0]!.fields).toEqual({ card: {}, user: { name: "ada", nested: {} } });
    await app.stop();
  });
});

describe("logging({ redact })", () => {
  it("masks matching fields in every record, span fields included", async () => {
    const { app, records } = capture({ redact: ["**.ssn", "card.number", "*.email"] });
    await app.scope(() => {
      log.info("signup", { user: { email: "a@b.c", ssn: "000-00", name: "ada" }, card: { number: "4242", brand: "visa" } });
      return new Billing().charge({ number: "4242", cvc: "1" }, { name: "ada", password: "pw", nested: { cvc: "2" } });
    });
    const signup = records.find((r) => r.message === "signup")!;
    expect(signup.fields).toEqual({ user: { email: "[redacted]", ssn: "[redacted]", name: "ada" }, card: { number: "[redacted]", brand: "visa" } });
    await app.stop();
  });

  it("masks @instrument arguments too, on top of the method's own skip", async () => {
    class Payments {
      @instrument({ level: "info", skip: ["card.number"] })
      pay(card: { number: string; cvc: string; holder: string }, user: { email: string; name: string }) {
        return card.holder + user.name;
      }
    }
    const { app, records } = capture({ redact: ["**.cvc", "*.email"] });
    await app.scope(() => new Payments().pay({ number: "4242", cvc: "123", holder: "Ada" }, { email: "a@b.c", name: "ada" }));
    const span = records.find((r) => r.kind === "span-enter")!.spans[0]!;
    // skip removed card.number; redact masked the rest of the secrets.
    expect(span.fields).toEqual({ card: { cvc: "[redacted]", holder: "Ada" }, user: { email: "[redacted]", name: "ada" } });
    await app.stop();
  });

  it("reaches into class instances (a parsed DTO), keeping the class name in the record", async () => {
    class Checkout {
      constructor(
        readonly name: string,
        readonly email: string,
        readonly when: Date,
      ) {}
    }
    class Orders {
      @instrument({ level: "info", skip: ["form.when"] })
      place(form: Checkout) {
        return form.name;
      }
    }
    const { app, records } = capture({ redact: ["form.email"] });
    await app.scope(() => {
      log.info("checkout", { form: new Checkout("Ada", "ada@example.com", new Date(0)) });
      return new Orders().place(new Checkout("Ada", "ada@example.com", new Date(0)));
    });
    const line = JSON.stringify(records.find((r) => r.message === "checkout")!.fields);
    expect(line).not.toContain("ada@example.com");
    expect(line).toContain("Checkout");
    expect(line).toContain("1970-01-01");
    const span = JSON.stringify(records.find((r) => r.kind === "span-enter")!.spans[0]!.fields);
    expect(span).not.toContain("ada@example.com");
    expect(span).not.toContain("1970-01-01");
    expect(span).toContain("Ada");
    await app.stop();
  });

  it("leaves built-ins to the serializer", () => {
    const when = new Date(0);
    const pruned = prunePaths({ at: when, tags: new Set(["a"]) }, [compilePath("at.x")]) as { at: Date; tags: Set<string> };
    expect(pruned.at).toBe(when);
    expect(pruned.tags).toBeInstanceOf(Set);
  });

  it("refuses a malformed path at boot", async () => {
    const { app } = capture({ redact: ["card..number"] });
    const error = (await app.boot().catch((e: unknown) => e)) as BootError;
    expect(error).toBeInstanceOf(BootError);
    expect(error.problems.join()).toMatch(/logging\(\{ redact \}\): Invalid field path "card..number"/);
  });
});
