import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Local, RUNTIME_PATH, Scripts, Styles, action, css, get, renderToString, route, type RunningServer } from "@toyz/yerd";
import { rawGet, serve } from "./edge-routing-helpers.js";

const hint = (name: string) => `<link rel="modulepreload" href="/_yerd/runtime-${name}.js">`;

function Page({ children }: { children?: unknown }) {
  return (
    <html>
      <head>
        <Scripts />
      </head>
      <body>{children as never}</body>
    </html>
  );
}

describe("<Scripts /> preload hints", () => {
  it("are left out when the page uses no chunk", async () => {
    const html = await renderToString(<Page><p>plain</p></Page>, { document: true });
    expect(html).toContain(`<script type="module" src="${RUNTIME_PATH}"></script></head>`);
    expect(html).not.toContain("modulepreload");
  });

  it("name just the chunks the page's elements need, right after the script", async () => {
    const local = await renderToString(<Page><Local state={{ n: 0 }}>{(s) => <b>{s.n}</b>}</Local></Page>);
    expect(local).toContain(`src="${RUNTIME_PATH}"></script>${hint("local")}</head>`);
    expect(local).not.toContain("runtime-dnd");

    const both = await renderToString(
      <Page>
        <div sync>spin</div>
        <div dropTo="#files">drop here</div>
        <input id="files" type="file" />
      </Page>,
    );
    expect(both).toContain(`></script>${hint("cues")}${hint("dnd")}</head>`);
    expect(both).not.toContain("runtime-local");

    const cue = await renderToString(<Page><div cue="ding">!</div></Page>);
    expect(cue).toContain(`></script>${hint("cues")}</head>`);
  });

  it("keep their place next to <Styles /> rules in the head", async () => {
    const box = css`color: red;`;
    for (const head of [
      <head><Styles /><Scripts /></head>,
      <head><Scripts /><Styles /></head>,
    ]) {
      const html = await renderToString(<html>{head}<body><div class={box}><Local state={{ n: 0 }}>{(s) => <i>{s.n}</i>}</Local></div></body></html>);
      const headHtml = html.slice(0, html.indexOf("</head>"));
      expect(headHtml).toContain(`></script>${hint("local")}`);
      expect(headHtml).toMatch(/<style data-yx-css="[^"]+">[^<]*color: ?red/);
      expect(html.indexOf("<body>")).toBeGreaterThan(headHtml.length);
    }
  });

  it("can't name what renders after the head has gone out; the runtime loads that itself", async () => {
    async function Later() {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return <Local state={{ n: 0 }}>{(s) => <i>{s.n}</i>}</Local>;
    }
    const html = await renderToString(<Page><Later /></Page>);
    expect(html).toContain("<yerd-local");
    expect(html).not.toContain("modulepreload");
  });
});

@route("/board")
class Board {
  @get page() {
    return (
      <Page>
        <ul action={this.move} trigger="drop">
          <li draggable>card</li>
        </ul>
      </Page>
    );
  }

  @action move() {}
}

describe("the chunk endpoints", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await serve([Board]);
  });
  afterAll(() => server.close());

  it("a page with a drop target asks for the dnd chunk", async () => {
    const html = await (await fetch(server.url + "/board")).text();
    expect(html).toContain(hint("dnd"));
  });

  it.each(["cues", "dnd", "local"])("serve the %s chunk as a module, like the core: compressed, with an ETag, revalidated", async (name) => {
    const path = `/_yerd/runtime-${name}.js`;
    const plain = await fetch(server.url + path, { headers: { "accept-encoding": "identity" } });
    expect(plain.status).toBe(200);
    expect(plain.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(plain.headers.get("cache-control")).toBe("no-cache");
    expect(plain.headers.get("vary")).toBe("accept-encoding");
    const etag = plain.headers.get("etag")!;
    expect(etag).toMatch(/^"[\w-]{16}"$/);
    expect((await plain.text()).startsWith("export default function")).toBe(true);
    const br = await rawGet(server.url, path, "Accept-Encoding: br\r\n");
    expect(br.headers["content-encoding"]).toBe("br");
    const gzip = await rawGet(server.url, path, "Accept-Encoding: gzip\r\n");
    expect(gzip.headers["content-encoding"]).toBe("gzip");
    const again = await rawGet(server.url, path, `If-None-Match: ${etag}\r\n`);
    expect(again.status).toBe(304);
    expect(again.body).toBe("");
    const head = await fetch(server.url + path, { method: "HEAD", headers: { "accept-encoding": "identity" } });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get("content-length"))).toBeGreaterThan(500);
    expect(await head.text()).toBe("");
  });

  it("each chunk has its own ETag, and the core's differs from them", async () => {
    const tags = await Promise.all([RUNTIME_PATH, "/_yerd/runtime-cues.js", "/_yerd/runtime-dnd.js", "/_yerd/runtime-local.js"].map(async (path) => (await fetch(server.url + path)).headers.get("etag")));
    expect(new Set(tags).size).toBe(4);
  });

  it("an unknown chunk name is a 404, for GET and HEAD alike", async () => {
    for (const path of ["/_yerd/runtime-nope.js", "/_yerd/runtime-.js", "/_yerd/runtime-toString.js", "/_yerd/runtime-dnd.js.map"]) {
      expect((await fetch(server.url + path)).status, path).toBe(404);
    }
    expect((await fetch(server.url + "/_yerd/runtime-nope.js", { method: "HEAD" })).status).toBe(404);
  });

  it("other methods are a 404 (no route lives there)", async () => {
    expect((await fetch(server.url + "/_yerd/runtime-dnd.js", { method: "POST" })).status).toBe(404);
  });

  it("the core is served split: it imports its chunks from beside itself", async () => {
    const core = await (await fetch(server.url + RUNTIME_PATH)).text();
    expect(core).toContain('new URL(".", import.meta.url).href');
    expect(core).not.toContain("function yerdLocal");
  });
});
