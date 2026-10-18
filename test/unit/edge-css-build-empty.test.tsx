import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Styles, get, prerender, renderToString, route, yerd } from "@toyz/yerd";
import { cssBundleText, resetCssBundle } from "../../src/render/css.js";

// This file registers no css`` at all: the registry is per test file.
afterEach(() => resetCssBundle());

@route("/plain-page")
@prerender()
class PlainPage {
  @get page() {
    return (
      <html>
        <head>
          <Styles />
        </head>
        <body class="just-plain">hi</body>
      </html>
    );
  }
}

describe("an app with no css``", () => {
  it("has nothing to bundle", () => {
    expect(cssBundleText()).toBe("");
  });

  it("writes no stylesheet and no css.json at build", async () => {
    const out = mkdtempSync(join(tmpdir(), "yerd-css-empty-"));
    const app = yerd({ routes: [PlainPage], services: [], handleSignals: false });
    await app.prerender(out);
    await app.stop();
    expect(existsSync(join(out, ".yerd", "css.json"))).toBe(false);
    expect(existsSync(join(out, "assets")) ? readdirSync(join(out, "assets")).filter((f) => f.endsWith(".css")) : []).toEqual([]);
    const html = readFileSync(join(out, "plain-page", "index.html"), "utf8");
    expect(html).not.toContain("<link rel=\"stylesheet\"");
    expect(html).not.toContain("data-yx-css");
  });

  it("renders <Styles /> as nothing", async () => {
    expect(await renderToString(<head><Styles /></head>)).toBe("<head></head>");
  });
});
