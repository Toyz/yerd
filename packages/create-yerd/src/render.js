// @ts-check
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { commands } from "./pm.js";
import { VERSIONS } from "./versions.js";

/** @typedef {import("./args.js").Template} Template */
/** @typedef {import("./args.js").PackageManager} PackageManager */

export const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));

const own = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** This package's version. create-yerd is released with yerd, at the same version. */
export const VERSION = /** @type {string} */ (own.version);

/**
 * The @toyz/yerd dependency for generated apps: the matching release, or
 * CREATE_YERD_YERD_SPEC (`file:/abs/path` to the repo or a packed tarball) for tests.
 * @param {NodeJS.ProcessEnv} env
 */
export function yerdSpec(env = process.env) {
  return env.CREATE_YERD_YERD_SPEC || `^${VERSION}`;
}

/**
 * @typedef {object} Options
 * @property {string} name the package name
 * @property {Template} template
 * @property {boolean} tailwind
 * @property {PackageManager} pm
 * @property {string} yerd the @toyz/yerd version range or spec
 */

/**
 * Template folders to copy, in order; later ones overwrite earlier files.
 * @param {Template} template @param {boolean} tailwind
 */
export function layers(template, tailwind) {
  const list = ["_shared", template];
  if (tailwind) list.push("tailwind/_shared", `tailwind/${template}`);
  return list;
}

/**
 * The values `{{key}}` placeholders in template files are replaced with.
 * @param {Options} options
 * @returns {Record<string, string>}
 */
export function variables({ name, pm }) {
  const cmd = commands(pm);
  return {
    name,
    pm,
    install: cmd.install.join(" "),
    exec: cmd.exec,
    run_dev: cmd.run("dev"),
    run_build: cmd.run("build"),
    run_start: cmd.run("start"),
    run_test: cmd.run("test"),
    run_check: cmd.run("check"),
    run_e2e: cmd.run("e2e"),
  };
}

/**
 * Replaces `{{key}}` with its value; an unknown key is a bug in the template.
 * @param {string} text @param {Record<string, string>} vars @param {string} file
 */
export function substitute(text, vars, file = "template") {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`${file}: unknown placeholder {{${key}}}`);
    return value;
  });
}

/**
 * `_gitignore` -> `.gitignore`: npm won't publish some dotfiles, so templates name them with `_`.
 * @param {string} path relative, with `/`
 */
export function outputPath(path) {
  return path.replace(/(^|\/)_([^/]+)$/, "$1.$2");
}

/**
 * Every file of the layers, by output path, the last layer winning.
 * @param {Options} options
 * @returns {Map<string, string>} output path -> rendered contents
 */
export function renderFiles(options) {
  const vars = variables(options);
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const layer of layers(options.template, options.tailwind)) {
    const root = join(TEMPLATES_DIR, layer);
    for (const file of walk(root)) {
      const rel = relative(root, file).split(sep).join("/");
      files.set(outputPath(rel), substitute(readFileSync(file, "utf8"), vars, `${layer}/${rel}`));
    }
  }
  files.set("package.json", `${JSON.stringify(packageJson(options), null, 2)}\n`);
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Writes the project into `dir` (created if missing). Returns the paths written.
 * @param {string} dir @param {Options} options
 */
export function writeProject(dir, options) {
  const files = renderFiles(options);
  for (const [path, contents] of files) {
    const out = join(dir, path);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, contents);
  }
  return [...files.keys()];
}

/**
 * The generated package.json.
 * @param {Options} options
 */
export function packageJson({ name, template, tailwind, yerd }) {
  /** @type {Record<string, string>} */
  const scripts = {
    dev: "vite",
    build: "vite build",
    start: "node --env-file-if-exists=.env dist/server/server.js",
    test: "vitest run",
    check: "tsc --noEmit",
  };
  const dev = ["@types/node", "esbuild", "typescript", "vite", "vitest"];
  if (tailwind) dev.push("@tailwindcss/vite", "tailwindcss");
  if (template === "full") {
    scripts.e2e = "playwright test";
    dev.push("@playwright/test");
  }
  return {
    name,
    version: "0.0.0",
    private: true,
    type: "module",
    engines: { node: ">=24.7" },
    scripts,
    dependencies: { "@toyz/yerd": yerd },
    devDependencies: Object.fromEntries(dev.sort().map((dep) => [dep, VERSIONS[/** @type {keyof typeof VERSIONS} */ (dep)]])),
  };
}

/** @param {string} dir @returns {Generator<string>} */
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}
