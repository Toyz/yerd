import { describe, expect, it } from "vitest";
import { Styles, css, keyframes, raw } from "@toyz/yerd";
import { classesIn } from "../../src/render/attrs.js";
import { cssBundleClasses, cssBundleHash, cssBundleText, stylesFor } from "../../src/render/css.js";

/** A template call with hand-written strings (as if the text had been typed literally). */
function literal(text: string): TemplateStringsArray {
  return Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray;
}

/** The rule text stylesFor would send for one class (fresh `sent` set). */
function ruleOf(name: string): string {
  const html = stylesFor(new Set([name]), new Set());
  const all = [...html.matchAll(/<style data-yx-css="([^"]+)">([\s\S]*?)<\/style>/g)];
  return all.find((m) => m[1] === name)?.[2] ?? "";
}

/** The class names, in order, of every <style data-yx-css> in some HTML. */
function sent(html: string): string[] {
  return [...html.matchAll(/<style data-yx-css="([^"]+)">/g)].map((m) => m[1]!);
}

const NAME = /^yx-[0-9a-z]{2,10}$/;
const KF_NAME = /^yx-k-[0-9a-z]{2,10}$/;

describe("hashing: determinism", () => {
  it.each([
    "color: red;",
    "padding: 0 4px; margin: 0;",
    "&:hover { color: blue; }",
    "@media (width < 600px) { & { display: none; } }",
    "--x: 1;",
    "",
    "a",
    "content: '\\201C';",
  ])("the same text is the same class, every time (%j)", (text) => {
    const a = css(literal(text));
    const b = css(literal(text));
    expect(a).toBe(b);
    expect(a).toMatch(NAME);
    // Interpolating the whole text is the same as typing it.
    expect(css`${text}`).toBe(a);
  });

  it("pins the hash of a known text (a changed algorithm would break mixed deploys)", () => {
    expect(css`color: rebeccapurple;`).toBe("yx-sdn89mvfyn");
    expect(keyframes`color: rebeccapurple;`).toBe("yx-k-sdn89mvfyn");
    expect(cssBundleHash("color: rebeccapurple;")).toBe("sdn89mvfyn");
  });

  it("is a pure function of the text: cssBundleHash agrees with the class name", () => {
    for (const text of ["x: 1;", "y: 2;", "z: 3;"]) expect(css(literal(text))).toBe(`yx-${cssBundleHash(text)}`);
  });

  it("gives an empty rule a class too, with an empty block", () => {
    const empty = css``;
    expect(empty).toMatch(NAME);
    expect(ruleOf(empty)).toBe(`.${empty}{}`);
    expect(css`   `).toBe(empty);
  });
});

describe("hashing: whitespace", () => {
  it.each([
    ["leading spaces", "   color: navy;"],
    ["trailing spaces", "color: navy;   "],
    ["both", "  color: navy;  "],
    ["newlines", "\n\ncolor: navy;\n\n"],
    ["tabs", "\t\tcolor: navy;\t"],
    ["CRLF around", "\r\ncolor: navy;\r\n"],
  ])("ignores %s around the rules", (_label, text) => {
    expect(css(literal(text))).toBe(css`color: navy;`);
  });

  it.each([
    ["an extra inner space", "color:  navy;"],
    ["no space", "color:navy;"],
    ["a tab inside", "color:\tnavy;"],
    ["a newline inside", "color:\nnavy;"],
    ["CRLF inside", "a: 1;\r\nb: 2;"],
  ])("keeps %s (a different text is a different class)", (_label, text) => {
    expect(css(literal(text))).not.toBe(css`color: navy;`);
  });

  it("treats CRLF and LF inside as different texts", () => {
    expect(css(literal("a: 1;\r\nb: 2;"))).not.toBe(css(literal("a: 1;\nb: 2;")));
  });

  it("trims the rule text it sends, too", () => {
    const name = css(literal("\n   color: teal;   \n"));
    expect(ruleOf(name)).toBe(`.${name}{color: teal;}`);
  });
});

