// @skipGuards: a route, group, handler or action opting out of guards it would inherit.
import { describe, expect, it } from "vitest";
import { ActionForm, BootError, Unauthorized, action, createGuard, get, group, post, route, skipGuards, yerd } from "@toyz/yerd";

const signedIn = createGuard("signedIn", (ctx) => ctx.headers["x-user"] !== undefined || new Unauthorized());
const staff = createGuard("staff", (ctx) => ctx.headers["x-staff"] !== undefined || new Unauthorized("Staff only"));

@route("/account")
class Account {
  @get page() {
    return "account";
  }
}

@route("/login")
@skipGuards(signedIn)
class Login {
  @get page() {
    return <form action={this.signIn}><button>in</button></form>;
  }
  @action signIn(_: {}, _form: ActionForm) {
    return "signed in";
  }
}

@route("/status")
class Status {
  @get @skipGuards(signedIn) health() {
    return { ok: true };
  }
}

@route("/status/details")
class StatusDetails {
  @get details() {
    return { detailed: true };
  }
}

@group("/admin", { guards: [staff] })
class Admin {}

@route("/reports", { group: Admin })
class Reports {
  @get list() {
    return "reports";
  }
}

@group("/help", { group: Admin })
@skipGuards(staff, signedIn)
class Help {}

@route("/faq", { group: Help })
class Faq {
  @get read() {
    return "faq";
  }
}

const app = () => yerd({ routes: [Account, Login, Status, StatusDetails, Reports, Faq], services: [], handleSignals: false }).guard(signedIn);
const json = { headers: { accept: "application/json" } };

describe("@skipGuards", () => {
  it("lets a route class opt out of an app-wide guard, actions included", async () => {
    const server = app();
    expect((await server.request("/account", json)).status).toBe(401);
    expect((await server.request("/login", json)).status).toBe(200);
    const client = server.client();
    await client.page("/login");
    expect((await client.action("/login", {})).status).toBe(200);
  });

  it("on a method, covers just that handler", async () => {
    const server = app();
    expect((await server.request("/status", json)).status).toBe(200);
    expect((await server.request("/status/details", json)).status).toBe(401);
  });

  it("on a group, covers its routes, and skips app and outer group guards alike", async () => {
    const server = app();
    expect((await server.request("/admin/reports", { headers: { accept: "application/json", "x-user": "ada" } })).status).toBe(401);
    expect((await server.request("/admin/help/faq", json)).status).toBe(200);
  });

  it("refuses at boot a skip that names a guard not applied there", async () => {
    const unused = createGuard("unused", () => true);
    @route("/typo")
    @skipGuards(unused)
    class Typo {
      @get page() {
        return "x";
      }
      @post @skipGuards("nope") other() {
        return "y";
      }
    }
    const error = await yerd({ routes: [Typo], services: [], handleSignals: false }).boot().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BootError);
    expect((error as BootError).problems).toEqual([
      "Typo: @skipGuards(unused) skips a guard that isn't applied here",
      `Typo.other: @skipGuards("nope") skips a guard that isn't applied here`,
    ]);
  });
});
