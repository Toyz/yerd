// @ts-check
import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import { HELP, PAGE_TEMPLATES, UsageError, parseArgs } from "./args.js";
import { commands, detectPackageManager } from "./pm.js";
import { CancelError, createPrompter } from "./prompt.js";
import { VERSION, writeProject, yerdSpec } from "./render.js";
import { createStyle, useColor } from "./style.js";
import { inspectTarget, packageName, resolveTarget, validateDir } from "./target.js";

/** @typedef {import("./args.js").Template} Template */
/** @typedef {import("./args.js").PackageManager} PackageManager */

/** Defaults for --yes and for questions nobody answers. */
export const DEFAULTS = { dir: "yerd-app", template: /** @type {Template} */ ("minimal"), tailwind: false, git: true, install: true };

/** @type {{ value: Template, label: string, hint: string }[]} */
const TEMPLATE_CHOICES = [
  { value: "full", label: "Full app", hint: "catalog, cart, sign-in, forms, JSON API, tests" },
  { value: "minimal", label: "Minimal", hint: "one page and a layout" },
  { value: "api", label: "API only", hint: "JSON routes and validation, no pages" },
];

/**
 * @typedef {object} Io
 * @property {string[]} argv
 * @property {NodeJS.ProcessEnv} env
 * @property {string} cwd
 * @property {NodeJS.ReadableStream & { isTTY?: boolean, setRawMode?: (on: boolean) => unknown }} stdin
 * @property {NodeJS.WritableStream & { isTTY?: boolean }} stdout
 * @property {NodeJS.WritableStream & { isTTY?: boolean }} stderr
 * @property {(cmd: string, args: string[], cwd: string, quiet?: boolean) => boolean} [exec] runs a command; true on success
 */

/**
 * The whole command. Returns the exit code.
 * @param {Io} io
 */