describe("hashing: unicode", () => {
  it.each([
    ["CJK", "content: '漢字';"],
    ["accented", "content: 'été';"],
    ["astral (surrogate pair)", "content: '\u{10348}';"],
    ["a lone surrogate", "content: '\ud800';"],
    ["right-to-left", "content: 'שלום';"],
    ["zero-width joiner", "content: 'a‍b';"],
    ["NUL", "content: 'a\u0000b';"],
  ])("hashes %s text to a plain ascii class name, stably", (_label, text) => {
    const name = css(literal(text));
    expect(name).toMatch(NAME);
    expect(css(literal(text))).toBe(name);
    expect(ruleOf(name)).toBe(`.${name}{${text}}`);
  });

  it("does not normalize: NFC and NFD spellings are different classes", () => {
    const nfc = "content: 'é';";
    const nfd = "content: 'é';";
    expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC"));
    expect(css(literal(nfc))).not.toBe(css(literal(nfd)));
  });

  it("tells apart texts that differ only in one astral character", () => {
    expect(css(literal("content: '\u{1F600}';"))).not.toBe(css(literal("content: '\u{1F601}';")));
  });
});

describe("hashing: very long rules", () => {
  const long = "a".repeat(1 << 20);

  it("handles a megabyte of rules", () => {
    const name = css`--big: "${long}";`;
    expect(name).toMatch(NAME);
    expect(ruleOf(name).length).toBe(name.length + 3 + `--big: "${long}";`.length);
  });

  it("notices a change in the last character of a long text", () => {
    expect(css`--big: "${long}x";`).not.toBe(css`--big: "${long}y";`);
  });

  it("notices a change in the first character of a long text", () => {
    expect(css`--a: "${long}";`).not.toBe(css`--b: "${long}";`);
  });

  it("notices a change of length alone", () => {
    expect(css`--big: "${long}";`).not.toBe(css`--big: "${long}a";`);
  });
});

describe("hashing: no collisions", () => {
  it("gives 20000 distinct near-identical rules 20000 distinct classes", () => {
    const names = new Set<string>();
    for (let i = 0; i < 20000; i++) names.add(css`width: ${i}px;`);
    expect(names.size).toBe(20000);
    for (const name of names) expect(name).toMatch(NAME);
  });

  it("gives 5000 distinct keyframes 5000 distinct names", () => {
    const names = new Set<string>();
    for (let i = 0; i < 5000; i++) names.add(keyframes`to { opacity: ${i / 5000}; }`);
    expect(names.size).toBe(5000);
  });

  it("has no collision in 200000 short texts (permutations, prefixes, single characters)", () => {
    const hashes = new Map<string, string>();
    const add = (text: string) => {
      const h = cssBundleHash(text);
      const seen = hashes.get(h);
      if (seen !== undefined && seen !== text) throw new Error(`${JSON.stringify(seen)} and ${JSON.stringify(text)} both hash to ${h}`);
      hashes.set(h, text);
    };
    for (let i = 0; i < 65536; i++) add(String.fromCharCode(i));
    for (let i = 0; i < 100000; i++) add(i.toString(36));
    for (let i = 0; i < 40000; i++) add(`.c${i}{}`);
    expect(hashes.size).toBeGreaterThan(200000);
  });

  it("tells permutations of the same characters apart", () => {
    expect(cssBundleHash("ab")).not.toBe(cssBundleHash("ba"));
    expect(cssBundleHash("a:1;b:2;")).not.toBe(cssBundleHash("b:2;a:1;"));
  });

  it("keeps hash output short and in base36", () => {
    for (const text of ["", "x", "y".repeat(10000)]) expect(cssBundleHash(text)).toMatch(/^[0-9a-z]{2,10}$/);
  });
});

describe("hashing: the collision error path", () => {
  // The hash can't be collided by hand at this size, so flatten Math.imul (which
  // the hash multiplies with) to make every text hash alike for a moment.
  function flat<T>(fn: () => T): T {
    const imul = Math.imul;
    Math.imul = () => 0;
    try {
      return fn();
    } finally {
      Math.imul = imul;
    }
  }

  it("refuses a second, different rule set under a name already taken", () => {
    flat(() => {
      const first = css`--collide: 1;`;
      expect(first).toBe("yx-00");
      expect(() => css`--collide: 2;`).toThrow(/two different rule sets hash to yx-00/);
      // The same text again is fine: it's the same rule.
      expect(css`--collide: 1;`).toBe(first);
    });
    // The refused one was never registered; the first one is intact.
    expect(ruleOf("yx-00")).toBe(".yx-00{--collide: 1;}");
    expect(cssBundleText()).not.toContain("--collide: 2;");
  });

  it("keeps keyframes in their own namespace: a keyframes hash never collides with a class", () => {
    flat(() => {
      const name = keyframes`to { --collide: 3; }`;
      expect(name).toBe("yx-k-00");
      expect(() => keyframes`to { --collide: 4; }`).toThrow(/yx-k-00/);
    });
  });
});

