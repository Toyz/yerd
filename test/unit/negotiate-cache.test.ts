import { describe, expect, it } from "vitest";
import { acceptRanges, choose, media, parseAccept } from "../../src/respond/negotiate.js";

const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

describe("acceptRanges", () => {
  it("parses a header once and shares the frozen result", () => {
    const first = acceptRanges("application/json, text/*;q=0.5");
    expect(first).toEqual(parseAccept("application/json, text/*;q=0.5"));
    expect(acceptRanges("application/json, text/*;q=0.5")).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(acceptRanges(undefined)).toEqual([]);
  });

  it("keeps only the most recent headers", () => {
    const first = acceptRanges("text/x-evicted");
    for (let i = 0; i < 64; i++) acceptRanges(`text/x-filler-${i}`);
    expect(acceptRanges("text/x-evicted")).not.toBe(first);
    expect(acceptRanges("text/x-evicted")).toEqual(first);
  });

  it("leaves parseAccept's result the caller's own", () => {
    const ranges = parseAccept("application/json");
    ranges.push({ type: "text", subtype: "html", q: 1 });
    expect(parseAccept("application/json")).toHaveLength(1);
  });
});

describe("media", () => {
  it("expands and splits once", () => {
    expect(media("json")).toEqual({ full: "application/json", type: "application", subtype: "json" });
    expect(media("Application/Vnd.API+JSON")).toEqual({ full: "application/vnd.api+json", type: "application", subtype: "vnd.api+json" });
    expect(media("json")).toBe(media("json"));
  });
});

describe("choose with data prepared ahead of time", () => {
  const strings = [["application/json"], ["text/csv"]];
  const prepared = strings.map((types) => types.map(media));

  it.each([BROWSER, "application/json", "text/csv;q=0.9, application/json;q=0.5", "*/*", "image/png", undefined])(
    "picks the same variant for %j",
    (accept) => {
      for (const hasDefault of [true, false]) {
        const expected = choose(strings, accept, hasDefault);
        expect(choose(prepared, accept, hasDefault)).toBe(expected);
        expect(choose(prepared, acceptRanges(accept), hasDefault)).toBe(expected);
      }
    },
  );
});
