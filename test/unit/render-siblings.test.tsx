import { afterEach, describe, expect, it, vi } from "vitest";
import { Dynamic, renderToStream, renderToString, type Child } from "@toyz/yerd";

/** A promise resolved or rejected from outside. */
function gate<T = void>() {
  let open!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function chunksUntilError(node: Child): Promise<{ out: string[]; error: unknown }> {
  const out: string[] = [];
  try {
    for await (const chunk of renderToStream(node)) out.push(chunk);
  } catch (error) {
    return { out, error };
  }
  throw new Error("expected the stream to throw");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sibling async components", () => {
  it("wait together: ten 20ms siblings take 20ms, not 200ms", async () => {
    vi.useFakeTimers();
    const Slow = async ({ n }: { n: number }) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return <p>{n}</p>;
    };
    let html: string | undefined;
    void renderToString(<div>{Array.from({ length: 10 }, (_, n) => <Slow n={n} />)}</div>).then((h) => (html = h));
    await vi.advanceTimersByTimeAsync(20);
    expect(html).toBe(`<div>${Array.from({ length: 10 }, (_, n) => `<p>${n}</p>`).join("")}</div>`);
  });

  it("are all called before the first one finishes, and render in order whatever order they finish in", async () => {
    const gates = [gate(), gate(), gate()];
    const called: number[] = [];
    const Part = async ({ n }: { n: number }) => {
      called.push(n);
      await gates[n]!.promise;
      return <li>{n}</li>;
    };
    const chunks: string[] = [];
    const done = (async () => {
      for await (const chunk of renderToStream(<ul><Part n={0} /><Part n={1} /><Part n={2} /></ul>)) chunks.push(chunk);
    })();
    await tick();
    expect(called).toEqual([0, 1, 2]);
    gates[2]!.open();
    gates[1]!.open();
    await tick();
    // The first one is still out: nothing after it can go yet.
    expect(chunks.join("")).toBe("<ul>");
    gates[0]!.open();
    await done;
    expect(chunks.join("")).toBe("<ul><li>0</li><li>1</li><li>2</li></ul>");
    // The ones that had finished went out with the first, not one chunk each.
    expect(chunks).toEqual(["<ul>", "<li>0</li><li>1</li><li>2</li></ul>"]);
  });

  it("include those in a .map() array and in fragments", async () => {
    const called: string[] = [];
    const hold = gate();
    const Part = async ({ id }: { id: string }) => {
      called.push(id);
      await hold.promise;
      return id;
    };
    const html = renderToString(
      <div>
        <Part id="a" />
        {["b", "c"].map((id) => <Part id={id} />)}
        <>
          <Part id="d" />
        </>
      </div>,
    );
    await tick();
    expect(called).toEqual(["a", "b", "c", "d"]);
    hold.open();
    expect(await html).toBe("<div>abcd</div>");
  });

  it("leave plain components alone: they run when the walk gets to them", async () => {
    const hold = gate();
    const log: string[] = [];
    const Slow = async () => {
      log.push("slow called");
      await hold.promise;
      log.push("slow done");
      return "a";
    };
    const Plain = () => {
      log.push("plain called");
      return "b";
    };
    const html = renderToString([<Slow />, <Plain />]);
    await tick();
    expect(log).toEqual(["slow called"]);
    hold.open();
    expect(await html).toBe("ab");
    expect(log).toEqual(["slow called", "slow done", "plain called"]);
  });

  it("don't start what's inside an element or another component", async () => {
    const hold = gate();
    const called: string[] = [];
    const Part = async ({ id }: { id: string }) => {
      called.push(id);
      await hold.promise;
      return id;
    };
    const Wrap = ({ children }: { children?: Child }) => <section>{children}</section>;
    const html = renderToString([<Part id="a" />, <b><Part id="b" /></b>, <Wrap><Part id="c" /></Wrap>]);
    await tick();
    expect(called).toEqual(["a"]);
    hold.open();
    expect(await html).toBe("a<b>b</b><section>c</section>");
  });

  it("call a node used twice twice, as before", async () => {
    let calls = 0;
    const Part = async () => {
      calls++;
      await tick();
      return "x";
    };
    const node = <Part />;
    expect(await renderToString([<Part />, node, node])).toBe("xxx");
    expect(calls).toBe(3);
  });

  it("report an error where the failing component is, after the output before it", async () => {
    const first = gate();
    const Ok = async ({ n }: { n: number }) => {
      if (n === 0) await first.promise;
      return <p>{n}</p>;
    };
    const Broken = async () => {
      throw new Error("third");
    };
    const result = chunksUntilError(<main><Ok n={0} /><Ok n={1} /><Broken /><p>never</p></main>);
    // It has failed already; the stream still waits for the ones before it.
    await tick();
    first.open();
    const { out, error } = await result;
    expect(out.join("")).toBe("<main><p>0</p><p>1</p>");
    expect((error as Error).message).toBe("third");
  });

  it("report the first failure in page order, not the first to happen", async () => {
    const slow = gate();
    const Late = async () => {
      await slow.promise;
      throw new Error("first in the page");
    };
    const Early = async () => {
      throw new Error("first to fail");
    };
    const result = chunksUntilError(<main><Late /><Early /></main>);
    await tick();
    slow.open();
    expect(((await result).error as Error).message).toBe("first in the page");
  });

  it("leave no unhandled rejection when an earlier sibling's error ends the render first", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const later = gate();
      const Broken = async () => {
        throw new Error("ends the page");
      };
      const AlsoBroken = async () => {
        await later.promise;
        throw new Error("never reported");
      };
      const { error } = await chunksUntilError(<main><Broken /><AlsoBroken /></main>);
      expect((error as Error).message).toBe("ends the page");
      later.open();
      await tick();
      await tick();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("start inside a <Dynamic>'s content too, and not for its skipped content when prerendering", async () => {
    const called: string[] = [];
    const Part = async ({ id }: { id: string }) => {
      called.push(id);
      await tick();
      return id;
    };
    const page = (
      <div>
        <Part id="a" />
        <Dynamic id="d" fallback="...">{() => [<Part id="b" />, <Part id="c" />]}</Dynamic>
      </div>
    );
    expect(await renderToString(page)).toBe('<div>a<div id="d" data-yx-region>bc</div></div>');
    expect(called).toEqual(["a", "b", "c"]);
    called.length = 0;
    expect(await renderToString(page, { dynamic: "fallback" })).toBe('<div>a<div id="d" data-yx-region data-yx-defer>...</div></div>');
    expect(called).toEqual(["a"]);
  });
});
