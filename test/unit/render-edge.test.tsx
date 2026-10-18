import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Dynamic, action, bind, createElement, get, json, raw, renderToString, route, yerd,
  type ActionForm, type Child, type RunningServer,
} from "@toyz/yerd";

describe("<script> and <style>", () => {
  it("writes text unescaped", async () => {
    expect(await renderToString(<style>{"a > b{color:red}"}</style>)).toBe("<style>a > b{color:red}</style>");
    expect(await renderToString(<script>{"if (a < b && c) go('x')"}</script>)).toBe("<script>if (a < b && c) go('x')</script>");
  });

  it("refuses text that could close the element", async () => {
    await expect(renderToString(<script>{"x = '</SCRIPT><b>'"}</script>)).rejects.toThrow(/<\/script/);
    await expect(renderToString(<script>{["x = '</scr", "ipt>'"]}</script>)).rejects.toThrow(/<\/script/);
    await expect(renderToString(<script>{"<!--"}</script>)).rejects.toThrow(/<!--/);
    await expect(renderToString(<style>{"</style><script>"}</style>)).rejects.toThrow(/<\/style/);
    await expect(renderToString(<script>{(<b />) as Child}</script>)).rejects.toThrow(/must be text/);
  });

  it("json() inlines data safely", async () => {
    const data = { html: "</script><!-- & -->", line: "a\u2028b\u2029c" };
    const html = await renderToString(<script type="application/json">{json(data)}</script>);
    expect(html).toBe(
      '<script type="application/json">{"html":"\\u003c/script\\u003e\\u003c!-- \\u0026 --\\u003e","line":"a\\u2028b\\u2029c"}</script>',
    );
    const inner = html.slice(html.indexOf(">") + 1, html.lastIndexOf("</script>"));
    expect(JSON.parse(inner)).toEqual(data);
  });
});

describe("createElement", () => {
  it("is what a key after a spread compiles to", async () => {
    const p = { id: "a" };
    expect(await renderToString(<div {...p} key="k">x</div>)).toBe('<div id="a" data-key="k">x</div>');
  });

  it("builds the same node as jsx()", () => {
    const node = createElement("ul", { key: 1, class: "c" }, "a", "b");
    expect(node.key).toBe(1);
    expect(node.props).toEqual({ class: "c", children: ["a", "b"] });
    expect(createElement("p", null, "x").props).toEqual({ children: "x" });
    expect(createElement("p", null).props).toEqual({});
  });
});

describe("attributes", () => {
  it("throws for function values other than event handlers", async () => {
    await expect(renderToString(<div title={(() => "x") as unknown as string} />)).rejects.toThrow(/Attribute title got a function/);
    expect(await renderToString(<div onclick={() => 1} />)).toBe("<div></div>");
  });

  it("writes aria-* and enumerated attributes as words", async () => {
    expect(await renderToString(<div aria-hidden={true} aria-expanded={false} />)).toBe('<div aria-hidden="true" aria-expanded="false"></div>');
    expect(await renderToString(<div draggable={false} spellcheck={true} contenteditable={false} translate={false} />)).toBe(
      '<div draggable="false" spellcheck="true" contenteditable="false" translate="no"></div>',
    );
    expect(await renderToString(<p translate={true} autocapitalize="words" />)).toBe('<p translate="yes" autocapitalize="words"></p>');
    // data-* stays boolean: bare when true, omitted when false.
    expect(await renderToString(<a data-yx-boost={true} data-off={false} />)).toBe("<a data-yx-boost></a>");
  });

  it("blocks script-running URL schemes", async () => {
    const blocked = "about:blank#blocked";
    for (const url of ["javascript:alert(1)", "  JavaScript:x", "java\tscr\nipt:x", "\x01javascript:x", "vbscript:x", "data:text/html,<b>"]) {
      expect(await renderToString(<a href={url}>x</a>)).toBe(`<a href="${blocked}">x</a>`);
    }
    expect(await renderToString(<form action="javascript:x" />)).toBe(`<form action="${blocked}"></form>`);
    expect(await renderToString(<button formaction="javascript:x" />)).toBe(`<button formaction="${blocked}"></button>`);
    expect(await renderToString(<iframe src="data:text/html,x" />)).toBe(`<iframe src="${blocked}"></iframe>`);
    // data:image/ is fine for src and poster, nowhere else.
    expect(await renderToString(<img src="data:image/png;base64,AAAA" />)).toBe('<img src="data:image/png;base64,AAAA">');
    expect(await renderToString(<video poster="DATA:image/gif,x" />)).toBe('<video poster="DATA:image/gif,x"></video>');
    expect(await renderToString(<a href="data:image/png,x" />)).toBe(`<a href="${blocked}"></a>`);
    // Ordinary URLs pass.
    expect(await renderToString(<a href="https://x.dev/a:b?q=1">x</a>)).toBe('<a href="https://x.dev/a:b?q=1">x</a>');
    expect(await renderToString(<a href="/a:b">x</a>)).toBe('<a href="/a:b">x</a>');
    expect(await renderToString(<a href="mailto:a@b.c">x</a>)).toBe('<a href="mailto:a@b.c">x</a>');
    // raw() opts out.
    expect(await renderToString(<a href={raw("javascript:void 0") as unknown as string}>x</a>)).toBe('<a href="javascript:void 0">x</a>');
  });

  it("validates style objects", async () => {
    expect(await renderToString(<div style={{ msTransform: "none", WebkitTransition: "none", width: 10 }} />)).toBe(
      '<div style="-ms-transform:none;-webkit-transition:none;width:10"></div>',
    );
    await expect(renderToString(<div style={{ color: "red;background:url(x)" }} />)).rejects.toThrow(/Invalid value for style color/);
    await expect(renderToString(<div style={{ color: "}body{" }} />)).rejects.toThrow(/Invalid value/);
    await expect(renderToString(<div style={{ "x:y": "1" }} />)).rejects.toThrow(/Invalid style property/);
  });

  it("merges class with className, and an explicit data-key wins over key", async () => {
    expect(await renderToString(<div class="a" className={["b", { c: true }]} />)).toBe('<div class="a b c"></div>');
    expect(await renderToString(<div className="b" class={null} />)).toBe('<div class="b"></div>');
    expect(await renderToString(<li key="k" data-key="mine" />)).toBe('<li data-key="mine"></li>');
  });

  it("renders URL and Date values, omits NaN", async () => {
    expect(await renderToString(<a href={new URL("https://x.dev/p") as unknown as string} />)).toBe('<a href="https://x.dev/p"></a>');
    expect(await renderToString(<a href={new URL("javascript:x") as unknown as string} />)).toBe('<a href="about:blank#blocked"></a>');
    expect(await renderToString(<time datetime={new Date(0) as unknown as string} />)).toBe('<time datetime="1970-01-01T00:00:00.000Z"></time>');
    expect(await renderToString(<input value={NaN} max={3} />)).toBe('<input max="3">');
  });
});

