// Compile-only checks, run by `npm run check` (tsc). Each @ts-expect-error
// must stay an error; if one stops erroring, tsc fails.
import { args, between, body, get, header, is, length, lower, matches, oneOf, param, post, put, query, route, toBool, toInt, trim } from "@toyz/yerd";

@route("/types/:id")
export class Good {
  @param("id") accessor id!: string;
  @param("id", { transform: toInt }) accessor n!: number;
  @param("id", { transform: toInt, validate: between(1, 100) }) accessor bounded!: number;
  @param("id", { validate: [length(1, 20), matches(/^\w+$/)] }) accessor slug!: string;
  @query("page", { transform: toInt, validate: (n: number) => n % 2 === 0 || "page must be even" }) accessor page = 2;
  @query("q") accessor q: string | undefined;
  @query("debug", { transform: toBool }) accessor debug = false;
  @query("sort", { transform: [trim, lower, oneOf("asc", "desc")] }) accessor sort: "asc" | "desc" = "asc";
  @query("dir", { transform: oneOf("up", "down"), validate: (d: "up" | "down") => d !== "down" }) accessor dir: "up" | "down" = "up";
  @query("token", { required: true }) accessor token!: string;
  @header("x-count", { transform: toInt, validate: [between(1, 10)], required: true }) accessor count!: number;

  @get show() {
    return [this.id, this.n, this.bounded, this.slug, this.page, this.q, this.debug, this.sort, this.dir, this.token, this.count];
  }
}

@route("/types/bad/:id")
export class Bad {
  // @ts-expect-error param resolves a string; the field says number
  @param("id") accessor wrongType!: number;

  // @ts-expect-error toInt makes a number; the field says string
  @param("id", { transform: toInt }) accessor wrongParsed!: string;

  // @ts-expect-error trim takes a string, but toInt hands it a number
  @param("id", { transform: [toInt, trim] }) accessor badPipe!: string;

  // @ts-expect-error the pipe ends in "asc" | "desc"; the field is a number
  @query("sort", { transform: [lower, oneOf("asc", "desc")] }) accessor sortNum = 0;

  // @ts-expect-error matches() checks strings, but the pipeline produces a number
  @query("n", { transform: toInt, validate: matches(/x/) }) accessor wrongValidator = 1;

  // @ts-expect-error the validator's parameter type doesn't match the pipeline output
  @query("m", { transform: toInt, validate: (s: string) => s.length > 0 }) accessor wrongLambda = 1;

  // Not catchable: a missing value falls back to the field's initializer, and
  // `accessor t!: string` looks the same as `accessor t = "x"` at type level.
  // Use `required: true` or give the field a default.
  @query("token") accessor token!: string;

  @get show() {
    return 1;
  }
}

class Thing {
  @is.int() id!: number;
  @is.string({ optional: true }) note?: string;
  @is.oneOf(["a", "b"]) kind!: "a" | "b";
  @is.array(is.int()) ids!: number[];
}

declare function parseThing(raw: unknown): Thing;

export class BadDto {
  // @ts-expect-error is.int() validates a number; the field says string
  @is.int() wrongType!: string;

  // @ts-expect-error optional: the value can be undefined; the field can't hold that
  @is.string({ optional: true }) mustExist!: string;

  // @ts-expect-error the union is "a" | "b"; the field allows only "a"
  @is.oneOf(["a", "b"]) narrow!: "a";

  // @ts-expect-error the array holds numbers; the field says string[]
  @is.array(is.int()) list!: string[];

  // @ts-expect-error matches() checks strings, but is.int() produces numbers
  @is.int({ validate: matches(/x/) }) badValidator!: number;
}

@route("/types/body/:id")
export class Bodies {
  @body(Thing) accessor thing!: Promise<Thing>;
  @body({ transform: parseThing }) accessor maybe!: Promise<Thing | undefined>;
  @body() accessor anything!: Promise<unknown>;

  // @ts-expect-error not required, so the promise can resolve to undefined
  @body({ transform: parseThing }) accessor strict!: Promise<Thing>;

  // @ts-expect-error body is a promise; the field isn't
  @body(Thing) accessor notPromise!: Thing;

  @get
  @args(param("id", { transform: toInt }), body(Thing))
  ok(id: number, thing: Thing) {
    return [id, thing];
  }

  @post
  // @ts-expect-error the first resolver produces a number; the parameter says string
  @args(param("id", { transform: toInt }))
  wrongArg(id: string) {
    return id;
  }

  @put
  // @ts-expect-error body(Thing) produces a Thing; the parameter says string
  @args(body(Thing))
  wrongBody(thing: string) {
    return thing;
  }
}
