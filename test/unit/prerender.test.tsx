import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get, header, param, prerender, query, resetManifest, route, yerd, type LayoutProps } from "@toyz/yerd";
import { createAuth } from "@toyz/yerd/auth";

const dirs: string[] = [];
function outDir() {
  const dir = mkdtempSync(join(tmpdir(), "yerd-prerender-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".vite"));
  writeFileSync(join(dir, ".vite", "manifest.json"), "{}");
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  resetManifest();
});

const Root = ({ children, meta }: LayoutProps) => <html><head><title>{meta.title}</title></head><body>{children}</body></html>;

let aboutRenders = 0;

@prerender
@route("/about", { meta: { title: "About" } })
class About {
  @get page() {
    aboutRenders++;
    return <h1>about</h1>;
  }
}

@prerender
@route("/config.json")
class Config {
  @get json() {
    return { name: "app", flags: ["a"] };
  }
}

@prerender({ paths: ["/docs/intro", "/docs/setup"] })
@route("/docs/:slug")
class Doc {
  @param("slug") accessor slug!: string;
  @get page() {
    return <article>{this.slug}</article>;
  }
}

@route("/dynamic")
class Dynamic {
  @get page() {
    return "not prerendered";
  }
}

describe("app.prerender", () => {
  it("writes HTML as index.html, JSON at its path, and param routes per listed path", async () => {
    const dir = outDir();
    const app = yerd({ routes: [About, Config, Doc, Dynamic], services: [], handleSignals: false }).layout(Root);
    const written = await app.prerender(dir);
    expect(written).toEqual(["/about", "/config.json", "/docs/intro", "/docs/setup"]);
    expect(readFileSync(join(dir, "about/index.html"), "utf8")).toBe(
      "<!doctype html><html><head><title>About</title></head><body><h1>about</h1></body></html>",
    );
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).toEqual({ name: "app", flags: ["a"] });
    expect(readFileSync(join(dir, "docs/setup/index.html"), "utf8")).toContain("<article>setup</article>");
    expect(existsSync(join(dir, "dynamic"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, ".yerd/prerendered.json"), "utf8"))).toEqual({
      "/about": "about/index.html",
      "/config.json": "config.json",
      "/docs/intro": "docs/intro/index.html",
      "/docs/setup": "docs/setup/index.html",
    });

    // Production: prerendered paths come from the files; the handler doesn't run.
    aboutRenders = 0;
    const server = await yerd({ routes: [About, Config, Doc, Dynamic], services: [], handleSignals: false })
      .layout(Root)
      .clientBuild(dir, join(dir, ".vite", "manifest.json"))
      .listen(0, "127.0.0.1");
    try {
      expect(await (await fetch(server.url + "/about")).text()).toContain("<h1>about</h1>");
      const config = await fetch(server.url + "/config.json");
      expect(config.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(aboutRenders).toBe(0);
      expect(await (await fetch(server.url + "/dynamic")).text()).toBe("not prerendered");
    } finally {
      await server.close();
    }
  });
});

describe("prerender refuses request-dependent routes", () => {
  async function failure(routes: Function[], configure?: (app: ReturnType<typeof yerd>) => void): Promise<string> {
    const app = yerd({ routes, services: [], handleSignals: false });
    configure?.(app);
    const error = await app.prerender(outDir()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }

  it("reading the query string", async () => {
    @prerender
    @route("/search")
    class Search {
      @query("q") accessor q: string | undefined;
      @get page() {
        return <p>{this.q}</p>;
      }
    }
    expect(await failure([Search])).toBe(
      "@prerender Search /search: HTTP 500: the query string is request data, and Search is prerendered at build time, when there is no request",
    );
  });

  it("reading a header", async () => {
    @prerender
    @route("/hdr.json")
    class Hdr {
      @header("user-agent") accessor ua: string | undefined;
      @get json() {
        return { ua: this.ua ?? null };
      }
    }
    expect(await failure([Hdr])).toMatch(/headers is request data/);
  });

  it("a signed-in-only route", async () => {
    const auth = createAuth<{ id: string }>({ load: () => undefined });
    @prerender
    @route("/account", { guards: [auth.required] })
    class Account {
      @get page() {
        return <p>secret</p>;
      }
    }
    expect(await failure([Account], (app) => app.sessions().use(auth))).toMatch(/can't be prerendered/);
  });

  it("non-HTML output without a file extension", async () => {
    @prerender
    @route("/data")
    class Data {
      @get json() {
        return { a: 1 };
      }
    }
    expect(await failure([Data])).toMatch(/needs a file extension/);
  });

  it("a param route without paths", async () => {
    @prerender
    @route("/u/:id")
    class User {
      @get page() {
        return <p />;
      }
    }
    expect(await failure([User])).toMatch(/has params, so it needs \{ paths/);
  });
});
