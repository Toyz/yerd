import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commands, detectPackageManager } from "../src/pm.js";

describe("detectPackageManager", () => {
  for (const [agent, pm] of [
    ["npm/11.6.0 node/v24.11.0 linux x64 workspaces/false", "npm"],
    ["pnpm/10.18.0 npm/? node/v24.11.0 linux x64", "pnpm"],
    ["yarn/4.10.3 npm/? node/v24.11.0 darwin arm64", "yarn"],
    ["yarn/1.22.22 npm/? node/v24.11.0 win32 x64", "yarn"],
    ["bun/1.3.0 npm/? node/v24.3.0 linux x64", "bun"],
    ["deno/2.5.0 npm/? deno/2.5.0 linux x86_64", "npm"],
    ["", "npm"],
    [undefined, "npm"],
  ]) {
    it(`${agent === undefined ? "no user agent" : JSON.stringify(agent)} -> ${pm}`, () => {
      assert.equal(detectPackageManager(agent), pm);
    });
  }
});

describe("commands", () => {
  it("npm", () => {
    const c = commands("npm");
    assert.deepEqual(c.install, ["npm", "install"]);
    assert.equal(c.run("dev"), "npm run dev");
    assert.equal(c.run("test"), "npm test");
    assert.equal(c.run("start"), "npm start");
    assert.equal(c.exec, "npx");
  });

  it("pnpm", () => {
    const c = commands("pnpm");
    assert.deepEqual(c.install, ["pnpm", "install"]);
    assert.equal(c.run("dev"), "pnpm dev");
    assert.equal(c.exec, "pnpm exec");
  });

  it("yarn", () => {
    const c = commands("yarn");
    assert.deepEqual(c.install, ["yarn"]);
    assert.equal(c.run("build"), "yarn build");
    assert.equal(c.exec, "yarn");
  });

  it("bun runs scripts with `bun run`, so `test` isn't bun's own runner", () => {
    const c = commands("bun");
    assert.deepEqual(c.install, ["bun", "install"]);
    assert.equal(c.run("test"), "bun run test");
    assert.equal(c.exec, "bunx");
  });
});
