// Generates every template combination against the local yerd, then installs,
// type-checks, tests, builds and serves each one. Slow (a minute or more), so it
// runs only with CREATE_YERD_INTEGRATION=1; CI sets it. Build the repo root first
// (`npm run build`): the apps install a tarball packed from it.
//
//   CREATE_YERD_INTEGRATION=1 node --test test/integration.test.js
//
// CREATE_YERD_YERD_SPEC   use this @toyz/yerd spec instead of packing the repo
// CREATE_YERD_CONCURRENCY apps processed at once (default 3)
// CREATE_YERD_KEEP=1      keep the generated apps (their path is printed)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const enabled = process.env.CREATE_YERD_INTEGRATION === "1";
const bin = fileURLToPath(new URL("../bin/create-yerd.js", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));

/** The environment without the npm_* variables of the npm that may be running this test. */
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_")));

const COMBOS = [
  { template: "minimal", tailwind: false },
  { template: "minimal", tailwind: true },
  { template: "full", tailwind: false },
  { template: "full", tailwind: true },
  { template: "api", tailwind: false },
];

describe("generated apps", { skip: !enabled && "set CREATE_YERD_INTEGRATION=1 to run", concurrency: Number(process.env.CREATE_YERD_CONCURRENCY ?? 3) }, () => {
  /** @type {string} */
  let work;
  /** @type {string} */
  let spec;

  before(async () => {
    work = mkdtempSync(join(tmpdir(), "create-yerd-"));
    if (process.env.CREATE_YERD_YERD_SPEC) {
      spec = process.env.CREATE_YERD_YERD_SPEC;
      return;
    }
    assert.ok(existsSync(join(repo, "dist/src/index.js")), "Build yerd first: npm run build at the repo root");
    // A tarball, like the published package, rather than a symlink into the repo and its node_modules.
    const { stdout } = await run("npm", ["pack", "--silent", "--pack-destination", work], repo);
    spec = `file:${join(work, stdout.trim().split("\n").pop() ?? "")}`;
  });

  after(() => {
    if (process.env.CREATE_YERD_KEEP === "1") console.log(`kept: ${work}`);
    else if (work) rmSync(work, { recursive: true, force: true });
  });

  for (const { template, tailwind } of COMBOS) {
    const name = `${template}${tailwind ? "-tailwind" : ""}`;

    it(name, { timeout: 15 * 60_000 }, async (t) => {
      const dir = join(work, name);
      /** @param {string} label @param {() => Promise<unknown>} step */
      const timed = async (label, step) => {
        const started = Date.now();
        await step();
        t.diagnostic(`${name}: ${label} ${((Date.now() - started) / 1000).toFixed(1)}s`);
      };
      const env = { ...baseEnv, CREATE_YERD_YERD_SPEC: spec };

      await timed("generate", () =>
        run("node", [bin, dir, "--template", template, tailwind ? "--tailwind" : "--no-tailwind", "--pm", "npm", "--no-git", "--no-install"], work, env),
      );
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      assert.equal(pkg.dependencies["@toyz/yerd"], spec);
      assert.equal(Boolean(pkg.devDependencies.tailwindcss), tailwind);

      await timed("install", () => run("npm", ["install", "--prefer-offline", "--no-audit", "--no-fund", "--loglevel=error"], dir));
      await timed("tsc --noEmit", () => run("npm", ["run", "check"], dir));
      await timed("test", () => run("npm", ["test"], dir));
      await timed("build", () => run("npm", ["run", "build"], dir));
      await timed("serve", () => serve(dir, template, tailwind));
    });
  }
});

/**
 * Starts the production server on a free port and checks its answers.
 * @param {string} dir @param {string} template @param {boolean} tailwind
 */
async function serve(dir, template, tailwind) {
  // PORT=0: the OS picks a free port; the server prints its URL.
  const child = spawn("node", ["dist/server/server.js"], { cwd: dir, env: { ...baseEnv, PORT: "0", HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server didn't start:\n${output}`)), 30_000);
      const onData = (/** @type {Buffer} */ chunk) => {
        output += chunk;
        const match = /listening on (http:\/\/\S+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("exit", (code) => reject(new Error(`server exited with ${code}:\n${output}`)));
    });

    if (template === "api") {
      const res = await fetch(`${url}/api/notes`);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(await res.json()));
      assert.equal((await fetch(`${url}/api/health`)).status, 204);
      return;
    }

    const res = await fetch(`${url}/`, { headers: { accept: "text/html" } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<title>[^<]+<\/title>/);
    // The stylesheet <Stylesheet> linked: the hashed build output.
    const href = /<link rel="stylesheet" href="([^"]+)"/.exec(html)?.[1];
    assert.match(href ?? "", /^\/assets\/styles-[\w-]+\.css$/);
    const css = await fetch(`${url}${href}`);
    assert.equal(css.status, 200);
    const text = await css.text();
    if (tailwind) assert.match(text, /tailwindcss/);
    else assert.doesNotMatch(text, /tailwindcss/);
    assert.equal((await fetch(`${url}/favicon.svg`)).status, 200);
    if (template === "full") {
      assert.equal((await fetch(`${url}/products/99`, { headers: { accept: "text/html" } })).status, 404);
      assert.equal((await fetch(`${url}/api/products/1`)).status, 200);
    }
  } finally {
    child.kill();
  }
}

/**
 * Runs a command; rejects with its output when it fails.
 * @param {string} cmd @param {string[]} args @param {string} cwd @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ stdout: string }>}
 */
function run(cmd, args, cwd, env = baseEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    let stdout = "";
    let output = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      output += chunk;
    });
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve({ stdout }) : reject(new Error(`${cmd} ${args.join(" ")} failed (${code}) in ${cwd}:\n${output}`))));
  });
}
