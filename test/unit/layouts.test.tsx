import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BootError, HttpError, accepts, createGuard, get, group, layout, noLayout, param, res, route, setMeta, yerd,
  type ErrorPageProps, type LayoutProps, type RunningServer,
} from "@toyz/yerd";

function Root({ children, meta }: LayoutProps) {
  return (
    <html>
      <head><title>{meta.title ?? "site"}</title></head>
      <body data-section={meta.section as string | undefined}>{children}</body>
    </html>
  );
}
const Shell = ({ children }: LayoutProps) => <main class="shell">{children}</main>;
const Admin = ({ children, meta }: LayoutProps) => <section class="admin" data-who={meta.who as string}>{children}</section>;
const Card = ({ children }: LayoutProps) => <article class="card">{children}</article>;

@group("/app", { layout: Shell, meta: { section: "app" } })
class AppGroup {}

@group("/admin", { group: AppGroup, layout: Admin, meta: { section: "admin", who: "staff" } })
class AdminGroup {}

@route("/", { group: AppGroup, meta: { title: "Dashboard" } })
class Dashboard {
  @get show() {
    return <h1>dash</h1>;
  }
}

@route("/users/:id", { group: AdminGroup, meta: { title: "User" } })
@layout(Card)
class AdminUser {
  @param("id") accessor id!: string;
  @get show() {
    setMeta({ title: `User ${this.id}` });
    return <p>{this.id}</p>;
  }
}

@route("/fragment", { group: AppGroup })
class Fragment {
  @get @noLayout piece() {
    return <li>just me</li>;
  }
}

@route("/explode")
class Explode {
  @get boom(): never {
    throw new HttpError(418, "short and stout");
  }
}

class DatabaseDown extends Error {}

@route("/crash")
class Crash {
  @get boom(): never {
    throw new DatabaseDown("password=hunter2 rejected");
  }
}

const shown: unknown[] = [];

function ErrorPage({ status, message, error }: ErrorPageProps) {
  shown.push(error);
  return <div class="error"><b>{status}</b> {message}</div>;
}

let server: RunningServer;
beforeAll(async () => {
  server = await yerd({ routes: [Dashboard, AdminUser, Fragment, Explode, Crash], services: [], handleSignals: false })
    .layout(Root)
    .errorPage(ErrorPage)
    .listen(0, "127.0.0.1");
});
afterAll(() => server.close());

const page = (path: string, accept = "text/html") => fetch(server.url + path, { headers: { accept } });

describe("layouts", () => {
  it("serves a group's index route at the group prefix, inside root and group layouts", async () => {
    expect(await (await page("/app")).text()).toBe(
      '<!doctype html><html><head><title>Dashboard</title></head><body data-section="app"><main class="shell"><h1>dash</h1></main></body></html>',
    );
  });

  it("nests groups: prefixes join, layouts nest root > group > subgroup > route, meta merges deeper-wins", async () => {
    expect(await (await page("/app/admin/users/7")).text()).toBe(
      '<!doctype html><html><head><title>User 7</title></head><body data-section="admin">' +
        '<main class="shell"><section class="admin" data-who="staff"><article class="card"><p>7</p></article></section></main></body></html>',
    );
  });

  it("@noLayout skips every layout", async () => {
    expect(await (await page("/app/fragment")).text()).toBe("<li>just me</li>");
  });

  it("renders errors in the error page inside root layouts for browsers", async () => {
    const r = await page("/explode");
    expect(r.status).toBe(418);
    expect(await r.text()).toBe(
      '<!doctype html><html><head><title>short and stout</title></head><body><div class="error"><b>418</b> short and stout</div></body></html>',
    );
    const missing = await page("/nope");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("<b>404</b> Not Found");
  });

  it("hands the error page what was thrown, while its message stays safe", async () => {
    shown.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await page("/crash");
    expect(r.status).toBe(500);
    const html = await r.text();
    expect(html).toContain("<b>500</b> Internal Server Error");
    expect(html).not.toContain("hunter2");
    expect(shown).toHaveLength(1);
    expect(shown[0]).toBeInstanceOf(DatabaseDown);
    await page("/explode");
    expect(shown[1]).toBeInstanceOf(HttpError);
    expect((shown[1] as HttpError).status).toBe(418);
  });

  it("keeps plain errors for API clients", async () => {
    const r = await page("/explode", "application/json");
    expect(await r.text()).toBe("short and stout");
  });
});

describe("group boot checks", () => {
  it("refuses a group reference without @group", async () => {
    class NotAGroup {}
    @route("/x", { group: NotAGroup })
    class Orphan {
      @get g() {
        return 1;
      }
    }
    const error = (await yerd({ routes: [Orphan], services: [] }).boot().catch((e: unknown) => e)) as BootError;
    expect(error.problems[0]).toMatch(/NotAGroup is used as a group but has no @group decorator/);
  });
});

