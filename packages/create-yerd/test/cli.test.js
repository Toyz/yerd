import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { main } from "../src/cli.js";

const work = mkdtempSync(join(tmpdir(), "create-yerd-cli-"));
after(() => rmSync(work, { recursive: true, force: true }));

function sink() {
  const stream = new Writable({
    write(chunk, _encoding, done) {
      stream.text += chunk;
      done();
    },
  });
  stream.text = "";
  return stream;
}

/**
 * Runs the CLI in `work` with piped input. Commands it would run are recorded, not run.
 * @param {string[]} argv
 * @param {{ input?: string, env?: Record<string, string>, fail?: string[] }} [options] `fail`: commands that fail
 */
async function cli(argv, { input = "", env = {}, fail = [] } = {}) {
  const stdin = new PassThrough();
  stdin.end(input);
  const stdout = sink();
  const stderr = sink();
  /** @type {string[]} */
  const ran = [];
  const code = await main({
    argv,
    env: { NO_COLOR: "1", ...env },
    cwd: work,
    stdin,
    stdout,
    stderr,
    exec: (cmd, args) => {
      const line = [cmd, ...args].join(" ");
      ran.push(line);
      if (line === "git rev-parse --is-inside-work-tree") return false;
      return !fail.some((f) => line.startsWith(f));
    },
  });
  return { code, out: stdout.text, err: stderr.text, ran };
}

describe("create-yerd", () => {
  it("prints help and the version", async () => {
    assert.match((await cli(["--help"])).out, /^Usage: create-yerd/);
    assert.match((await cli(["--version"])).out, /^\d+\.\d+\.\d+\n$/);
  });

  it("refuses a bad flag with exit code 1", async () => {
    const { code, err } = await cli(["--template", "nope"]);
    assert.equal(code, 1);
    assert.match(err, /error Unknown template "nope"/);
  });

  it("scaffolds with --yes, installs, initializes git and prints next steps", async () => {
    const { code, out, ran } = await cli(["yes-app", "--yes"], { env: { npm_config_user_agent: "pnpm/10.0.0 npm/? node/v24.0.0" } });
    assert.equal(code, 0);
    const dir = join(work, "yes-app");
    assert.ok(existsSync(join(dir, "src/routes/home.tsx")), "the minimal template is the default");
    assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name, "yes-app");
    assert.deepEqual(ran, ["pnpm install", "git --version", "git rev-parse --is-inside-work-tree", "git init -q", "git add -A", "git commit -q -m Initial commit from create-yerd"]);
    assert.match(out, /Next steps:\n\n {2}cd yes-app\n {2}pnpm dev +# http:\/\/localhost:5173\n/);
    assert.doesNotMatch(out, /\x1b\[/, "NO_COLOR: no escape codes");
  });

  it("does what the flags say, with no questions", async () => {
    const { code, out, ran } = await cli(["flags-app", "--template", "api", "--pm", "bun", "--no-git", "--no-install"]);
    assert.equal(code, 0);
    assert.deepEqual(ran, []);
    assert.ok(existsSync(join(work, "flags-app/src/routes/notes.ts")));
    assert.match(out, /cd flags-app\n {2}bun install\n {2}bun run dev +# http:\/\/localhost:5173\/api\/notes/);
    assert.doesNotMatch(out, /Template:|Package manager:/);
  });

  it("asks for what's missing, one line each when input isn't a terminal", async () => {
    // directory, template (2 = Minimal), tailwind, package manager (default), git, install
    const { code, out } = await cli([], { input: "asked-app\n2\ny\n\nn\nn\n" });
    assert.equal(code, 0);
    assert.match(out, /Project directory: \(yerd-app\): /);
    assert.match(out, /Template:\n {2}1\) Full app/);
    const pkg = JSON.parse(readFileSync(join(work, "asked-app/package.json"), "utf8"));
    assert.ok(pkg.devDependencies.tailwindcss, "tailwind: yes");
    assert.match(readFileSync(join(work, "asked-app/src/styles.css"), "utf8"), /@import "tailwindcss"/);
  });

  it("uses the defaults when input runs out", async () => {
    const { code, ran } = await cli(["eof-app"], { input: "" });
    assert.equal(code, 0);
    assert.ok(existsSync(join(work, "eof-app/src/routes/home.tsx")));
    assert.equal(ran[0], "npm install");
  });

  it("doesn't ask about Tailwind for the api template", async () => {
    const { code, out } = await cli(["api-app"], { input: "3\n" });
    assert.equal(code, 0);
    assert.ok(existsSync(join(work, "api-app/src/routes/notes.ts")));
    assert.doesNotMatch(out, /Tailwind/);
  });

  it("refuses --tailwind once api is picked", async () => {
    const { code, err } = await cli(["api-tw", "--tailwind"], { input: "3\n" });
    assert.equal(code, 1);
    assert.match(err, /--tailwind needs a template with pages/);
    assert.ok(!existsSync(join(work, "api-tw")));
  });

  describe("a directory that isn't empty", () => {
    const used = join(work, "used");
    mkdirSync(used);
    writeFileSync(join(used, "notes.txt"), "keep me");

    it("is refused with --yes and no --force", async () => {
      const { code, err } = await cli(["used", "--yes"]);
      assert.equal(code, 1);
      assert.match(err, /used is not empty\. Use --force/);
      assert.ok(!existsSync(join(used, "package.json")));
    });

    it("asks first, and stops on no", async () => {
      const { code, err, out } = await cli(["used", "--no-git", "--no-install"], { input: "n\n" });
      assert.equal(code, 130);
      assert.match(out, /used is not empty\. Write into it, overwriting files with the same names\? \(y\/N\)/);
      assert.match(err, /Cancelled\. Nothing was written\./);
      assert.ok(!existsSync(join(used, "package.json")));
    });

    it("is written into with --force, keeping other files", async () => {
      const { code } = await cli(["used", "--force", "--yes", "--no-install", "--no-git"]);
      assert.equal(code, 0);
      assert.ok(existsSync(join(used, "package.json")));
      assert.equal(readFileSync(join(used, "notes.txt"), "utf8"), "keep me");
    });
  });

  it("scaffolds into . with the folder's name", async () => {
    const here = join(work, "Here App");
    mkdirSync(here);
    const stdin = new PassThrough();
    stdin.end("");
    const stdout = sink();
    const code = await main({ argv: [".", "--yes", "--no-install", "--no-git"], env: { NO_COLOR: "1" }, cwd: here, stdin, stdout, stderr: sink(), exec: () => true });
    assert.equal(code, 0);
    assert.equal(JSON.parse(readFileSync(join(here, "package.json"), "utf8")).name, "here-app");
    assert.doesNotMatch(stdout.text, /\bcd\b/);
  });

  it("refuses a file as the target", async () => {
    writeFileSync(join(work, "a-file"), "");
    const { code, err } = await cli(["a-file", "--yes"]);
    assert.equal(code, 1);
    assert.match(err, /a-file is a file/);
  });

  it("exits 1 and says how to finish when the install fails", async () => {
    const { code, err, out } = await cli(["broken-install", "--yes", "--no-git"], { fail: ["npm install"] });
    assert.equal(code, 1);
    assert.match(err, /warning npm install failed; run it yourself in broken-install/);
    assert.match(out, /cd broken-install\n {2}npm install\n/);
  });

  it("warns, without failing, when the first commit can't be made", async () => {
    const { code, err } = await cli(["no-commit", "--yes", "--no-install"], { fail: ["git commit"] });
    assert.equal(code, 0);
    assert.match(err, /the first commit failed/);
  });
});
