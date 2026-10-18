import { afterEach, describe, expect, it } from "vitest";
import { attribute, resetAttributeRegistry, type ClientSetup } from "@toyz/yerd";
import { attributesSource } from "../../src/attributes/attribute.js";

afterEach(() => resetAttributeRegistry());

// Client halves as a compiler or minifier may print them.
const fn = (source: string) => new Function(`return ${source}`)() as ClientSetup;

/** Evaluate the registration script and return what each attribute registered. */
function registered(): Map<string, Function> {
  const out = new Map<string, Function>();
  new Function("window", attributesSource())({ yerd: { attribute: (name: string, setup: Function) => out.set(name, setup) } });
  return out;
}

describe("client half source", () => {
  it.each([
    ["(el) => { el.title = 'x' }", "(el) => { el.title = 'x' }"],
    ["el => el.remove()", "el => el.remove()"],
    ["async (el) => { el.title = 'x' }", "async (el) => { el.title = 'x' }"],
    // Minified: no space after async. It was taken for method shorthand and
    // wrapped into ({ async(el)=>... })[""], which doesn't parse.
    ["async(el)=>{el.title='x'}", "async(el)=>{el.title='x'}"],
    ["async el=>{el.title='x'}", "async el=>{el.title='x'}"],
    ["function (el) { el.title = 'x' }", "function (el) { el.title = 'x' }"],
    ["function named(el) { el.title = 'x' }", "function named(el) { el.title = 'x' }"],
    ["async function (el) { el.title = 'x' }", "async function (el) { el.title = 'x' }"],
    ["async => async", "async => async"],
  ])("%s", (source, written) => {
    attribute("probe", { client: fn(source) });
    expect(attributesSource()).toBe(`((yerd) => {\n  yerd.attribute("probe", ${written});\n})(window.yerd);\n`);
    expect(typeof registered().get("probe")).toBe("function");
  });

  it.each([
    ["{ client(el) { el.title = 'x' } }.client", '({ client(el) { el.title = \'x\' } })["client"]'],
    ["{ async client(el) { el.title = 'x' } }.client", '({ async client(el) { el.title = \'x\' } })["client"]'],
    ["{ *client(el) {} }.client", '({ *client(el) {} })["client"]'],
    ['{ "my-client"(el) {} }["my-client"]', '({ "my-client"(el) {} })["my-client"]'],
    ["{ asyncSetup(el) {} }.asyncSetup", '({ asyncSetup(el) {} })["asyncSetup"]'],
    ["{ functional(el) {} }.functional", '({ functional(el) {} })["functional"]'],
  ])("wraps method shorthand: %s", (source, written) => {
    attribute("probe", { client: fn(`(${source})`) });
    expect(attributesSource()).toContain(`yerd.attribute("probe", ${written});`);
    expect(typeof registered().get("probe")).toBe("function");
  });

  it("is empty with no client halves, and skips server-only attributes", () => {
    expect(attributesSource()).toBe("");
    attribute("server-only", { render: (v: string) => ({ "data-v": v }) });
    expect(attributesSource()).toBe("");
  });

  it("lists attributes in definition order and refreshes when one is added", () => {
    attribute("b-one", { client: fn("() => {}") });
    const first = attributesSource();
    expect(attributesSource()).toBe(first);
    attribute("a-two", { client: fn("() => {}") });
    expect([...registered().keys()]).toEqual(["b-one", "a-two"]);
  });

  it("refuses compiler helpers", () => {
    attribute("probe", { client: fn("function () { return __awaiter(this, void 0, void 0, function* () {}) }") });
    expect(() => attributesSource()).toThrow('The client half of attribute "probe" uses a compiler helper');
  });
});
