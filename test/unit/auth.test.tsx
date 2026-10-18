import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ActionForm, BootError, HttpError, action, createGuard, get, group, guard, guards, route, service, yerd,
  type RunningServer, type YerdContext,
} from "@toyz/yerd";
import { createAuth, hashPassword, safeNext, verifyPassword } from "@toyz/yerd/auth";

interface User {
  id: string;
  name: string;
  roles: string[];
  passwordHash: string;
}

const users = new Map<string, User>();

const auth = createAuth<User>({
  load: (id) => users.get(id),
  roles: (u) => u.roles,
  loginPath: "/login",
});

// A second kind of sign-in in the same app: it needs its own session key.
const admins = createAuth<User>({
  load: (id) => users.get(id),
  loginPath: "/admin-login",
  sessionKey: "admin_uid",
});

@route("/console", { guards: [admins.required] })
class Console {
  @get show() {
    return "console";
  }
}

const order: string[] = [];

@service
class Tracer {
  @guard("trace") note(ctx: YerdContext) {
    order.push(`named:${ctx.path}`);
    return true;
  }
}

const tag = (label: string) =>
  createGuard(label, () => {
    order.push(label);
  });

@group("/admin", { guards: [tag("group"), auth.required] })
class Admin {}

@route("/login")
class Login {
  @get page() {
    return <form action={this.submit} />;
  }
  @action async submit(_: {}, form: ActionForm) {
    const user = [...users.values()].find((u) => u.name === form.string("name"));
    if (!(await verifyPassword(form.string("password"), user?.passwordHash))) throw new HttpError(401, "Wrong name or password");
    auth.login(user!);
  }
}

@route("/me")
class Me {
  @auth.maybeUser accessor me: User | undefined;
  @get show() {
    return { name: this.me?.name ?? null };
  }
}

@route("/", { group: Admin, guards: [tag("route"), "trace"] })
@tag("class")
class Dashboard {
  @auth.user accessor me!: User;
  @get show() {
    return { hello: this.me.name };
  }
}

@route("/stuff", { group: Admin })
class AdminStuff {
  @get @guards(auth.role("admin")) list() {
    return ["secret stuff"];
  }
  @action wipe() {
    return "wiped";
  }
}

/** Not guarded itself, so tests can fetch a signed token for AdminStuff.wipe. */
@route("/wipe-form")
class WipeForm {
  @get show() {
    return <form action={new AdminStuff().wipe} />;
  }
}

@route("/blocked")
class Blocked {
  @get @guards(createGuard("nope", () => false)) show() {
    return "never";
  }
}

@route("/logout")
class Logout {
  @get page() {
    return <form action={this.out} />;
  }
  @action out() {
    auth.logout();
  }
}

let server: RunningServer;
beforeAll(async () => {
  users.set("1", { id: "1", name: "ada", roles: ["admin"], passwordHash: await hashPassword("correct horse") });
  users.set("2", { id: "2", name: "bob", roles: [], passwordHash: await hashPassword("hunter22") });
  server = await yerd({
    routes: [Login, Me, Dashboard, AdminStuff, WipeForm, Blocked, Logout, Console],
    services: [Tracer],
    handleSignals: false,
    secret: "k".repeat(32),
  })
    .sessions()
    .use(auth)
    .use(admins)
    .listen(0, "127.0.0.1");
});
afterAll(() => server.close());

/** fetch with a cookie jar; redirects aren't followed so tests can see them. */
function client() {
  let jar = "";
  return async (path: string, init: RequestInit = {}) => {
    const r = await fetch(server.url + path, { redirect: "manual", ...init, headers: { cookie: jar, ...(init.headers as object) } });
    for (const c of r.headers.getSetCookie()) jar = /Max-Age=0/.test(c) ? "" : c.split(";")[0]!;
    return r;
  };
}

/** An action token from a page, fetched with the same cookie jar as the post (tokens are bound to the session). */
async function tokenFrom(path: string, c: ReturnType<typeof client>): Promise<string> {
  const html = await (await c(path)).text();
  return /name="_yx" value="([^"]+)"/.exec(html)![1]!;
}

async function loginAs(name: string, password: string) {
  const c = client();
  const r = await c("/login", {
    method: "POST",
    body: new URLSearchParams({ _yx: await tokenFrom("/login", c), name, password }),
    headers: { yx: "1" },
  });
  return { c, r };
}

describe("passwords", () => {
  it("hashes with argon2id and verifies", async () => {
    const hash = await hashPassword("pw");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword("pw", hash)).toBe(true);
    expect(await verifyPassword("nope", hash)).toBe(false);
  });

  it("spends a real hash on unknown users", async () => {
    await verifyPassword("warm up", undefined);
    const t = performance.now();
    expect(await verifyPassword("x", undefined)).toBe(false);
    expect(performance.now() - t).toBeGreaterThan(3);
  });
});

