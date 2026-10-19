import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("the published package", () => {
  it("ships the CLI and every template file, and nothing else", () => {
    const output = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", shell: process.platform === "win32" }));
    // npm 11 prints an array of reports, npm 12 an object keyed by package name.
    const report = Array.isArray(output) ? output[0] : output["create-yerd"];
    const shipped = new Set(report.files.map((f) => f.path));

    /** @returns {string[]} */
    const walk = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
    for (const file of [...walk(join(root, "templates")), ...walk(join(root, "src")), join(root, "bin/create-yerd.js")]) {
      const path = relative(root, file).split(sep).join("/");
      assert.ok(shipped.has(path), `${path} isn't published`);
    }
    for (const path of shipped) assert.match(path, /^(bin|src|templates)\/|^(package\.json|README\.md|LICENSE)$/, `${path} shouldn't be published`);
  });
});
