import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATES_DIR, VERSION, layers, outputPath, packageJson, renderFiles, substitute, variables, yerdSpec } from "../src/render.js";
import { VERSIONS } from "../src/versions.js";

const root = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
const COMBOS = [
  { template: "minimal", tailwind: false },
  { template: "minimal", tailwind: true },
  { template: "full", tailwind: false },
  { template: "full", tailwind: true },
  { template: "api", tailwind: false },
];
const options = (combo) => ({ name: "my-app", pm: "npm", yerd: "^1.2.3", ...combo });

describe("renderFiles", () => {
  for (const combo of COMBOS) {
    it(`renders ${combo.template}${combo.tailwind ? " + tailwind" : ""} with no placeholder left`, () => {
      const files = renderFiles(options(combo));
      for (const [path, text] of files) assert.doesNotMatch(text, /\{\{\w+\}\}/, path);
      for (const path of ["package.json", "tsconfig.json", "vite.config.ts", "vitest.config.ts", ".gitignore", ".env.example", "README.md", "src/main.ts", "src/app.ts"]) {
        assert.ok(files.has(path), `${path} missing`);
      }
      assert.ok(![...files.keys()].some((p) => p.split("/").some((part) => part.startsWith("_"))), "an _file was not renamed");
    });
  }

  it("gives page templates a layout, a stylesheet and a test; api none of the first two", () => {
    const minimal = renderFiles(options({ template: "minimal", tailwind: false }));
    for (const path of ["src/layouts.tsx", "src/routes/home.tsx", "src/styles.css", "test/app.test.ts", "public/favicon.svg"]) assert.ok(minimal.has(path), path);

    const full = renderFiles(options({ template: "full", tailwind: false }));
    for (const path of ["src/catalog.ts", "src/cart.ts", "src/users.ts", "src/orders.ts", "src/routes/api.ts", "test/shop.test.ts", "e2e/shop.spec.ts", "playwright.config.ts"]) {
      assert.ok(full.has(path), path);
    }

    const api = renderFiles(options({ template: "api", tailwind: false }));
    assert.ok(api.has("src/routes/notes.ts") && api.has("test/notes.test.ts"));
    assert.ok(![...api.keys()].some((p) => p.endsWith(".tsx") || p.endsWith(".css")), "api has no pages");
    assert.doesNotMatch(api.get("tsconfig.json") ?? "", /jsx/);
  });

  it("puts the project name and package manager commands in", () => {
    const files = renderFiles({ ...options({ template: "minimal", tailwind: false }), pm: "pnpm" });
    assert.match(files.get("README.md") ?? "", /^# my-app\n/);
    assert.match(files.get("README.md") ?? "", /pnpm dev/);
    assert.match(files.get("src/layouts.tsx") ?? "", /`\$\{meta\.title\} · my-app` : "my-app"/);
    const full = renderFiles({ ...options({ template: "full", tailwind: false }), pm: "yarn" });
    assert.match(full.get("playwright.config.ts") ?? "", /command: "yarn build && yarn start"/);
  });

  it("swaps in Tailwind with the overlay", () => {
    for (const template of ["minimal", "full"]) {
      const plain = renderFiles(options({ template, tailwind: false }));
      const tw = renderFiles(options({ template, tailwind: true }));
      assert.doesNotMatch(plain.get("src/styles.css") ?? "", /tailwindcss/);
      assert.match(tw.get("src/styles.css") ?? "", /^@import "tailwindcss";$/m);
      assert.match(tw.get("vite.config.ts") ?? "", /plugins: \[tailwindcss\(\), yerd\(/);
      assert.match(tw.get("src/layouts.tsx") ?? "", /<Stylesheet href="src\/styles.css" \/>/);
      assert.deepEqual([...tw.keys()], [...plain.keys()], "the overlay replaces files, it doesn't add any");
    }
  });
});

describe("packageJson", () => {
  it("has the scripts, yerd and the dev tools", () => {
    const pkg = packageJson(options({ template: "minimal", tailwind: false }));
    assert.equal(pkg.name, "my-app");
    assert.equal(pkg.type, "module");
    assert.equal(pkg.private, true);
    assert.deepEqual(Object.keys(pkg.scripts), ["dev", "build", "start", "test", "check"]);
    assert.equal(pkg.scripts.start, "node --env-file-if-exists=.env dist/server/server.js");
    assert.deepEqual(pkg.dependencies, { "@toyz/yerd": "^1.2.3" });
    assert.deepEqual(Object.keys(pkg.devDependencies), ["@types/node", "esbuild", "typescript", "vite", "vitest"]);
  });

  it("adds Tailwind and Playwright where they're used", () => {
    const pkg = packageJson(options({ template: "full", tailwind: true }));
    assert.equal(pkg.scripts.e2e, "playwright test");
    assert.ok(pkg.devDependencies["@playwright/test"]);
    assert.ok(pkg.devDependencies.tailwindcss && pkg.devDependencies["@tailwindcss/vite"]);
    assert.equal(packageJson(options({ template: "api", tailwind: false })).devDependencies.tailwindcss, undefined);
  });
});

describe("versions", () => {
  it("is released with yerd, at the same version", () => {
    assert.equal(VERSION, root.version);
    assert.equal(yerdSpec({}), `^${root.version}`);
  });

  it("lets tests point @toyz/yerd at a local build", () => {
    assert.equal(yerdSpec({ CREATE_YERD_YERD_SPEC: "file:/repo" }), "file:/repo");
  });

  it("uses the dev dependency ranges yerd itself is tested with", () => {
    for (const [dep, range] of Object.entries(VERSIONS)) assert.equal(range, root.devDependencies[dep], dep);
  });
});

describe("helpers", () => {
  it("renames _files to dotfiles", () => {
    assert.equal(outputPath("_gitignore"), ".gitignore");
    assert.equal(outputPath("_env.example"), ".env.example");
    assert.equal(outputPath("src/main.ts"), "src/main.ts");
  });

  it("refuses a placeholder it doesn't know", () => {
    assert.equal(substitute("{{name}} {x: {a: 1}}", { name: "app" }), "app {x: {a: 1}}");
    assert.throws(() => substitute("{{nmae}}", { name: "app" }, "README.md"), /README.md: unknown placeholder \{\{nmae\}\}/);
  });

  it("lists layers in overlay order", () => {
    assert.deepEqual(layers("full", true), ["_shared", "full", "tailwind/_shared", "tailwind/full"]);
    assert.deepEqual(layers("api", false), ["_shared", "api"]);
  });

  it("has a value for every placeholder", () => {
    const vars = variables(options({ template: "full", tailwind: false }));
    for (const value of Object.values(vars)) assert.equal(typeof value, "string");
  });
});

describe("template files", () => {
  /** @returns {string[]} */
  const walk = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));

  it("are plain text: no emoji, no tabs, a final newline", () => {
    for (const file of walk(TEMPLATES_DIR)) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /\p{Extended_Pictographic}/u, file);
      assert.doesNotMatch(text, /\t/, file);
      assert.ok(text.endsWith("\n"), `${file} has no final newline`);
    }
  });
});