describe("hashing: keyframes and classes", () => {
  it("names the same text differently as a class and as keyframes", () => {
    const text = "from { opacity: 0; } to { opacity: 1; }";
    const asClass = css(literal(text));
    const asKeyframes = keyframes(literal(text));
    expect(asClass).toMatch(NAME);
    expect(asKeyframes).toMatch(KF_NAME);
    expect(asKeyframes.slice(5)).toBe(asClass.slice(3));
    expect(ruleOf(asClass)).toBe(`.${asClass}{${text}}`);
    expect(ruleOf(asKeyframes)).toBe(`@keyframes ${asKeyframes}{${text}}`);
  });

  it("never makes a class name that looks like keyframes (base36 has no dash)", () => {
    for (let i = 0; i < 2000; i++) expect(css`--n: ${i};`.startsWith("yx-k-")).toBe(false);
  });
});

describe("interpolation: value types", () => {
  const withToString = { toString: () => "calc(1px + 2px)" };
  const withPrimitive = { [Symbol.toPrimitive]: () => "3em" };

  it.each<[string, unknown, string]>([
    ["0", 0, "0"],
    ["a negative number", -1, "-1"],
    ["a fraction", 1.5, "1.5"],
    ["-0", -0, "0"],
    ["NaN", Number.NaN, "NaN"],
    ["Infinity", Number.POSITIVE_INFINITY, "Infinity"],
    ["a huge number", 1e21, "1e+21"],
    ["a bigint", 10n, "10"],
    ["a negative bigint", -7n, "-7"],
    ["true", true, "true"],
    ["false", false, ""],
    ["null", null, ""],
    ["undefined", undefined, ""],
    ["an empty string", "", ""],
    ["a string", "4px", "4px"],
    ["an object with toString", withToString, "calc(1px + 2px)"],
    ["an object with Symbol.toPrimitive", withPrimitive, "3em"],
    ["a plain object", {}, "[object Object]"],
    ["an array", [1, 2], "1,2"],
    ["an empty array", [], ""],
    ["an array of nothing", [null, undefined], ","],
    ["a nested array", [[1, [2]], 3], "1,2,3"],
    ["a String object", new String("5px"), "5px"],
  ])("writes %s as its text", (_label, value, expected) => {
    const name = css`--v: [${value}];`;
    expect(ruleOf(name)).toBe(`.${name}{--v: [${expected}];}`);
  });

  it("writes a symbol as its description (String() accepts one where `${}` alone would throw)", () => {
    const name = css`--s: ${Symbol("x")};`;
    expect(ruleOf(name)).toBe(`.${name}{--s: Symbol(x);}`);
  });

  it("writes 0 and an empty string differently (0 isn't nothing)", () => {
    expect(css`--z: ${0};`).not.toBe(css`--z: ${""};`);
  });

  it("collapses false, null, undefined and an empty string to the same rule", () => {
    const names = new Set([false, null, undefined, ""].map((v) => css`--n: ${v};`));
    expect(names.size).toBe(1);
  });

  it("trims after interpolating: values at the edges are trimmed with the text", () => {
    expect(css`${"  color: olive;  "}`).toBe(css`color: olive;`);
    expect(css`${null}color: olive;${undefined}`).toBe(css`color: olive;`);
  });
});

