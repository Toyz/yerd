// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { Local, eq, not, renderToString } from "@toyz/yerd";
import { runtimeSource } from "../../src/client/runtime.js";

beforeAll(() => {
  new Function(runtimeSource())();
});

const flush = () => new Promise((r) => setTimeout(r, 0));
/** Persisted state is saved once per frame: wait for it. */
const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

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

  it("binds class flags inside a class array too", async () => {
    const html = await renderToString(
      <Local state={{ fav: false, big: true }}>{(s) => <button class={["heart", { on: s.fav }, [{ big: s.big, off: not(s.fav) }]]}>x</button>}</Local>,
    );
    // A binding is a truthy proxy: unhandled, "on" would render although fav is false.
    expect(html).toContain('<button class="heart big off" data-yx-bind="class.on:fav;class.big:big;class.off:!fav">');
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

function Slider({ photos }: { photos: string[] }) {
  return (
    <Local state={{ i: 0, n: photos.length }}>
      {(s) => (
        <div>
          {photos.map((src, n) => <img class="slide" src={src} alt="" hidden={not(eq(s.i, n))} />)}
          <button id="prev" onClick={() => (s.i = (s.i + s.n - 1) % s.n)}>prev</button>
          <button id="next" onClick={() => (s.i = (s.i + 1) % s.n)}>next</button>
          {photos.map((_, n) => (
            <button class={["thumb", { active: eq(s.i, n) }]} data-n={n} onClick={(e: Event) => (s.i = Number((e.currentTarget as HTMLElement).dataset.n))}>{n}</button>
          ))}
        </div>
      )}
    </Local>
  );
}

describe("eq() bindings", () => {
  it("render the initial comparison and its binding", async () => {
    const html = await renderToString(<Slider photos={["/a.svg", "/b.svg"]} />);
    expect(html).toContain('<img class="slide" src="/a.svg" alt="" data-yx-bind="hidden:!i=0">');
    expect(html).toContain('<img class="slide" src="/b.svg" alt="" hidden data-yx-bind="hidden:!i=1">');
    expect(html).toContain('class="thumb active" data-n="0"');
  });

  it("make a slider: arrows wrap, thumbnails jump, one slide shows", async () => {
    document.body.innerHTML = await renderToString(<Slider photos={["/a.svg", "/b.svg", "/c.svg"]} />);
    document.dispatchEvent(new CustomEvent("yx:applied"));
    await flush();
    const shown = () => Array.from(document.querySelectorAll<HTMLImageElement>(".slide")).filter((img) => !img.hidden).map((img) => img.getAttribute("src"));
    const active = () => Array.from(document.querySelectorAll(".thumb.active")).map((b) => b.textContent);
    expect(shown()).toEqual(["/a.svg"]);
    (document.getElementById("prev") as HTMLElement).click();
    expect(shown()).toEqual(["/c.svg"]);
    expect(active()).toEqual(["2"]);
    (document.getElementById("next") as HTMLElement).click();
    expect(shown()).toEqual(["/a.svg"]);
    (document.querySelectorAll(".thumb")[1] as HTMLElement).click();
    expect(shown()).toEqual(["/b.svg"]);
    expect(active()).toEqual(["1"]);
  });

  it("compare strings safely, and not(not(x)) is x", async () => {
    const html = await renderToString(
      <Local state={{ tab: "a;b:c", open: true }}>{(s) => <p class={{ on: eq(s.tab, "a;b:c") }} hidden={not(not(s.open))}>x</p>}</Local>,
    );
    expect(html).toContain('class="on"');
    expect(html).toContain("hidden");
    expect(html).toContain('data-yx-bind="class.on:tab=%22a%3Bb%3Ac%22;hidden:open"');
  });
});

describe("<Local persist>", () => {
  function Likes({ storage }: { storage?: "session" }) {
    return (
      <Local state={{ likes: 0, theme: "light" }} persist={storage ? { key: "likes", storage } : "likes"}>
        {(s) => (
          <div>
            <b class="likes">{s.likes}</b>
            <i class="theme">{s.theme}</i>
            <button class="like" onClick={() => s.likes++}>like</button>
          </div>
        )}
      </Local>
    );
  }

  const render = async (html: string) => {
    document.body.innerHTML = html;
    document.dispatchEvent(new CustomEvent("yx:applied"));
    await flush();
  };
  const texts = (sel: string) => Array.from(document.querySelectorAll(sel)).map((e) => e.textContent);

  it("saves after each handler and restores on the next page, merged over the defaults", async () => {
    localStorage.clear();
    const html = await renderToString(<Likes />);
    expect(html).toContain('data-yx-persist="likes"');
    await render(html);
    (document.querySelector(".like") as HTMLElement).click();
    (document.querySelector(".like") as HTMLElement).click();
    await frame();
    expect(JSON.parse(localStorage.getItem("yerd-local:likes")!)).toEqual({ likes: 2, theme: "light" });

    // An older save without "theme": the default fills it in.
    localStorage.setItem("yerd-local:likes", JSON.stringify({ likes: 7 }));
    await render(await renderToString(<Likes />));
    expect(texts(".likes")).toEqual(["7"]);
    expect(texts(".theme")).toEqual(["light"]);
  });

  it("keeps scopes with the same key in step, here and in other tabs", async () => {
    localStorage.clear();
    await render((await renderToString(<Likes />)) + (await renderToString(<Likes />)));
    (document.querySelector(".like") as HTMLElement).click();
    await frame();
    expect(texts(".likes")).toEqual(["1", "1"]);

    window.dispatchEvent(new StorageEvent("storage", { key: "yerd-local:likes", newValue: JSON.stringify({ likes: 42, theme: "dark" }), storageArea: localStorage }));
    expect(texts(".likes")).toEqual(["42", "42"]);
    expect(texts(".theme")).toEqual(["dark", "dark"]);
  });

  it("uses sessionStorage when asked, separately from localStorage", async () => {
    localStorage.clear();
    sessionStorage.clear();
    await render(await renderToString(<Likes storage="session" />));
    (document.querySelector(".like") as HTMLElement).click();
    await frame();
    expect(JSON.parse(sessionStorage.getItem("yerd-local:likes")!).likes).toBe(1);
    expect(localStorage.getItem("yerd-local:likes")).toBeNull();
  });
});
