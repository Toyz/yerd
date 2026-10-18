import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Dynamic, cookie, currentContext, get, isBot, param, prerender, redirect, resetManifest, route, yerd, type LayoutProps,
} from "@toyz/yerd";

const dirs: string[] = [];
function outDir() {
  const base = mkdtempSync(join(tmpdir(), "yerd-edge-prerender-"));
  dirs.push(base);
  // The build directory sits one level down, so a write that escapes it is visible.
  const dir = join(base, "dist");
  mkdirSync(join(dir, ".vite"), { recursive: true });
  writeFileSync(join(dir, ".vite", "manifest.json"), "{}");
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  resetManifest();
});

const Root = ({ children }: LayoutProps) => <html><body>{children}</body></html>;

async function build(routes: Function[], dir = outDir()) {
  const app = yerd({ routes, services: [], handleSignals: false }).layout(Root);
  return { dir, written: await app.prerender(dir) };
}

async function failure(routes: Function[]): Promise<string> {
  const error = await yerd({ routes, services: [], handleSignals: false }).prerender(outDir()).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
}

describe("prerender paths", () => {
  it("writes / as index.html and a splat path as nested directories", async () => {
    @prerender @route("/") class Home { @get page() { return <h1>home</h1>; } }
    @prerender({ paths: ["/files/a/b", "/files"] }) @route("/files/*path")
    class Files {
      @param("path") accessor path!: string;
      @get page() { return <p>[{this.path}]</p>; }
    }
    const { dir, written } = await build([Home, Files]);
    expect(written).toEqual(["/", "/files/a/b", "/files"]);
    expect(readFileSync(join(dir, "index.html"), "utf8")).toContain("<h1>home</h1>");
    expect(readFileSync(join(dir, "files/a/b/index.html"), "utf8")).toContain("<p>[a/b]</p>");
    expect(readFileSync(join(dir, "files/index.html"), "utf8")).toContain("<p>[]</p>");
  });

  it("takes paths from an async function", async () => {
    @prerender({ paths: async () => ["/p/one", "/p/two"] }) @route("/p/:id")
    class P {
      @param("id") accessor id!: string;
      @get page() { return <p>{this.id}</p>; }
    }
    expect((await build([P])).written).toEqual(["/p/one", "/p/two"]);
  });

  it("a param route without paths is refused", async () => {
    @prerender @route("/needs/:id") class Needs { @get page() { return <p />; } }
    expect(await failure([Needs])).toBe("@prerender Needs: /needs/:id has params, so it needs { paths: [...] }");
  });

  it("a path for another route is refused", async () => {
    @prerender({ paths: ["/other"] }) @route("/mine/:id") class Mine { @get page() { return <p />; } }
    @route("/other") class Other { @get page() { return <p />; } }
    expect(await failure([Mine, Other])).toBe("@prerender Mine: /other doesn't match /mine/:id");
  });

  it.each([
    ["/docs/..", /isn't a plain path/],
    ["/docs/.", /isn't a plain path/],
    ["/docs/%2e%2e", /isn't a plain path/],
    ["/docs/%2E.", /isn't a plain path/],
    ["/docs/a?x=1", /isn't a plain path/],
    ["/docs/a#frag", /isn't a plain path/],
    ["docs/a", /isn't a plain path/],
  ])("path %j is refused before anything is fetched or written", async (path, message) => {
    @route("/") class Home { @get page() { return <h1>home</h1>; } }
    @prerender({ paths: [path] }) @route("/docs/:slug")
    class Doc {
      @param("slug") accessor slug!: string;
      @get page() { return <p>{this.slug}</p>; }
    }
    const dir = outDir();
    const error = await yerd({ routes: [Home, Doc], services: [], handleSignals: false }).prerender(dir).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(message);
    expect(existsSync(join(dir, "index.html"))).toBe(false);
  });

  it("a splat path can't climb out of the build directory", async () => {
    @route("/*rest") class CatchAll { @get page() { return <p>catch-all</p>; } }
    @prerender({ paths: ["/blog/../../escaped"] }) @route("/blog/*slug")
    class Blog {
      @param("slug") accessor slug!: string;
      @get page() { return <p>{this.slug}</p>; }
    }
    const dir = outDir();
    const error = await yerd({ routes: [CatchAll, Blog], services: [], handleSignals: false }).prerender(dir).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/isn't a plain path/);
    expect(readdirSync(join(dir, ".."))).toEqual(["dist"]);
  });
});

describe("prerender refuses what it can't freeze", () => {
  it("a redirect", async () => {
    @prerender @route("/moved") class Moved { @get page() { return redirect("/elsewhere"); } }
    expect(await failure([Moved])).toBe("@prerender Moved /moved: HTTP 303: redirects to /elsewhere");
  });

  it("a non-200 status", async () => {
    @prerender @route("/gone") class Gone { @get page() { return 410; } }
    expect(await failure([Gone])).toBe("@prerender Gone /gone: HTTP 410: ");
  });

  it("non-HTML without an extension", async () => {
    @prerender @route("/data") class Data { @get page() { return { a: 1 }; } }
    expect(await failure([Data])).toMatch(/non-HTML output needs a file extension in the path/);
  });

  it.each([
    ["cookies", () => currentContext().cookies, /cookies is request data/],
    ["the request", () => currentContext().request, /the request is request data/],
    ["the body", () => currentContext().body(), /the body is request data/],
    ["the session", () => currentContext().session, /the session is request data/],
  ])("reading %s", async (_what, read, message) => {
    @prerender @route("/reads") class Reads {
      @get async page() {
        await read();
        return <p />;
      }
    }
    expect(await failure([Reads])).toMatch(message);
  });

  it("a cookie accessor", async () => {
    @prerender @route("/theme") class Theme {
      @cookie("theme") accessor theme: string | undefined;
      @get page() { return <p>{this.theme}</p>; }
    }
    expect(await failure([Theme])).toMatch(/cookies is request data/);
  });

  it("params and the path are fine: they're part of the URL", async () => {
    @prerender({ paths: ["/hello/world"] }) @route("/hello/:who") class Hello {
      @get page() {
        const ctx = currentContext();
        return <p>{ctx.params.who} {ctx.path} {ctx.route.pattern} {String(ctx.prerendering)}</p>;
      }
    }
    const { dir } = await build([Hello]);
    expect(readFileSync(join(dir, "hello/world/index.html"), "utf8")).toContain("<p>world /hello/world /hello/:who true</p>");
  });
});

describe("prerender with variants and dynamic parts", () => {
  it("renders the plain handler, not a @get(when) variant", async () => {
    @prerender @route("/product") class Product {
      @get page() { return <p>people</p>; }
      @get(isBot) crawlable() { return <p>crawler</p>; }
    }
    const { dir } = await build([Product]);
    expect(readFileSync(join(dir, "product/index.html"), "utf8")).toContain("<p>people</p>");
  });

  it("renders <Dynamic> parts as their fallback", async () => {
    @prerender @route("/dash") class Dash {
      @get page() {
        return <main><Dynamic id="live" fallback={<i>loading</i>}>{() => <b>live</b>}</Dynamic></main>;
      }
    }
    const { dir } = await build([Dash]);
    const html = readFileSync(join(dir, "dash/index.html"), "utf8");
    expect(html).toContain("<i>loading</i>");
    expect(html).not.toContain("<b>live</b>");
  });
});
