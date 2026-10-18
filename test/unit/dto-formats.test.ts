import { describe, expect, it } from "vitest";
import { YerdError, email, is, parse, trim, uuid } from "@toyz/yerd";

type Uuid = string & { readonly __brand: "Uuid" };
function toUuid(value: string): Uuid {
  if (uuid()(value) !== true) throw new Error("Not a UUID");
  return value.toLowerCase() as Uuid;
}

class Order {
  @is.uuid() id!: string;
  @is.uuid({ version: 4, optional: true }) v4?: string;
  @is.string({ transform: [trim, toUuid] }) ref!: Uuid;
  @is.email() contact!: string;
  @is.url() site!: string;
  @is.url({ protocols: ["mailto"], optional: true }) mail?: string;
  @is.date() at!: Date;
  @is.number({ transform: (n: number) => BigInt(Math.trunc(n)), validate: (n: bigint) => n > 0n || "Must be positive" }) cents!: bigint;
}

const valid = {
  id: "8F14E45F-CEEA-467A-9575-0E8F2C3B6A9D",
  v4: "8f14e45f-ceea-467a-9575-0e8f2c3b6a9d",
  ref: "  0190d5a8-7c1e-7b3a-9f00-1234567890ab ",
  contact: "  yerd@example.com ",
  site: "https://Example.com/a b",
  at: "2026-10-17",
  cents: "1250.9",
};

function issues(input: Record<string, unknown>): string[] {
  try {
    parse(Order, input);
    return [];
  } catch (error) {
    return ((error as YerdError).details!.issues as Array<{ path: string; message: string }>).map((i) => `${i.path}: ${i.message}`);
  }
}

describe("is.* formats", () => {
  it("parse and normalize", () => {
    const order = parse(Order, valid);
    expect(order.id).toBe("8f14e45f-ceea-467a-9575-0e8f2c3b6a9d");
    expect(order.ref).toBe("0190d5a8-7c1e-7b3a-9f00-1234567890ab");
    expect(order.contact).toBe("yerd@example.com");
    expect(order.site).toBe("https://example.com/a%20b");
    expect(order.at.toISOString()).toBe("2026-10-17T00:00:00.000Z");
    expect(order.cents).toBe(1250n);
  });

  it("reject what doesn't fit, with messages", () => {
    expect(issues({ ...valid, id: "nope", v4: "0190d5a8-7c1e-7b3a-9f00-1234567890ab" })).toEqual([
      "id: Expected a UUID",
      "v4: Expected a version 4 UUID",
    ]);
    expect(issues({ ...valid, ref: "abc" })).toEqual(["ref: Not a UUID"]);
    expect(issues({ ...valid, contact: "a@b", site: "javascript:alert(1)" })).toEqual(["contact: Expected an email address", "site: Expected a http or https URL"]);
    expect(issues({ ...valid, mail: "https://x.dev" })).toEqual(["mail: Expected a mailto URL"]);
    expect(issues({ ...valid, cents: "-3" })).toEqual(["cents: Must be positive"]);
  });

  it("dates: ISO only, real calendar days, zones respected", () => {
    const at = (value: unknown) => {
      try {
        return parse(Order, { ...valid, at: value }).at.toISOString();
      } catch {
        return "invalid";
      }
    };
    expect(at("2026-10-17T09:30:00Z")).toBe("2026-10-17T09:30:00.000Z");
    expect(at("2026-10-17T09:30:00+02:00")).toBe("2026-10-17T07:30:00.000Z");
    expect(at(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01T00:00:00.000Z");
    expect(at("2026-02-30")).toBe("invalid");
    expect(at("2024-02-29")).toBe("2024-02-29T00:00:00.000Z");
    expect(at("2026-13-01")).toBe("invalid");
    expect(at("10/17/2026")).toBe("invalid");
    expect(at("tomorrow")).toBe("invalid");
    expect(at(1760000000000)).toBe("invalid");
    expect(at(new Date("nope"))).toBe("invalid");
  });

  it("validators work standalone, for params", () => {
    expect(uuid()("8f14e45f-ceea-467a-9575-0e8f2c3b6a9d")).toBe(true);
    expect(uuid(7)("8f14e45f-ceea-467a-9575-0e8f2c3b6a9d")).toBe("Expected a version 7 UUID");
    expect(email()("x@y.co")).toBe(true);
    expect(email()(`${"a".repeat(250)}@y.co`)).toBe("Expected an email address");
  });
});
