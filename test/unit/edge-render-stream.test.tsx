import { describe, expect, it } from "vitest";
import { Dynamic, Local, renderToStream, renderToString, type Child, type RenderOptions } from "@toyz/yerd";
import { jsx } from "@toyz/yerd/jsx-runtime";

const later = <T,>(value: T, ms = 1) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

async function chunks(node: Child, options?: RenderOptions): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of renderToStream(node, options)) out.push(chunk);
  return out;
}

/** The chunks that came out before the stream threw, and what it threw. */
async function chunksUntilError(node: Child): Promise<{ out: string[]; error: unknown }> {
  const out: string[] = [];
  try {
    for await (const chunk of renderToStream(node)) out.push(chunk);
  } catch (error) {
    return { out, error };
  }
  throw new Error("expected the stream to throw");
}

describe("renderToStream chunks", () => {
  it("a synchronous page is one chunk", async () => {
    expect(await chunks(<html><body>{["a", <b>b</b>]}</body></html>)).toEqual(["<html><body>a<b>b</b></body></html>"]);
  });

  it.each<[string, Child]>([
    ["null", null],
    ["false", false],
    ["an empty fragment", <></>],
    ["an empty string", ""],
    ["an empty array", []],
  ])("%s is no chunks at all", async (_, node) => {
    expect(await chunks(node)).toEqual([]);
  });

  it("flushes before each wait, never an empty chunk", async () => {
    const A = async () => <i>a</i>;
    // Still waiting when the walk gets to it (siblings start together).
    const B = async () => later(<i>b</i>, 5);
    expect(await chunks(<main><h1>top</h1><A /><B /><p>end</p></main>)).toEqual([
      "<main><h1>top</h1>",
      "<i>a</i>",
      "<i>b</i><p>end</p></main>",
    ]);
  });

  it("an async first child: nothing to flush before it", async () => {
    const A = async () => <i>a</i>;
    expect(await chunks(<A />)).toEqual(["<i>a</i>"]);
  });

  it("consecutive waits with nothing between make no empty chunks", async () => {
    expect(await chunks([later("a"), later("b"), later("c")])).toEqual(["a", "b", "c"]);
  });

  it("the chunks join into what renderToString returns", async () => {
    const Slow = async ({ n }: { n: number }) => later(<li>{n}</li>, 3 - n);
    const page = <ul>{[0, 1, 2].map((n) => <Slow n={n} />)}</ul>;
    expect((await chunks(page)).join("")).toBe(await renderToString(page));
  });

  it("an error mid-stream comes after the chunks before it", async () => {
    const error = new Error("mid");
    const Broken = async () => {
      await later(null);
      throw error;
    };
    const result = await chunksUntilError(<main><h1>top</h1><Broken /><p>never</p></main>);
    expect(result.out).toEqual(["<main><h1>top</h1>"]);
    expect(result.error).toBe(error);
  });

  it("a synchronous error comes before any chunk", async () => {
    const Broken = () => {
      throw new Error("sync");
    };
    const result = await chunksUntilError(<main><Broken /></main>);
    expect(result.out).toEqual([]);
    expect((result.error as Error).message).toBe("sync");
  });

  it("an error after several waits keeps everything rendered so far", async () => {
    // A component, so the rejection only exists once the renderer gets there.
    const Late = async () => {
      throw new Error("late");
    };
    const result = await chunksUntilError([<i>1</i>, later(<i>2</i>), later(<i>3</i>), <Late />, <i>never</i>]);
    expect(result.out).toEqual(["<i>1</i>", "<i>2</i>", "<i>3</i>"]);
    expect((result.error as Error).message).toBe("late");
  });

  it("a consumer can stop early, and a later failure doesn't go unhandled", async () => {
    const Broken = async () => {
      await later(null, 5);
      throw new Error("after the consumer left");
    };
    for await (const chunk of renderToStream(<main><h1>top</h1><Broken /></main>)) {
      expect(chunk).toBe("<main><h1>top</h1>");
      break;
    }
    await later(null, 20);
  });

  it("each render has its own state (two streams interleaved)", async () => {
    const A = async () => later(<i>a</i>, 5);
    const B = async () => later(<b>b</b>, 1);
    const [a, b] = await Promise.all([chunks(<p><A /></p>), chunks(<div><B /></div>)]);
    expect(a.join("")).toBe("<p><i>a</i></p>");
    expect(b.join("")).toBe("<div><b>b</b></div>");
  });
});

