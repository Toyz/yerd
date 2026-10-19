import { defineConfig } from "@playwright/test";
import base, { crossBrowser } from "./playwright.config.js";

/**
 * The full matrix: the default Chrome projects plus Firefox, WebKit and
 * phones (`npm run e2e:all`; CI runs this, sharded).
 */
export default defineConfig({
  ...base,
  projects: [...(base.projects ?? []), ...crossBrowser],
});
