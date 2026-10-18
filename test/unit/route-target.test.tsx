import { describe, expect, it } from "vitest";
import { action, createGuard, get, guards, methodFlag, methodValue, route, yerd, type Middleware } from "@toyz/yerd";

// ctx.route carries the route class and the method serving the request, so a
// guard or middleware can read the handler's own decorators.
const rateLimit = methodValue<number>("rateLimit");
const audited = methodFlag("audited");
const seen: string[] = [];

const limited = createGuard("limited", (ctx) => {
  const max = rateLimit.get(ctx.route.target!, ctx.route.method!);
  seen.push(`guard ${String(ctx.route.method)} ${max ?? "-"}`);
  return max === undefined || max > 1;
});

const audit: Middleware = async (ctx, next) => {
  seen.push(`middleware ${String(ctx.route.method)} ${audited.has(ctx.route.target!, ctx.route.method!)}`);
  return next();
};

@route("/limits")
@guards(limited)
class Limits {
  @get @audited @rateLimit(5) show() {
    return <form action={this.save}><button>save</button></form>;
  }
  @get((ctx) => ctx.query.has("strict")) @rateLimit(1) strict() {
    return "strict";
  }
  @action @rateLimit(1) save() {
    return "saved";
  }
}

describe("ctx.route.target and ctx.route.method", () => {
  it("let a guard read the handler's decorators, and middleware see the default handler", async () => {
    seen.length = 0;
    const app = yerd({ routes: [Limits], services: [], handleSignals: false }).use(audit);
    const r = await app.request("/limits");
    expect(r.status).toBe(200);
    expect(seen).toEqual(["middleware show true", "guard show 5"]);
  });

  it("follow a @get(when) variant once it's chosen", async () => {
    seen.length = 0;
    const app = yerd({ routes: [Limits], services: [], handleSignals: false }).use(audit);
    const r = await app.request("/limits?strict");
    expect(r.status).toBe(403);
    expect(seen).toEqual(["middleware show true", "guard strict 1"]);
  });

  it("name the action being posted", async () => {
    seen.length = 0;
    const app = yerd({ routes: [Limits], services: [], handleSignals: false });
    const client = app.client();
    const r = await client.action("/limits");
    expect(r.status).toBe(403);
    expect(seen.at(-1)).toBe("guard save 1");
  });

  it("carry the class itself", async () => {
    let target: Function | undefined;
    const peek: Middleware = async (ctx, next) => {
      target = ctx.route.target;
      return next();
    };
    await yerd({ routes: [Limits], services: [], handleSignals: false }).use(peek).request("/limits");
    expect(target).toBe(Limits);
  });
});
