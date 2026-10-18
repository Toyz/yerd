import { describe, expect, it } from "vitest";
import { Local, renderToString } from "@toyz/yerd";
import { jsx } from "@toyz/yerd/jsx-runtime";

const scope = (state: string, as = "s") =>
  `<yerd-local data-yx-local="${state}" data-yx-as="${as}" style="display:contents">`;

describe("bindings are not thenables", () => {
  it("an async component can return a binding", async () => {
    const Count = async ({ c }: { c: number }) => c;
    expect(await renderToString(<Local state={{ x: 1 }}>{(s) => <i><Count c={s.x} /></i>}</Local>)).toBe(
      `${scope("{&quot;x&quot;:1}")}<i><span data-yx-text="x">1</span></i></yerd-local>`,
    );
  });

  it("a promise of a binding settles", async () => {
    expect(await renderToString(<Local state={{ x: "a" }}>{(s) => Promise.resolve(s.x)}</Local>)).toBe(
      `${scope("{&quot;x&quot;:&quot;a&quot;}")}<span data-yx-text="x">a</span></yerd-local>`,
    );
  });

  it("the render prop may be async", async () => {
    expect(await renderToString(<Local state={{ x: 2 }}>{async (s) => <b>{s.x}</b>}</Local>)).toBe(
      `${scope("{&quot;x&quot;:2}")}<b><span data-yx-text="x">2</span></b></yerd-local>`,
    );
  });

  it("a state field called then is still bound", async () => {
    expect(await renderToString(<Local state={{ then: 3 }}>{(s) => <b>{s.then}</b>}</Local>)).toBe(
      `${scope("{&quot;then&quot;:3}")}<b><span data-yx-text="then">3</span></b></yerd-local>`,
    );
  });
});

describe("<Local> handler names", () => {
  // A spread object's keys reach the renderer unchecked; inside <Local> a
  // handler's name becomes part of an attribute name.
  it.each(['on x"><i', "on click", "on<b>", "on=x", "on/x", "on'x", "on\nx"])("refuses %j inside <Local>", async (name) => {
    await expect(
      renderToString(<Local state={{ x: 1 }}>{(s) => jsx("b", { [name]: () => s.x }) as never}</Local>),
    ).rejects.toThrow(`Invalid attribute name: ${JSON.stringify(name)}`);
  });

  it("still drops an invalid handler name outside <Local> (nothing is written)", async () => {
    expect(await renderToString(jsx("b", { 'on x"><i': () => 1 }))).toBe("<b></b>");
  });

  it("writes a valid one, lowercased", async () => {
    expect(await renderToString(<Local state={{}}>{(s) => <b onMouseEnter={() => s}>x</b>}</Local>)).toBe(
      `${scope("{}")}<b data-yx-on-mouseenter="() =&gt; s">x</b></yerd-local>`,
    );
  });
});
