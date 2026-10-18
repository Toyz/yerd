import { describe, expect, it } from "vitest";
import { ILogger, instrument, yerd, type LogRecord } from "@toyz/yerd";

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
