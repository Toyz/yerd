import { describe, expect, it } from "vitest";
import { Local, renderToString } from "@toyz/yerd";
import { jsx } from "@toyz/yerd/jsx-runtime";

const scope = (state: string, as = "s") =>
  `<yerd-local data-yx-local="${state}" data-yx-as="${as}" style="display:contents">`;

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