describe("safeNext", () => {
  it("allows same-site paths only", () => {
    expect(safeNext("/todos?x=1")).toBe("/todos?x=1");
    for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "", null]) expect(safeNext(bad)).toBe("/");
  });

  it("refuses paths a browser would turn into another origin", () => {
    // Browsers strip tabs and newlines and read "\\" as "/": these are "//evil.com" to them.
    for (const bad of ["/\t/evil.com", "/\n/evil.com", "/\r\n/evil.com", "/\\/evil.com", "\t//evil.com"]) expect(safeNext(bad)).toBe("/");
    // Still a path on this site once parsed (the slashes stay encoded).
    expect(safeNext("/%2F%2Fevil.com")).toBe("/%2F%2Fevil.com");
    expect(safeNext("/a/../b#top")).toBe("/b#top");
  });
});

describe("createAuth session keys", () => {
  it("refuses a second auth on the default key, or a reused key", () => {
    expect(() => createAuth<User>({ load: () => undefined })).toThrow(/pass a distinct `sessionKey`/);
    expect(() => createAuth<User>({ load: () => undefined, sessionKey: "admin_uid" })).toThrow(/already used/);
  });

  it("keeps two auths apart: signing in as a user doesn't pass the other's guard", async () => {
    const { c } = await loginAs("ada", "correct horse");
    expect(await (await c("/me")).json()).toEqual({ name: "ada" });
    const r = await c("/console", { headers: { accept: "text/html" } });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/admin-login?next=%2Fconsole");
  });

  it("says plainly when sessions are off", async () => {
    const ctx = {
      prerendering: false,
      route: { pattern: "/", paramNames: [], className: "Home" },
      get session(): never {
        throw new Error("Sessions are off; call app.sessions() to turn them on");
      },
    } as unknown as YerdContext;
    await expect(admins.middleware(ctx, () => Promise.resolve(undefined as never))).rejects.toThrow(/createAuth needs sessions: call app.sessions\(\)/);
  });
});

describe("guards and auth", () => {
  it("sends browsers to login with next=, and APIs a 401", async () => {
    const page = await fetch(server.url + "/admin?tab=1", { redirect: "manual", headers: { accept: "text/html" } });
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/login?next=%2Fadmin%3Ftab%3D1");
    const api = await fetch(server.url + "/admin", { headers: { accept: "application/json" } });
    expect(api.status).toBe(401);
  });

  it("logs in and lets the user through; guards run app, group, route, class, method", async () => {
    const { c, r } = await loginAs("ada", "correct horse");
    expect(r.status).toBe(204);
    expect(await (await c("/me")).json()).toEqual({ name: "ada" });
    order.length = 0;
    expect(await (await c("/admin")).json()).toEqual({ hello: "ada" });
    expect(order).toEqual(["group", "route", "named:/admin", "class"]);
  });

  it("rejects wrong passwords without signing in", async () => {
    const { c, r } = await loginAs("ada", "wrong");
    expect(r.status).toBe(401);
    expect(await (await c("/me")).json()).toEqual({ name: null });
  });

  it("checks roles", async () => {
    const ada = await loginAs("ada", "correct horse");
    expect(await (await ada.c("/admin/stuff")).json()).toEqual(["secret stuff"]);
    const bob = await loginAs("bob", "hunter22");
    expect((await bob.c("/admin/stuff")).status).toBe(403);
  });

  it("guards actions too: a scripted post gets the login page as yx-location", async () => {
    const c = client();
    const r = await c("/admin/stuff", {
      method: "POST",
      body: new URLSearchParams({ _yx: await tokenFrom("/wipe-form", c) }),
      headers: { yx: "1", accept: "text/html" },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("yx-location")).toBe("/login?next=%2Fadmin%2Fstuff");
  });

  it("answers 403 for a guard returning false", async () => {
    expect((await fetch(server.url + "/blocked")).status).toBe(403);
  });

  it("logs out by destroying the session", async () => {
    const { c } = await loginAs("ada", "correct horse");
    await c("/logout", { method: "POST", body: new URLSearchParams({ _yx: await tokenFrom("/logout", c) }), headers: { yx: "1" } });
    expect(await (await c("/me")).json()).toEqual({ name: null });
  });
});

describe("guard boot checks", () => {
  it("refuses unknown guard names; a @guard outside this app's services only matters if referenced", async () => {
    @route("/x", { guards: ["missing"] })
    class Needs {
      @get g() {
        return 1;
      }
    }
    class NotAService {
      @guard("orphan") check() {
        return true;
      }
    }
    void NotAService;
    const error = (await yerd({ routes: [Needs], services: [Tracer] }).boot().catch((e: unknown) => e)) as BootError;
    expect(error.problems).toEqual(['Needs.g: unknown guard "missing"']);

    @route("/y", { guards: ["orphan"] })
    class NeedsOrphan {
      @get g() {
        return 1;
      }
    }
    const orphan = (await yerd({ routes: [NeedsOrphan], services: [Tracer] }).boot().catch((e: unknown) => e)) as BootError;
    expect(orphan.problems).toEqual(['NeedsOrphan.g: unknown guard "orphan" (its @guard class isn\'t one of this app\'s services)']);
  });
});
