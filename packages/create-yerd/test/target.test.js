import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectTarget, packageName, resolveTarget, validateDir } from "../src/target.js";

describe("packageName", () => {
  for (const [path, typed, name] of [
    ["/work/my-app", "my-app", "my-app"],
    ["/work/My App", "My App", "my-app"],
    ["/work/.hidden", ".hidden", "hidden"],
    ["/work/café & bar!", undefined, "caf-bar"],
    ["/work/apps/web", "apps/web", "web"],
    ["/work/@me/tool", "@me/tool", "@me/tool"],
    ["/work/___", undefined, "yerd-app"],
  ]) {
    it(`${JSON.stringify(path)} -> ${name}`, () => {
      assert.equal(packageName(path, typed), name);
    });
  }
});

describe("resolveTarget", () => {
  it("resolves . to the current folder and names against it", () => {
    assert.equal(resolveTarget(".", "/work/here"), "/work/here");
    assert.equal(resolveTarget("app", "/work"), "/work/app");
  });
});

describe("validateDir", () => {
  it("refuses blanks and characters folders can't have", () => {
    assert.match(validateDir("  ") ?? "", /Enter a directory/);
    assert.match(validateDir("a|b") ?? "", /characters/);
    assert.equal(validateDir("my-app"), undefined);
    assert.equal(validateDir("."), undefined);
  });
});

describe("inspectTarget", () => {
  const root = mkdtempSync(join(tmpdir(), "create-yerd-target-"));
  after(() => rmSync(root, { recursive: true, force: true }));

  it("tells missing, empty, not-empty and file apart", () => {
    assert.equal(inspectTarget(join(root, "nothing")), "missing");

    mkdirSync(join(root, "empty"));
    assert.equal(inspectTarget(join(root, "empty")), "empty");

    mkdirSync(join(root, "used"));
    writeFileSync(join(root, "used", "index.js"), "");
    assert.equal(inspectTarget(join(root, "used")), "not-empty");

    writeFileSync(join(root, "file.txt"), "");
    assert.equal(inspectTarget(join(root, "file.txt")), "file");
  });

  it("counts a folder holding only .git or editor files as empty", () => {
    mkdirSync(join(root, "fresh", ".git"), { recursive: true });
    writeFileSync(join(root, "fresh", ".DS_Store"), "");
    assert.equal(inspectTarget(join(root, "fresh")), "empty");
  });
});
