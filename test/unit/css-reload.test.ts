import { describe, expect, it } from "vitest";
import { css, yerd } from "@toyz/yerd";
import { cssBundleText, resetCss } from "../../src/render/css.js";

// Its own file: resetting the registry would wipe the rules other tests' classes registered.
describe("dev reloads", () => {
  it("resetRegistries forgets css, so an edited css.global doesn't linger", async () => {
    css.global`.old-global { color: red; }`;
    const app = yerd({ routes: [], services: [], handleSignals: false });
    app.resetRegistries();
    expect(cssBundleText()).not.toContain(".old-global");
    const fresh = css`color: teal;`;
    expect(cssBundleText()).toContain(`.${fresh}{color: teal;}`);
    resetCss();
  });
});