describe("interpolation: class and keyframes references", () => {
  const base = css`color: black;`;
  const fade = keyframes`from { opacity: 0; }`;
  const spin = keyframes`to { rotate: 1turn; }`;

  it("writes another class as its selector", () => {
    const child = css`${base}:hover & { color: red; }`;
    expect(ruleOf(child)).toBe(`.${child}{.${base}:hover & { color: red; }}`);
  });

  it("does not send a referenced class's rules along (it's only a selector)", () => {
    const child = css`${base} > & { margin: 0; }`;
    expect(sent(stylesFor(new Set([child]), new Set()))).toEqual([child]);
  });

  it("chains selectors through several levels without pulling rules", () => {
    const a = css`--lvl: a;`;
    const b = css`${a} & { --lvl: b; }`;
    const c = css`${b} & { --lvl: c; }`;
    expect(ruleOf(c)).toContain(`.${b} &`);
    expect(sent(stylesFor(new Set([c]), new Set()))).toEqual([c]);
  });

  it("writes keyframes as their name and sends them first", () => {
    const anim = css`animation: ${fade} 1s;`;
    expect(ruleOf(anim)).toContain(`animation: ${fade} 1s;`);
    expect(sent(stylesFor(new Set([anim]), new Set()))).toEqual([fade, anim]);
  });

  it("sends every keyframes a rule uses, in the order they appear, once", () => {
    const both = css`animation: ${spin} 1s, ${fade} 2s; --again: ${spin};`;
    expect(sent(stylesFor(new Set([both]), new Set()))).toEqual([spin, fade, both]);
  });

  it("sends shared keyframes once for several rules", () => {
    const one = css`animation: ${fade} 1s; --one: 1;`;
    const two = css`animation: ${fade} 2s; --two: 2;`;
    expect(sent(stylesFor(new Set([one, two]), new Set()))).toEqual([fade, one, two]);
  });

  it("doesn't resend keyframes already sent on the page", () => {
    const page = new Set<string>();
    const one = css`animation: ${fade} 3s;`;
    const two = css`animation: ${fade} 4s;`;
    expect(sent(stylesFor(new Set([one]), page))).toEqual([fade, one]);
    expect(sent(stylesFor(new Set([two]), page))).toEqual([two]);
  });

  it("writes keyframes referenced from keyframes as the bare name", () => {
    const outer = keyframes`from { --inner: ${fade}; }`;
    expect(ruleOf(outer)).toBe(`@keyframes ${outer}{from { --inner: ${fade}; }}`);
  });

  it("lets keyframes interpolate any value", () => {
    const k = keyframes`to { width: ${50}%; opacity: ${0.5}; --x: ${null}; --y: ${10n}; }`;
    expect(ruleOf(k)).toBe(`@keyframes ${k}{to { width: 50%; opacity: 0.5; --x: ; --y: 10; }}`);
  });

  it("keeps a rule's keyframes even when the same text is registered again without them", () => {
    const anim = css`animation: ${fade} 5s;`;
    // Typed out by hand: the same text, but no keyframes reference this time.
    expect(css(literal(`animation: ${fade} 5s;`))).toBe(anim);
    expect(sent(stylesFor(new Set([anim]), new Set()))).toEqual([fade, anim]);
  });

  it("only treats an exact registered name as a reference, not one with extra text", () => {
    const near = css`--near: ${` ${base}`};`;
    expect(ruleOf(near)).toBe(`.${near}{--near:  ${base};}`);
  });
});

describe("css.global", () => {
  it("dedupes identical global text (after trimming) and keeps first-seen order", () => {
    css.global`html { --order: 1; }`;
    css.global`html { --order: 2; }`;
    css.global`  html { --order: 1; }  `;
    css.global`html { --order: 3; }`;
    const text = cssBundleText();
    expect(text.match(/--order: 1;/g)).toHaveLength(1);
    expect(text.indexOf("--order: 1;")).toBeLessThan(text.indexOf("--order: 2;"));
    expect(text.indexOf("--order: 2;")).toBeLessThan(text.indexOf("--order: 3;"));
  });

  it("keeps globals that differ only inside as separate", () => {
    css.global`main { --gap:  1; }`;
    css.global`main { --gap: 1; }`;
    const text = cssBundleText();
    expect(text).toContain("--gap:  1;");
    expect(text).toContain("--gap: 1;");
  });

  it("puts every global before every scoped rule in the bundle", () => {
    const late = css`--after-globals: 1;`;
    css.global`body { --late-global: 1; }`;
    const text = cssBundleText();
    expect(text.indexOf("--late-global")).toBeLessThan(text.indexOf(`.${late}{`));
  });

  it("writes a class referenced in a global as its selector", () => {
    const target = css`--target: 1;`;
    css.global`body:has(${target}) { --has-target: 1; }`;
    expect(Styles().html).toContain(`body:has(.${target}) { --has-target: 1; }`);
  });

  it("brings keyframes a global animates with into <Styles />", () => {
    const blink = keyframes`50% { opacity: 0.25; }`;
    css.global`.cursor-global { animation: ${blink} 1s infinite; }`;
    const html = Styles().html;
    expect(html).toContain(`@keyframes ${blink}{`);
    expect(html.indexOf(`@keyframes ${blink}{`)).toBeLessThan(html.indexOf(".cursor-global"));
    // ...once, and the bundle doesn't repeat it either.
    expect(html.split(`@keyframes ${blink}{`)).toHaveLength(2);
    expect(cssBundleText().split(`@keyframes ${blink}{`)).toHaveLength(2);
  });

  it("returns nothing (it isn't a class)", () => {
    expect(css.global`p { --ret: 1; }`).toBeUndefined();
  });
});

