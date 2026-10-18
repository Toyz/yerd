// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runtimeSource } from "../../src/client/runtime.js";
import type { YerdClient as Yerd } from "../../src/attributes/attribute.js";


let yerd: Yerd;

beforeAll(() => {
  new Function(runtimeSource())();
  yerd = (window as unknown as { yerd: Yerd }).yerd;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function el(html: string): Element {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild!;
}

/** Put `before` on the page, morph `after` into it, return the root. */
function morph(before: string, after: string): Element {
  document.body.innerHTML = before;
  const root = document.body.firstElementChild!;
  yerd.page.morph(root, el(after));
  return document.body.firstElementChild!;
}

/** Texts of the root's element children, with a * on the ones that are the same node as before. */
function track(before: string, after: string, selector = "li"): string[] {
  document.body.innerHTML = before;
  const old = new Set(Array.from(document.querySelectorAll(selector)));
  yerd.page.morph(document.body.firstElementChild!, el(after));
  return Array.from(document.querySelectorAll(selector), (n) => `${n.textContent}${old.has(n) ? "*" : ""}`);
}

describe("keyed children", () => {
  it.each([
    ["reverse", "1,2,3", "3,2,1"],
    ["rotate left", "1,2,3,4", "2,3,4,1"],
    ["rotate right", "1,2,3,4", "4,1,2,3"],
    ["swap ends", "1,2,3,4", "4,2,3,1"],
    ["drop the middle", "1,2,3", "1,3"],
    ["drop the first", "1,2,3", "2,3"],
    ["insert in the middle", "1,3", "1,2,3"],
    ["insert at the start", "2,3", "1,2,3"],
    ["replace all", "1,2", "3,4"],
    ["interleave", "1,2,3,4,5,6", "6,1,5,2,4,3"],
    ["empty to some", "", "1,2"],
    ["some to empty", "1,2", ""],
  ])("%s: %s -> %s keeps the survivors' nodes", (_name, from, to) => {
    const list = (keys: string) => `<ul id="l">${keys ? keys.split(",").map((k) => `<li data-key="${k}">${k}</li>`).join("") : ""}</ul>`;
    const before = new Set(from.split(",").filter(Boolean));
    const expected = to.split(",").filter(Boolean).map((k) => (before.has(k) ? `${k}*` : k));
    expect(track(list(from), list(to))).toEqual(expected);
  });

  it("keys by id when there's no data-key", () => {
    expect(track('<ul id="l"><li id="a">a</li><li id="b">b</li></ul>', '<ul id="l"><li id="b">b</li><li id="a">a</li></ul>')).toEqual(["b*", "a*"]);
  });

  it("data-key wins over id", () => {
    expect(track('<ul id="l"><li data-key="1" id="x">1</li></ul>', '<ul id="l"><li data-key="1" id="y">1</li></ul>')).toEqual(["1*"]);
    expect(document.querySelector("li")!.id).toBe("y");
  });

  it("mixes keyed and unkeyed children", () => {
    expect(track('<ul id="l"><li>u1</li><li data-key="k">k</li><li>u2</li></ul>', '<ul id="l"><li data-key="k">k</li><li>u1</li><li>u2</li></ul>')).toEqual(["k*", "u1*", "u2*"]);
  });

  it("an unkeyed new child doesn't steal a keyed node", () => {
    const out = track('<ul id="l"><li data-key="k">k</li></ul>', '<ul id="l"><li>new</li><li data-key="k">k!</li></ul>');
    expect(out).toEqual(["new", "k!*"]);
  });

  it("duplicate keys on the page: the result is still exactly what the server sent", () => {
    const root = morph('<ul id="l"><li data-key="d">1</li><li data-key="d">2</li><li data-key="e">e</li></ul>', '<ul id="l"><li data-key="e">e</li><li data-key="d">d</li></ul>');
    expect(root.innerHTML).toBe('<li data-key="e">e</li><li data-key="d">d</li>');
  });

  it("duplicate keys in the response: both are rendered", () => {
    const root = morph('<ul id="l"><li data-key="d">old</li></ul>', '<ul id="l"><li data-key="d">1</li><li data-key="d">2</li></ul>');
    expect(Array.from(root.children, (c) => c.textContent)).toEqual(["1", "2"]);
  });

  it("a keyed node that changes tag is replaced, not morphed across kinds", () => {
    document.body.innerHTML = '<div id="r"><p id="x">p</p></div>';
    const p = document.getElementById("x");
    yerd.page.morph(document.body.firstElementChild!, el('<div id="r"><section id="x">s</section></div>'));
    // Swapped in whole (and, being matched by key, without the data-yx-new mark).
    expect(document.body.firstElementChild!.innerHTML).toBe('<section id="x">s</section>');
    expect(p!.isConnected).toBe(false);
  });
});

describe("text, comments and whitespace", () => {
  it.each([
    ["text changes", "<p id='r'>a</p>", "<p id='r'>b</p>", "b"],
    ["text to element", "<p id='r'>a</p>", "<p id='r'><b>x</b></p>", '<b data-yx-new="">x</b>'],
    ["element to text", "<p id='r'><b>x</b></p>", "<p id='r'>a</p>", "a"],
    ["comment changes", "<p id='r'><!--a--></p>", "<p id='r'><!--b--></p>", "<!--b-->"],
    ["comment to text", "<p id='r'><!--a--></p>", "<p id='r'>t</p>", "t"],
    ["mixed runs", "<p id='r'>a<b>b</b>c</p>", "<p id='r'>x<b>y</b>z<i>w</i></p>", 'x<b>y</b>z<i data-yx-new="">w</i>'],
    ["whitespace kept", "<p id='r'>a</p>", "<p id='r'>  a \n </p>", "  a \n "],
    ["empties", "<p id='r'>a<b></b></p>", "<p id='r'></p>", ""],
  ])("%s", (_name, before, after, inner) => {
    expect(morph(before, after).innerHTML).toBe(inner);
  });

  it("text that looks like HTML stays text", () => {
    const root = morph("<p id='r'>a</p>", "<p id='r'>&lt;img src=x onerror=alert(1)&gt;</p>");
    expect(root.children).toHaveLength(0);
    expect(root.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("keeps the same text node when only its text changes", () => {
    document.body.innerHTML = "<p id='r'>a</p>";
    const text = document.body.firstElementChild!.firstChild;
    yerd.page.morph(document.body.firstElementChild!, el("<p id='r'>b</p>"));
    expect(document.body.firstElementChild!.firstChild).toBe(text);
  });
});

describe("attributes", () => {
  it("adds, changes and removes attributes, but not open", () => {
    const root = morph('<div id="r" a="1" b="2" open hidden></div>', '<div id="r" b="3" c=""></div>');
    expect(Array.from(root.attributes, (a) => `${a.name}=${a.value}`).sort()).toEqual(["b=3", "c=", "id=r", "open="]);
  });

  it("removes the data-yx-new mark on the next morph", () => {
    const root = morph('<div id="r"><i data-yx-new>x</i></div>', '<div id="r"><i>x</i></div>');
    expect(root.innerHTML).toBe("<i>x</i>");
  });

  it("is case-insensitive like HTML, and handles many attributes", () => {
    const attrs = Array.from({ length: 40 }, (_, i) => `data-a${i}="${i}"`).join(" ");
    const root = morph(`<div id="r" ${attrs}></div>`, '<div id="r" data-a5="five"></div>');
    expect(root.outerHTML).toBe('<div id="r" data-a5="five"></div>');
  });

  it("event handler attributes come from the server's HTML only, as given", () => {
    const root = morph('<button id="r" onclick="a()">x</button>', '<button id="r">x</button>');
    expect(root.hasAttribute("onclick")).toBe(false);
  });
});

describe("form state", () => {
  it("a focused input keeps value and caret through a morph that changes its value", () => {
    document.body.innerHTML = '<div id="r"><input id="i" value="server"></div>';
    const input = document.getElementById("i") as HTMLInputElement;
    input.focus();
    input.value = "hello world";
    input.setSelectionRange(3, 5);
    yerd.page.morph(document.getElementById("r")!, el('<div id="r"><input id="i" value="changed"></div>'));
    expect(input.value).toBe("hello world");
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 5]);
    expect(input.getAttribute("value")).toBe("changed");
  });

  it("an unfocused input the user didn't touch follows the server", () => {
    const root = morph('<div id="r"><input value="a"></div>', '<div id="r"><input value="b"></div>');
    expect((root.firstElementChild as HTMLInputElement).value).toBe("b");
  });

  it("a removed value attribute empties an untouched input", () => {
    const root = morph('<div id="r"><input value="a"></div>', '<div id="r"><input></div>');
    expect((root.firstElementChild as HTMLInputElement).value).toBe("");
  });

  it("a focused textarea keeps what's typed; its default follows the server", () => {
    document.body.innerHTML = '<div id="r"><textarea id="t">s</textarea></div>';
    const t = document.getElementById("t") as HTMLTextAreaElement;
    t.focus();
    t.value = "typing";
    yerd.page.morph(document.getElementById("r")!, el('<div id="r"><textarea id="t">new</textarea></div>'));
    expect(t.value).toBe("typing");
    expect(t.defaultValue).toBe("new");
  });

  it.each([
    ["checked by the server", "", " checked", true],
    ["unchecked by the server", " checked", "", false],
  ])("a checkbox %s", (_name, before, after, expected) => {
    const root = morph(`<div id="r"><input type="checkbox"${before}></div>`, `<div id="r"><input type="checkbox"${after}></div>`);
    expect((root.firstElementChild as HTMLInputElement).checked).toBe(expected);
  });

  it("a radio group follows the server's checked one", () => {
    const root = morph(
      '<div id="r"><input type="radio" name="g" value="1" checked><input type="radio" name="g" value="2"></div>',
      '<div id="r"><input type="radio" name="g" value="1"><input type="radio" name="g" value="2" checked></div>',
    );
    expect(Array.from(root.querySelectorAll("input"), (i) => i.checked)).toEqual([false, true]);
  });

  // Question (see report): unlike text, a checkbox or select the user changed is
  // overwritten by any morph, even when the server's state didn't change.
  it.todo("a checkbox the user ticked survives a morph where the server's state didn't change");

  it("a single select follows the server's selected option", () => {
    const root = morph(
      '<div id="r"><select><option>a</option><option selected>b</option></select></div>',
      '<div id="r"><select><option>a</option><option>b</option><option selected>c</option></select></div>',
    );
    expect((root.querySelector("select") as HTMLSelectElement).value).toBe("c");
  });

  it("a focused select keeps the user's choice even when the server moves its selected option", () => {
    document.body.innerHTML = '<div id="r"><select id="s"><option>a</option><option>b</option></select></div>';
    const s = document.getElementById("s") as HTMLSelectElement;
    s.focus();
    s.value = "b";
    yerd.page.morph(document.getElementById("r")!, el('<div id="r"><select id="s"><option selected>a</option><option>b</option></select></div>'));
    expect(s.value).toBe("b");
    // Once it's blurred, the next morph gives it the server's choice.
    s.blur();
    yerd.page.morph(document.getElementById("r")!, el('<div id="r"><select id="s"><option selected>a</option><option>b</option></select></div>'));
    expect(s.value).toBe("a");
  });

  it("a focused multiple select keeps every choice", () => {
    document.body.innerHTML = '<div id="r"><select id="s" multiple><option>a</option><option>b</option><option>c</option></select></div>';
    const s = document.getElementById("s") as HTMLSelectElement;
    s.focus();
    s.options[0]!.selected = true;
    s.options[2]!.selected = true;
    yerd.page.morph(document.getElementById("r")!, el('<div id="r"><select id="s" multiple><option>a</option><option selected>b</option><option>c</option></select></div>'));
    expect(Array.from(s.options, (o) => o.selected)).toEqual([true, false, true]);
  });

  it("a file input keeps the user's pick", () => {
    document.body.innerHTML = '<div id="r"><input type="file" id="f"></div>';
    const input = document.getElementById("f") as HTMLInputElement;
    const file = new File(["x"], "x.txt");
    input.files = [file] as unknown as FileList;
    yerd.page.morph(document.getElementById("r")!, el('<div id="r"><input type="file" id="f" accept=".txt"></div>'));
    expect(input.files![0]).toBe(file);
    expect(input.getAttribute("accept")).toBe(".txt");
  });

  it("an input that changes type is patched in place", () => {
    document.body.innerHTML = '<div id="r"><input id="i" type="text" value="x"></div>';
    const input = document.getElementById("i") as HTMLInputElement;
    yerd.page.morph(document.getElementById("r")!, el('<div id="r"><input id="i" type="checkbox" checked></div>'));
    expect(document.getElementById("i")).toBe(input);
    expect(input.type).toBe("checkbox");
    expect(input.checked).toBe(true);
  });
});

describe("details, keep and nesting", () => {
  it("opens a <details> the server sends open; never closes one the user opened", () => {
    const root = morph('<div id="r"><details><summary>s</summary></details></div>', '<div id="r"><details open><summary>s</summary></details></div>');
    expect((root.querySelector("details") as HTMLDetailsElement).open).toBe(true);
    yerd.page.morph(root, el('<div id="r"><details><summary>s</summary></details></div>'));
    expect((root.querySelector("details") as HTMLDetailsElement).open).toBe(true);
  });

  it("data-yx-keep leaves the element and its children alone", () => {
    document.body.innerHTML = '<div id="r"><canvas id="c" data-yx-keep width="5"><b>own</b></canvas><p>a</p></div>';
    const canvas = document.getElementById("c")!;
    yerd.page.morph(document.getElementById("r")!, el('<div id="r"><canvas id="c" data-yx-keep width="9"></canvas><p>b</p></div>'));
    expect(document.getElementById("c")).toBe(canvas);
    expect(canvas.outerHTML).toBe('<canvas id="c" data-yx-keep="" width="5"><b>own</b></canvas>');
    expect(document.querySelector("p")!.textContent).toBe("b");
  });

  it("deeply nested structure morphs node by node", () => {
    const depth = 50;
    const nest = (leaf: string) => "<div>".repeat(depth) + leaf + "</div>".repeat(depth);
    document.body.innerHTML = `<section id="r">${nest("<i>a</i>")}</section>`;
    const leaf = document.querySelector("i")!;
    yerd.page.morph(document.getElementById("r")!, el(`<section id="r">${nest("<i>b</i>")}</section>`));
    expect(document.querySelector("i")).toBe(leaf);
    expect(leaf.textContent).toBe("b");
  });

  it("morphing different node kinds at the root replaces the node", () => {
    document.body.innerHTML = '<div id="w"><p id="r">x</p></div>';
    const replacement = el('<span id="r">y</span>');
    yerd.page.morph(document.getElementById("r")!, replacement);
    expect(document.getElementById("w")!.innerHTML).toBe('<span id="r">y</span>');
  });
});

describe("apply", () => {
  it("regions the page doesn't have are skipped and not counted", () => {
    document.body.innerHTML = '<div id="a" data-yx-region>1</div>';
    expect(yerd.page.apply('<div id="a" data-yx-region>2</div><div id="zzz" data-yx-region>x</div>')).toBe(1);
    expect(document.getElementById("zzz")).toBeNull();
  });

  it("a region without an id is skipped", () => {
    document.body.innerHTML = '<div id="a" data-yx-region>1</div>';
    expect(yerd.page.apply("<div data-yx-region>2</div>")).toBe(0);
  });

  it("only data-yx-region elements count: other ids in the response don't touch the page", () => {
    document.body.innerHTML = '<p id="p">keep</p><div id="a" data-yx-region>1</div>';
    yerd.page.apply('<p id="p">changed</p><div id="a" data-yx-region>2</div>');
    expect(document.getElementById("p")!.textContent).toBe("keep");
  });

  it("nested regions: the outer morph brings the inner along, and the inner is applied again", () => {
    document.body.innerHTML = '<div id="outer" data-yx-region><div id="inner" data-yx-region>1</div></div>';
    const inner = document.getElementById("inner")!;
    expect(yerd.page.apply('<div id="outer" data-yx-region>o<div id="inner" data-yx-region>2</div></div>')).toBe(2);
    expect(document.getElementById("inner")).toBe(inner);
    expect(document.getElementById("outer")!.innerHTML).toBe('o<div id="inner" data-yx-region="">2</div>');
  });

  it("updates the title only when the response has a <head> title", () => {
    document.title = "before";
    document.body.innerHTML = '<div id="a" data-yx-region>1</div>';
    yerd.page.apply('<title>body title</title><div id="a" data-yx-region>2</div>');
    expect(document.title).toBe("before");
    yerd.page.apply('<html><head><title>New &amp; shiny</title></head><body><div id="a" data-yx-region>3</div></body></html>');
    expect(document.title).toBe("New & shiny");
  });

  it("fires yx:applied with the count", () => {
    document.body.innerHTML = '<div id="a" data-yx-region>1</div>';
    const counts: number[] = [];
    const listen = (e: Event) => counts.push((e as CustomEvent<{ regions: number }>).detail.regions);
    document.addEventListener("yx:applied", listen);
    yerd.page.apply('<div id="a" data-yx-region>2</div>');
    yerd.page.apply("<p>nothing</p>");
    document.removeEventListener("yx:applied", listen);
    expect(counts).toEqual([1, 0]);
  });

  it("an appending region updates children it already has and adds the rest at the end", () => {
    document.body.innerHTML = '<ul id="f" data-yx-region><li data-key="1">1</li><li data-key="2">2</li></ul>';
    const one = document.querySelector("li")!;
    yerd.page.apply('<ul id="f" data-yx-region data-yx-append><li data-key="1">1!</li><li data-key="3">3</li></ul>');
    expect(document.getElementById("f")!.innerHTML).toBe('<li data-key="1">1!</li><li data-key="2">2</li><li data-key="3" data-yx-new="">3</li>');
    expect(document.querySelector("li")).toBe(one);
  });

  it("an appending region keeps the target's own attributes", () => {
    document.body.innerHTML = '<ul id="f" class="feed" data-yx-region></ul>';
    yerd.page.apply('<ul id="f" data-yx-region data-yx-append class="other"><li>x</li></ul>');
    expect(document.getElementById("f")!.className).toBe("feed");
  });

  it("a prepending region puts new children first, in their order", () => {
    document.body.innerHTML = '<ul id="f" data-yx-region><li data-key="3">3</li></ul>';
    yerd.page.apply('<ul id="f" data-yx-region data-yx-prepend><li data-key="1">1</li><li data-key="2">2</li><li data-key="3">3!</li></ul>');
    expect(Array.from(document.querySelectorAll("li"), (li) => li.textContent)).toEqual(["1", "2", "3!"]);
  });

  it("an empty appending region changes nothing", () => {
    document.body.innerHTML = '<ul id="f" data-yx-region><li>1</li></ul>';
    expect(yerd.page.apply('<ul id="f" data-yx-region data-yx-append></ul>')).toBe(1);
    expect(document.getElementById("f")!.innerHTML).toBe("<li>1</li>");
  });

  it("a <script> in a response region is inserted inert", () => {
    (window as unknown as { pwned?: boolean }).pwned = false;
    document.body.innerHTML = '<div id="a" data-yx-region></div>';
    yerd.page.apply('<div id="a" data-yx-region><script>window.pwned = true</script></div>');
    expect((window as unknown as { pwned?: boolean }).pwned).toBe(false);
  });

  it("an <img onerror> in a response is the server's markup, inserted as an element (no string HTML is built)", () => {
    document.body.innerHTML = '<div id="a" data-yx-region></div>';
    yerd.page.apply('<div id="a" data-yx-region>&lt;img src=x onerror=alert(1)&gt;</div>');
    expect(document.querySelector("#a img")).toBeNull();
    expect(document.getElementById("a")!.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});