describe("opting out of inherited layouts", () => {
  const AdminDocument = ({ children, meta }: LayoutProps) => (
    <html data-admin>
      <head><title>admin: {meta.title}</title></head>
      <body>{children}</body>
    </html>
  );
  const AdminNav = ({ children }: LayoutProps) => <div class="admin-nav">{children}</div>;
  const Print = ({ children }: LayoutProps) => <pre>{children}</pre>;

  @group("/admin", { layout: AdminDocument, inheritLayouts: false })
  class AdminArea {}

  @group("/reports", { group: AdminArea, layout: AdminNav })
  class Reports {}

  @route("/q3", { group: Reports, meta: { title: "Q3" } })
  class Q3 {
    @get show() {
      return <h1>Q3</h1>;
    }
  }

  @route("/print", { group: AppGroup })
  @layout(Print, { inherit: false })
  class PrintView {
    @get show() {
      return <b>plain</b>;
    }
  }

  it("a group with inheritLayouts: false replaces the root and outer layouts; inner groups still nest", async () => {
    const own = await yerd({ routes: [Q3, PrintView], services: [], handleSignals: false }).layout(Root).listen(0, "127.0.0.1");
    try {
      expect(await (await fetch(own.url + "/admin/reports/q3")).text()).toBe(
        '<!doctype html><html data-admin><head><title>admin: Q3</title></head><body><div class="admin-nav"><h1>Q3</h1></div></body></html>',
      );
    } finally {
      await own.close();
    }
  });

  it("@layout(X, { inherit: false }) makes X the whole chain for one route", async () => {
    const own = await yerd({ routes: [PrintView], services: [], handleSignals: false }).layout(Root).listen(0, "127.0.0.1");
    try {
      // Not wrapped in Root (no doctype/html) and not in the App group's Shell.
      expect(await (await fetch(own.url + "/app/print")).text()).toBe("<pre><b>plain</b></pre>");
    } finally {
      await own.close();
    }
  });
});

describe("layouts anywhere", () => {
  const Marketing = ({ children }: LayoutProps) => <div class="marketing">{children}</div>;
  const Hero = ({ children }: LayoutProps) => <header class="hero">{children}</header>;
  const Print = ({ children }: LayoutProps) => <pre>{children}</pre>;
  const Receipt = ({ children }: LayoutProps) => <div class="receipt">{children}</div>;
  const Docs = ({ children }: LayoutProps) => <nav class="docs">{children}</nav>;
  const closed = createGuard("closed", () => false);

  // Several layouts in one decorator, outermost first; Root is the app's
  // already, so naming it doesn't wrap twice.
  @route("/about")
  @layout(Root, Marketing, Hero)
  class About {
    @get show() {
      return <p>about</p>;
    }
  }

  // On a handler method: innermost, after the class's; or its whole chain.
  @route("/team")
  @layout(Marketing, Hero)
  class Team {
    @get @layout(Card) show() {
      return <p>team</p>;
    }

    @get @accepts("text/plain") @layout(Print, { inherit: false }) print() {
      return <p>print</p>;
    }
  }

  // Chosen at return time.
  @route("/receipt")
  @layout(Marketing, Hero)
  class ReceiptPage {
    @get show() {
      return res(<p>paid</p>, { layout: Receipt, status: 201 });
    }
  }

  @route("/receipt-only")
  @layout(Marketing)
  class ReceiptOnly {
    @get show() {
      return res(<p>paid</p>, { layout: [Print, Receipt], inherit: false });
    }
  }

  // @layout and @guards written on the group class count (they used to be ignored).
  @group("/docs")
  @layout(Docs)
  class DocsGroup {}

  @group("/locked")
  @closed
  class Locked {}

  @route("/", { group: DocsGroup })
  class DocsIndex {
    @get show() {
      return <p>docs</p>;
    }
  }

  @route("/", { group: Locked })
  class LockedIndex {
    @get show() {
      return <p>secret</p>;
    }
  }

  // Stacked decorators read top to bottom.
  @route("/stacked")
  @layout(Marketing)
  @layout(Hero)
  class Stacked {
    @get show() {
      return <i>x</i>;
    }
  }

  let own: RunningServer;
  beforeAll(async () => {
    own = await yerd({ routes: [About, Team, ReceiptPage, ReceiptOnly, DocsIndex, LockedIndex, Stacked], services: [], handleSignals: false }).layout(Root).listen(0, "127.0.0.1");
  });
  afterAll(() => own.close());
  const page = async (path: string) => (await fetch(own.url + path)).text();
  const doc = (body: string) => `<!doctype html><html><head><title>site</title></head><body>${body}</body></html>`;

  it("takes several layouts at once, without repeating the app's", async () => {
    expect(await page("/about")).toBe(doc('<div class="marketing"><header class="hero"><p>about</p></header></div>'));
  });

  it("goes on a handler method, innermost, or as its whole chain", async () => {
    expect(await page("/team")).toBe(doc('<div class="marketing"><header class="hero"><article class="card"><p>team</p></article></header></div>'));
    const print = await fetch(own.url + "/team", { headers: { accept: "text/plain" } });
    expect(await print.text()).toBe("<pre><p>print</p></pre>");
  });

  it("is chosen per response with res()", async () => {
    const r = await fetch(own.url + "/receipt");
    expect(r.status).toBe(201);
    expect(await r.text()).toBe(doc('<div class="marketing"><header class="hero"><div class="receipt"><p>paid</p></div></header></div>'));
    expect(await page("/receipt-only")).toBe('<pre><div class="receipt"><p>paid</p></div></pre>');
  });

  it("is honoured on a @group class, as are @guards there", async () => {
    expect(await page("/docs")).toBe(doc('<nav class="docs"><p>docs</p></nav>'));
    expect((await fetch(own.url + "/locked")).status).toBe(403);
  });

  it("stacks top to bottom", async () => {
    expect(await page("/stacked")).toBe(doc('<div class="marketing"><header class="hero"><i>x</i></header></div>'));
  });
});