describe("injection: </style", () => {
  it.each([
    "</style>",
    "</STYLE>",
    "</StYlE>",
    "</style >",
    "</style\n>",
    "</style\t",
    "</style/",
    "</style",
    "a</styleb",
    "x { content: '</style><script>alert(1)</script>'; }",
  ])("refuses %j in a rule", (text) => {
    expect(() => css(literal(text))).toThrow(/<\/style/);
    expect(() => keyframes(literal(text))).toThrow(/<\/style/);
    expect(() => css.global(literal(text))).toThrow(/<\/style/);
  });

  it.each<[string, unknown]>([
    ["a string", "</style>"],
    ["an uppercase string", "</STYLE"],
    ["an object's toString", { toString: () => "</sTyLe>" }],
    ["an array that joins into one", ["</style", ">"]],
  ])("refuses </style that arrives through an interpolated %s", (_label, value) => {
    expect(() => css`content: "${value}";`).toThrow(/<\/style/);
    expect(() => keyframes`to { --x: "${value}"; }`).toThrow(/<\/style/);
    expect(() => css.global`body { --x: "${value}"; }`).toThrow(/<\/style/);
  });

  it("refuses </style split across the template and a value", () => {
    expect(() => css`content: "</${"style"}>";`).toThrow(/<\/style/);
    expect(() => css`content: "${"<"}/style>";`).toThrow(/<\/style/);
  });

  it.each([
    ["< /style>", "a space after < isn't a tag"],
    ["<\\/style>", "a CSS escape"],
    ["<style>", "an opening tag can't close anything"],
    ["<!-- -->", "comments mean nothing in <style>"],
    ["</script>", "another element's end tag"],
    ["&lt;/style&gt;", "entities aren't decoded in <style>"],
  ])("accepts %j (%s)", (text) => {
    const name = css`content: "${text}";`;
    expect(ruleOf(name)).toContain(text);
  });

  it("registers nothing for a refused rule", () => {
    const before = cssBundleClasses().length;
    expect(() => css`--refused: "</style>";`).toThrow();
    expect(() => keyframes`to { --refused: "</style>"; }`).toThrow();
    expect(() => css.global`--refused-global { a: "</style>"; }`).toThrow();
    expect(cssBundleClasses().length).toBe(before);
    expect(cssBundleText()).not.toContain("--refused");
  });

  it("writes data-yx-css values that are always plain names", () => {
    const html = stylesFor(new Set(cssBundleClasses().slice(0, 500)), new Set());
    for (const name of sent(html)) expect(name).toMatch(/^yx-(k-)?[0-9a-z]+$/);
  });
});

describe("class names can't be spoofed", () => {
  const real = css`--real: 1;`;

  it.each([
    ["an unregistered yx- name", "yx-abcdef1234"],
    ["an unregistered keyframes-like name", "yx-k-abcdef"],
    ["the real name in uppercase", real.toUpperCase()],
    ["the real name with a suffix", `${real}x`],
    ["the real name with a prefix", `x${real}`],
    ["the real name as a selector", `.${real}`],
    ["the real name in a longer token", `${real}-hover`],
    ["prototype keys", "__proto__ constructor toString hasOwnProperty valueOf"],
  ])("ignores %s", (_label, value) => {
    expect([...classesIn(value)]).toEqual([]);
    expect(stylesFor(classesIn(value), new Set())).toBe("");
  });

  it("finds the real name among look-alikes", () => {
    expect([...classesIn(`yx-fake ${real} ${real}x .${real}`)]).toEqual([real]);
  });

  it("splits on every kind of whitespace", () => {
    expect([...classesIn(`\t${real}\n`)]).toEqual([real]);
    expect([...classesIn(`a\r\n${real}\fb`)]).toEqual([real]);
  });

  it("ignores names stylesFor is handed that were never registered, and marks them seen", () => {
    const seen = new Set<string>();
    expect(stylesFor(new Set(["yx-ghost"]), seen)).toBe("");
    expect(seen.has("yx-ghost")).toBe(true);
  });

  it("reads raw() class values as their text", () => {
    expect([...classesIn(raw(`other ${real}`))]).toEqual([real]);
  });

  it("ignores values that hold no class names", () => {
    for (const value of [null, undefined, false, true, 0, 1, "", [], {}, () => real, Symbol("x")]) {
      expect([...classesIn(value)]).toEqual([]);
    }
  });

  it("reads flag object keys whether the flag is on or off", () => {
    expect([...classesIn({ [real]: false })]).toEqual([real]);
    expect([...classesIn({ [real]: true })]).toEqual([real]);
    expect([...classesIn({ [`plain ${real}`]: 0 })]).toEqual([real]);
  });

  it("accumulates into a given set", () => {
    const other = css`--other: 1;`;
    const out = classesIn(real);
    classesIn([other], out);
    expect([...out]).toEqual([real, other]);
  });
});
