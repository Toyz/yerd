// formAction remembers each action's route and full pattern. Its own file:
// it resets the route registry, as a dev reload does.
import { afterAll, describe, expect, it } from "vitest";
import { action, get, group, route, yerd } from "@toyz/yerd";
import { resetRouteRegistry } from "../../src/decorators/route.js";

@group("/shop") class Shop {}

@route("/items/:id", { group: Shop })
class Items {
  @get page() {
    return (
      <div>
        <form action={this.save}><button>Save</button></form>
        <form action={this.save}><button>Again</button></form>
      </div>
    );
  }
  @action save() {}
}

const app = yerd({ routes: [Items], services: [], handleSignals: false, secret: "c".repeat(32) });
afterAll(() => app.stop());

describe("formAction's route cache", () => {
  it("posts every form to the group-prefixed pattern, filled from the page", async () => {
    for (const id of ["7", "8"]) {
      const html = await (await app.request(`/shop/items/${id}`, { headers: { accept: "text/html" } })).text();
      expect(html.match(new RegExp(`action="/shop/items/${id}"`, "g"))).toHaveLength(2);
    }
  });

  it("notices a reset registry instead of serving the old route", async () => {
    resetRouteRegistry();
    const res = await app.request("/shop/items/7", { headers: { accept: "application/json" } });
    expect(res.status).toBe(500);
  });
});