describe("<Dynamic>", () => {
  const live = () => <b>live</b>;

  it.each<[RenderOptions["dynamic"], string]>([
    [undefined, '<p>a</p><div id="d" data-yx-region><b>live</b></div><p>z</p>'],
    ["fallback", '<p>a</p><div id="d" data-yx-region data-yx-defer><i>wait</i></div><p>z</p>'],
    ["only", '<div id="d" data-yx-region><b>live</b></div>'],
  ])("mode %s", async (dynamic, html) => {
    const page = <><p>a</p><Dynamic id="d" fallback={<i>wait</i>}>{live}</Dynamic><p>z</p></>;
    expect(await renderToString(page, { dynamic })).toBe(html);
  });

  it("doesn't call its children when prerendering", async () => {
    let calls = 0;
    const html = await renderToString(<Dynamic id="d">{() => (calls++, "x")}</Dynamic>, { dynamic: "fallback" });
    expect(html).toBe('<div id="d" data-yx-region data-yx-defer></div>');
    expect(calls).toBe(0);
  });

  it.each(["a", "A1", "a-b_c", "x_"])("takes the id %j", async (id) => {
    expect(await renderToString(<Dynamic id={id}>{() => null}</Dynamic>)).toBe(`<div id="${id}" data-yx-region></div>`);
  });

  it.each(["", "1a", "-a", "_a", "a b", "a:b", "a.b", "a}b", 'a"b', "a>b", "é"])("refuses the id %j", async (id) => {
    await expect(renderToString(<Dynamic id={id}>{() => null}</Dynamic>)).rejects.toThrow(
      `<Dynamic> ids must be letters, digits, - and _ (got ${JSON.stringify(id)})`,
    );
  });

  it.each(["a b", "1x", "div>"])("refuses the wrapper element %j", async (as) => {
    await expect(renderToString(<Dynamic id="d" as={as}>{() => null}</Dynamic>)).rejects.toThrow("Invalid element name");
  });

  it("puts other attributes on the wrapper, escaped; its own id wins", async () => {
    expect(
      await renderToString(<Dynamic id="d" as="section" class={["a", { b: true }]} title={'"t"'} data-x={1}>{() => null}</Dynamic>),
    ).toBe('<section class="a b" title="&quot;t&quot;" data-x="1" id="d" data-yx-region></section>');
  });

  it("an async noscript closes in order", async () => {
    const No = async () => later(<a href="/x">x</a>);
    expect(await renderToString(<Dynamic id="d" fallback="..." noscript={<No />}>{live}</Dynamic>, { dynamic: "fallback" })).toBe(
      '<div id="d" data-yx-region data-yx-defer>...<noscript><style>#d>:not(noscript){display:none!important}</style><a href="/x">x</a></noscript></div>',
    );
  });

  it("an async fallback is awaited", async () => {
    expect(await renderToString(<Dynamic id="d" fallback={later(<i>f</i>)}>{live}</Dynamic>, { dynamic: "fallback" })).toBe(
      '<div id="d" data-yx-region data-yx-defer><i>f</i></div>',
    );
  });

  it("async children in only mode come out, and nothing around them", async () => {
    const page = (
      <main>
        <h1>static</h1>
        <Dynamic id="a">{async () => later(<b>a</b>)}</Dynamic>
        <section><Dynamic id="b" as="span">{() => "b"}</Dynamic></section>
      </main>
    );
    expect(await renderToString(page, { dynamic: "only" })).toBe('<div id="a" data-yx-region><b>a</b></div><span id="b" data-yx-region>b</span>');
  });

  it("a Dynamic inside a Dynamic is part of the outer's content (written once)", async () => {
    const page = <Dynamic id="outer">{() => <Dynamic id="inner">{() => "x"}</Dynamic>}</Dynamic>;
    expect(await renderToString(page, { dynamic: "only" })).toBe(
      '<div id="outer" data-yx-region><div id="inner" data-yx-region>x</div></div>',
    );
  });

  it("errors in its children reject (sync and async), and leave nothing half-counted", async () => {
    await expect(renderToString(<Dynamic id="d">{() => { throw new Error("sync d"); }}</Dynamic>, { dynamic: "only" })).rejects.toThrow("sync d");
    const Broken = async () => {
      throw new Error("async d");
    };
    await expect(renderToString(<Dynamic id="d">{() => <Broken />}</Dynamic>, { dynamic: "only" })).rejects.toThrow("async d");
    // The count is per render: the next one starts outside every Dynamic.
    expect(await renderToString(<><p>x</p><Dynamic id="d">{() => "y"}</Dynamic></>, { dynamic: "only" })).toBe(
      '<div id="d" data-yx-region>y</div>',
    );
  });

  it("only mode still refuses invalid markup outside a Dynamic", async () => {
    await expect(renderToString(<main>{jsx("br", { children: "x" })}</main>, { dynamic: "only" })).rejects.toThrow("void element");
    await expect(renderToString(jsx("a b", {}), { dynamic: "only" })).rejects.toThrow("Invalid element name");
  });

  it("only mode with no Dynamic parts is empty", async () => {
    expect(await renderToString(<html><body><p>x</p></body></html>, { dynamic: "only", document: true })).toBe("");
  });

  it("a Local outside any Dynamic in only mode writes nothing, a Local inside one is kept", async () => {
    const page = (
      <>
        <Local state={{ a: 1 }}>{(s) => <i>{s.a}</i>}</Local>
        <Dynamic id="d">{() => <Local state={{ b: 2 }}>{(s) => <b>{s.b}</b>}</Local>}</Dynamic>
      </>
    );
    expect(await renderToString(page, { dynamic: "only" })).toBe(
      '<div id="d" data-yx-region><yerd-local data-yx-local="{&quot;b&quot;:2}" data-yx-as="s" style="display:contents"><b><span data-yx-text="b">2</span></b></yerd-local></div>',
    );
  });

  // The wrapper is an element like any other: inside <Local> its handlers
  // go to the browser (they were dropped).
  it("a handler on the wrapper inside <Local> is shipped, outside it's dropped", async () => {
    expect(await renderToString(<Local state={{ n: 0 }}>{(s) => <Dynamic id="d" onClick={() => s.n++}>{() => "x"}</Dynamic>}</Local>)).toBe(
      '<yerd-local data-yx-local="{&quot;n&quot;:0}" data-yx-as="s" style="display:contents">' +
        '<div data-yx-on-click="() =&gt; s.n++" id="d" data-yx-region>x</div></yerd-local>',
    );
    expect(await renderToString(<Dynamic id="d" onClick={() => 1}>{() => "x"}</Dynamic>)).toBe('<div id="d" data-yx-region>x</div>');
  });

  it("calling Dynamic as a function just renders its children", async () => {
    expect(await renderToString(Dynamic({ id: "d", children: () => <i>x</i> }) as Child)).toBe("<i>x</i>");
  });
});