describe("elements", () => {
  it("tolerates empty children on void elements", async () => {
    for (const empty of [[], false, null, undefined, "", [null, [false]]]) {
      expect(await renderToString(<br>{empty as never}</br>)).toBe("<br>");
    }
    await expect(renderToString(<br>{[null, "x"] as never}</br>)).rejects.toThrow(/void element/);
  });

  it("explains a stack overflow from a deeply nested tree", async () => {
    let node: Child = "x";
    for (let i = 0; i < 50_000; i++) node = <div>{node}</div>;
    await expect(renderToString(node)).rejects.toThrow(/nested too deeply/);
  });

  it("doesn't build or sign tags outside <Dynamic> in only mode", async () => {
    let ran = false;
    const Outer = () => {
      ran = true;
      return <form action={(() => 1) as unknown as string}><Dynamic id="d">{() => <b>in</b>}</Dynamic></form>;
    };
    // The form's action would throw if it were rendered (not an @action).
    expect(await renderToString(<main><Outer /></main>, { dynamic: "only" })).toBe('<div id="d" data-yx-region><b>in</b></div>');
    expect(ran).toBe(true);
  });
});

describe("formaction={action}", () => {
  const removed: string[] = [];

  @route("/notes/:id")
  class Notes {
    @get page() {
      return (
        <form method="post" action="/elsewhere">
          <button formaction={bind(this.remove, { which: "a" })}>delete</button>
          <input type="submit" formaction={this.archive} />
        </form>
      );
    }

    @action remove({ which }: { which: string }, _form: ActionForm) {
      removed.push(which);
    }

    @action archive() {
      removed.push("archived");
    }
  }

  @route("/nested")
  class Nested {
    @get page() {
      return <form action={this.save}><input name="title" /><button>save</button><button formaction={this.drop}>drop</button></form>;
    }

    @action save() {
      removed.push("saved");
    }

    @action drop() {
      removed.push("dropped");
    }
  }

  let server: RunningServer;
  beforeAll(async () => {
    server = await yerd({ routes: [Notes, Nested], services: [], handleSignals: false, secret: "y".repeat(32) }).listen(0, "127.0.0.1");
  });
  afterAll(() => server.close());

  it("renders the button as the action's submitter and the server runs it", async () => {
    const html = await (await fetch(server.url + "/notes/7")).text();
    const match = html.match(
      /<button formaction="\/notes\/7" formmethod="post" name="_yx" value="([\w-]+\.[\w-]+)">delete<\/button><input type="submit" formaction="\/notes\/7" formmethod="post" name="_yx" value="[\w-]+\.[\w-]+">/,
    );
    expect(match).not.toBeNull();
    // What the browser posts when that button is the submitter.
    const response = await fetch(server.url + "/notes/7", {
      method: "POST",
      body: new URLSearchParams({ _yx: match![1]! }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(removed).toEqual(["a"]);
  });

  it("refuses a button with its own name or value, or a non-submit button", async () => {
    const archive = Notes.prototype.archive;
    await expect(renderToString(<button name="op" formaction={archive}>x</button>)).rejects.toThrow(/can't have its own name or value/);
    await expect(renderToString(<button value="1" formaction={archive}>x</button>)).rejects.toThrow(/can't have its own name or value/);
    await expect(renderToString(<button type="button" formaction={archive}>x</button>)).rejects.toThrow(/needs a submit button/);
    await expect(renderToString(<input type="text" formaction={archive} />)).rejects.toThrow(/needs a submit button/);
  });

  it("works inside an action form: the submitter's token comes last and wins", async () => {
    removed.length = 0;
    const html = await (await fetch(server.url + "/nested")).text();
    const [formToken, dropToken] = [...html.matchAll(/name="_yx" value="([^"]+)"/g)].map((m) => m[1]!);
    const submit = (fields: [string, string][]) =>
      fetch(server.url + "/nested", { method: "POST", body: new URLSearchParams(fields), redirect: "manual" });
    // Tree order, as a browser builds it: the hidden input, the fields, then the submitter.
    expect((await submit([["_yx", formToken!], ["title", "x"]])).status).toBe(303);
    expect((await submit([["_yx", formToken!], ["title", "x"], ["_yx", dropToken!]])).status).toBe(303);
    expect(removed).toEqual(["saved", "dropped"]);
  });
});
