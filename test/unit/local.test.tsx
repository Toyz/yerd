// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { Local, not, renderToString } from "@toyz/yerd";
import { runtimeSource } from "../../src/client/runtime.js";

beforeAll(() => {
  new Function(runtimeSource())();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function Widget() {
  return (
    <Local state={{ count: 2, open: false, user: { name: "ada" }, tags: [] as string[] }}>
      {(s) => (
        <div>
          <span class="count">{s.count}</span>
          <button id="inc" onClick={() => s.count++}>+1</button>
          <button id="toggle" class={{ active: s.open, base: true }} onClick={() => (s.open = !s.open)}>toggle</button>
          <p id="details" hidden={not(s.open)} aria-expanded={s.open}>details</p>
          <input id="name" value={s.user.name} onInput={(e: Event) => (s.user.name = (e.target as HTMLInputElement).value)} />
          <b id="hello">{s.user.name}</b>
          <button id="tag" onClick={() => s.tags.push("x")}>tag</button>
          <i id="tags">{s.tags.length}</i>
        </div>
      )}
    </Local>
  );
}

describe("<Local> on the server", () => {
  it("renders initial values and marks bindings, handlers and the scope", async () => {
    const html = await renderToString(<Widget />);
    expect(html).toContain('<yerd-local data-yx-local="{&quot;count&quot;:2,&quot;open&quot;:false,&quot;user&quot;:{&quot;name&quot;:&quot;ada&quot;},&quot;tags&quot;:[]}" data-yx-as="s" style="display:contents">');
    expect(html).toContain('<span data-yx-text="count">2</span>');
    expect(html).toContain('data-yx-on-click="() =&gt; s.count++"');
    expect(html).toContain('<p id="details" hidden aria-expanded="false" data-yx-bind="hidden:!open;aria-expanded:open">');
    expect(html).toContain('class="base" data-yx-on-click');
    expect(html).toContain('data-yx-bind="class.active:open"');
    expect(html).toContain('value="ada"');
    expect(html).toContain('data-yx-bind="value:user.name"');
  });

  it("drops handlers outside <Local>, as before", async () => {
    expect(await renderToString(<button onClick={() => 1}>x</button>)).toBe("<button>x</button>");
  });

  it("wants a plain parameter name and JSON state", async () => {
    await expect(renderToString(<Local state={{ a: 1 }}>{({ a }) => <i>{a}</i>}</Local>)).rejects.toThrow(/plain parameter name/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(renderToString(<Local state={cyclic}>{(s) => <i>{s.self as never}</i>}</Local>)).rejects.toThrow(/must be JSON/);
  });
});

describe("<Local> in the browser", () => {
  it("runs handlers against the state and keeps bindings in step, with no requests", async () => {
    document.body.innerHTML = await renderToString(<Widget />);
    document.dispatchEvent(new CustomEvent("yx:applied"));
    await flush();
    const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
    $("#inc").click();
    $("#inc").click();
    expect($(".count").textContent).toBe("4");

    expect(($("#details") as HTMLElement).hasAttribute("hidden")).toBe(true);
    expect($("#details").getAttribute("aria-expanded")).toBe("false");
    $("#toggle").click();
    expect($("#details").hasAttribute("hidden")).toBe(false);
    expect($("#details").getAttribute("aria-expanded")).toBe("true");
    expect($("#toggle").classList.contains("active")).toBe(true);
    expect($("#toggle").classList.contains("base")).toBe(true);

    const input = $("#name") as HTMLInputElement;
    input.value = "grace";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect($("#hello").textContent).toBe("grace");

    $("#tag").click();
    $("#tag").click();
    expect($("#tags").textContent).toBe("2");
  });

  it("keeps two scopes apart", async () => {
    document.body.innerHTML = (await renderToString(<Widget />)) + (await renderToString(<Widget />));
    document.dispatchEvent(new CustomEvent("yx:applied"));
    await flush();
    const [first, second] = Array.from(document.querySelectorAll("#inc")) as HTMLElement[];
    first!.click();
    const counts = Array.from(document.querySelectorAll(".count")).map((c) => c.textContent);
    expect(counts).toEqual(["3", "2"]);
    void second;
  });
});
