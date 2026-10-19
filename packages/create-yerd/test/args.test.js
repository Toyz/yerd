import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HELP, UsageError, parseArgs } from "../src/args.js";

describe("parseArgs", () => {
  it("leaves everything unset with no arguments", () => {
    assert.deepEqual(parseArgs([]), {
      dir: undefined,
      template: undefined,
      tailwind: undefined,
      pm: undefined,
      git: undefined,
      install: undefined,
      yes: false,
      force: false,
      help: false,
      version: false,
    });
  });

  it("reads the directory and every flag", () => {
    const args = parseArgs(["my-app", "--template", "full", "--tailwind", "--pm", "pnpm", "--no-git", "--install", "--yes", "--force"]);
    assert.equal(args.dir, "my-app");
    assert.equal(args.template, "full");
    assert.equal(args.tailwind, true);
    assert.equal(args.pm, "pnpm");
    assert.equal(args.git, false);
    assert.equal(args.install, true);
    assert.equal(args.yes, true);
    assert.equal(args.force, true);
  });

  it("takes short flags, --flag=value and negations", () => {
    const args = parseArgs(["-t", "api", "-y", "-f", "--pm=bun", "--no-tailwind", "--no-install", "."]);
    assert.equal(args.template, "api");
    assert.equal(args.yes, true);
    assert.equal(args.force, true);
    assert.equal(args.pm, "bun");
    assert.equal(args.tailwind, false);
    assert.equal(args.install, false);
    assert.equal(args.dir, ".");
  });

  it("reads --help and --version", () => {
    assert.equal(parseArgs(["-h"]).help, true);
    assert.equal(parseArgs(["--version"]).version, true);
    assert.equal(parseArgs(["-v"]).version, true);
  });

  for (const [argv, message] of [
    [["--template", "vue"], /Unknown template "vue"/],
    [["--pm", "deno"], /Unknown package manager "deno"/],
    [["--bogus"], /Unknown option '--bogus'/],
    [["a", "b"], /Expected one project directory, got 2/],
    [["--template", "api", "--tailwind"], /--tailwind needs a template with pages/],
    [["--template"], /argument missing/],
    [[""], /can't be empty/],
  ]) {
    it(`refuses ${JSON.stringify(argv)}`, () => {
      assert.throws(() => parseArgs(argv), (error) => error instanceof UsageError && message.test(error.message));
    });
  }

  it("documents every flag in --help", () => {
    for (const flag of ["--template", "--tailwind", "--no-tailwind", "--pm", "--git", "--no-git", "--install", "--no-install", "--yes", "--force", "--help", "--version"]) {
      assert.ok(HELP.includes(flag), flag);
    }
  });
});