export async function main(io) {
  const style = createStyle(useColor(io.stdout, io.env));
  const err = createStyle(useColor(io.stderr, io.env));
  const exec = io.exec ?? run;
  const say = (/** @type {string} */ text = "") => io.stdout.write(`${text}\n`);

  let args;
  try {
    args = parseArgs(io.argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr.write(`${err.red("error")} ${error.message}\nRun create-yerd --help for the options.\n`);
    return 1;
  }
  if (args.help) {
    io.stdout.write(HELP);
    return 0;
  }
  if (args.version) {
    say(VERSION);
    return 0;
  }

  const prompter = createPrompter({ input: io.stdin, output: io.stdout, style });
  try {
    say(`${style.bold("create-yerd")} ${style.dim(`v${VERSION}`)}\n`);
    const ask = !args.yes;

    const dir = args.dir ?? (ask ? await prompter.text({ message: "Project directory:", initial: DEFAULTS.dir, validate: validateDir }) : DEFAULTS.dir);
    const target = resolveTarget(dir, io.cwd);
    const state = inspectTarget(target);
    if (state === "file") throw new UsageError(`${dir} is a file`);
    if (state === "not-empty" && !args.force) {
      if (!ask) throw new UsageError(`${dir === "." ? "This directory" : dir} is not empty. Use --force to write into it anyway`);
      const proceed = await prompter.confirm({
        message: `${dir === "." ? "This directory" : dir} is not empty. Write into it, overwriting files with the same names?`,
        initial: false,
      });
      if (!proceed) throw new CancelError();
    }

    const template =
      args.template ?? (ask ? await prompter.select({ message: "Template:", choices: TEMPLATE_CHOICES, initial: DEFAULTS.template }) : DEFAULTS.template);
    const pages = PAGE_TEMPLATES.includes(template);
    if (!pages && args.tailwind) throw new UsageError("--tailwind needs a template with pages (full or minimal); api has none");
    const tailwind = pages && (args.tailwind ?? (ask ? await prompter.confirm({ message: "Add Tailwind CSS?", initial: DEFAULTS.tailwind }) : DEFAULTS.tailwind));

    const detected = detectPackageManager(io.env.npm_config_user_agent);
    /** @type {PackageManager} */
    const pm =
      args.pm ??
      (ask
        ? await prompter.select({
            message: "Package manager:",
            choices: /** @type {PackageManager[]} */ ([detected, ...["npm", "pnpm", "yarn", "bun"].filter((p) => p !== detected)]).map((p) => ({
              value: p,
              label: p,
            })),
            initial: detected,
          })
        : detected);
    const git = args.git ?? (ask ? await prompter.confirm({ message: "Initialize a git repository?", initial: DEFAULTS.git }) : DEFAULTS.git);
    const install = args.install ?? (ask ? await prompter.confirm({ message: "Install dependencies?", initial: DEFAULTS.install }) : DEFAULTS.install);
    prompter.close();

    const name = packageName(target, dir);
    const shown = relative(io.cwd, target) || ".";
    const asked = ask && (state === "not-empty" || [args.dir, args.template, args.pm, args.git, args.install, pages ? args.tailwind : false].includes(undefined));
    if (asked) say();
    say(`Scaffolding ${style.bold(name)} ${style.dim(`(${template}${tailwind ? ", tailwind" : ""})`)} in ${style.cyan(target)}`);
    writeProject(target, { name, template, tailwind, pm, yerd: yerdSpec(io.env) });

    const cmd = commands(pm);
    let installed = false;
    if (install) {
      say(`Installing dependencies with ${pm}...`);
      installed = exec(/** @type {string} */ (cmd.install[0]), cmd.install.slice(1), target);
      if (!installed) io.stderr.write(`${err.yellow("warning")} ${cmd.install.join(" ")} failed; run it yourself in ${shown}\n`);
    }

    if (git) {
      const result = initGit(target, exec);
      if (result === "missing") io.stderr.write(`${err.yellow("warning")} git isn't installed; skipped the repository\n`);
      else if (result === "inside") say(style.dim("Already inside a git repository; skipped git init."));
      else if (result === "no-commit") io.stderr.write(`${err.yellow("warning")} git init ran, but the first commit failed (is user.name set?)\n`);
      else say("Initialized a git repository.");
    }

    say();
    say(style.bold("Next steps:"));
    say();
    if (shown !== ".") say(`  cd ${shown.includes(" ") ? JSON.stringify(shown) : shown}`);
    if (!installed) say(`  ${cmd.install.join(" ")}`);
    say(`  ${cmd.run("dev")}`.padEnd(24) + style.dim(`# http://localhost:5173${pages ? "" : "/api/notes"}`));
    say();
    say(`  ${cmd.run("test")}`.padEnd(24) + style.dim("# unit tests"));
    say(`  ${cmd.run("build")}`.padEnd(24) + style.dim("# production build"));
    say(`  ${cmd.run("start")}`.padEnd(24) + style.dim("# serve it, on PORT or http://localhost:3000"));
    say();
    say(`Docs: ${style.cyan("https://toyz.github.io/yerd/")}`);
    return install && !installed ? 1 : 0;
  } catch (error) {
    prompter.close();
    if (error instanceof CancelError) {
      io.stderr.write(`\n${err.red("Cancelled.")} Nothing was written.\n`);
      return 130;
    }
    if (error instanceof UsageError) {
      io.stderr.write(`${err.red("error")} ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

/**
 * git init and a first commit, unless the folder is already in a repository.
 * @param {string} dir
 * @param {NonNullable<Io["exec"]>} exec
 * @returns {"done" | "missing" | "inside" | "no-commit"}
 */
function initGit(dir, exec) {
  if (!exec("git", ["--version"], dir, true)) return "missing";
  if (exec("git", ["rev-parse", "--is-inside-work-tree"], dir, true)) return "inside";
  if (!exec("git", ["init", "-q"], dir, true)) return "missing";
  if (!exec("git", ["add", "-A"], dir, true)) return "no-commit";
  return exec("git", ["commit", "-q", "-m", "Initial commit from create-yerd"], dir, true) ? "done" : "no-commit";
}

/**
 * Runs a command and waits. `quiet` swallows its output.
 * @type {NonNullable<Io["exec"]>}
 */
function run(cmd, args, cwd, quiet = false) {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: quiet ? "ignore" : "inherit",
    // npm, pnpm and yarn are .cmd shims on Windows.
    shell: process.platform === "win32",
  });
  return result.status === 0;
}
