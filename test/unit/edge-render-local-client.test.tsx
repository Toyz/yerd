// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { Local, eq, not, renderToString, type Child } from "@toyz/yerd";
import { runtimeSource } from "../../src/client/runtime.js";

beforeAll(() => {
  new Function(runtimeSource())();
});

/** Render on the server, put it in the page, and let the runtime pick it up. */
async function mount(node: Child): Promise<void> {
  document.body.innerHTML = await renderToString(node);
  document.dispatchEvent(new Event("yx:applied"));
}

const $ = (selector: string) => document.querySelector(selector) as HTMLElement;

describe("bindings whose names have a colon", () => {
  it("class flags with Tailwind variants toggle under their own name", async () => {
    await mount(
      <Local state={{ on: false }}>
        {(s) => <button id="b" class={{ "md:block": s.on, "hover:underline": not(s.on) }} onClick={() => (s.on = !s.on)}>x</button>}
      </Local>,
    );
    expect($("#b").className).toBe("hover:underline");
    $("#b").click();
    expect($("#b").className).toBe("md:block");
    $("#b").click();
    expect($("#b").className).toBe("hover:underline");
  });

  it("an attribute with a namespace prefix is set by its full name", async () => {
    await mount(
      <Local state={{ to: "#a" }}>
        {(s) => (
          <svg>
            <use id="u" {...{ "xlink:href": s.to }} />
            <rect id="r" onClick={() => (s.to = "#b")} />
          </svg>
        )}
      </Local>,
    );
    $("#r").dispatchEvent(new Event("click", { bubbles: true }));
    expect($("#u").getAttribute("xlink:href")).toBe("#b");
  });

  it("an eq() value with colons and semicolons still compares", async () => {
    await mount(
      <Local state={{ t: "a:b;c" }}>
        {(s) => <p id="p" hidden={not(eq(s.t, "a:b;c"))} onClick={() => (s.t = "x")}>p</p>}
      </Local>,
    );
    expect($("#p").hidden).toBe(false);
    $("#p").click();
    expect($("#p").hidden).toBe(true);
  });
});

describe("class bindings in the browser", () => {
  it("a flag naming several classes toggles each", async () => {
    await mount(
      <Local state={{ err: false }}>
        {(s) => <i id="i" class={["base", { "text-red bold": s.err }]} onClick={() => (s.err = !s.err)}>i</i>}
      </Local>,
    );
    expect($("#i").className).toBe("base");
    $("#i").click();
    expect($("#i").className).toBe("base text-red bold");
    $("#i").click();
    expect($("#i").className).toBe("base");
  });

  it("className flags next to class are kept in step", async () => {
    await mount(
      <Local state={{ on: false }}>
        {(s) => <i id="i" class="btn" className={{ active: s.on }} onClick={() => (s.on = !s.on)}>i</i>}
      </Local>,
    );
    expect($("#i").className).toBe("btn");
    $("#i").click();
    expect($("#i").className).toBe("btn active");
  });

  it("className={s.x} replaces the class attribute", async () => {
    await mount(
      <Local state={{ theme: "dark" }}>
        {(s) => <i id="i" className={s.theme} onClick={() => (s.theme = "light")}>i</i>}
      </Local>,
    );
    $("#i").click();
    expect($("#i").getAttribute("class")).toBe("light");
    expect($("#i").hasAttribute("classname")).toBe(false);
  });
});
