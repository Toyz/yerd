// @ts-check
import { parseArgs as parseNodeArgs } from "node:util";

export const TEMPLATES = /** @type {const} */ (["full", "minimal", "api"]);
export const PACKAGE_MANAGERS = /** @type {const} */ (["npm", "pnpm", "yarn", "bun"]);

/** @typedef {(typeof TEMPLATES)[number]} Template */
/** @typedef {(typeof PACKAGE_MANAGERS)[number]} PackageManager */

/**
 * What the command line said. `undefined` means "ask, or use the default".
 * @typedef {object} Args
 * @property {string} [dir]
 * @property {Template} [template]
 * @property {boolean} [tailwind]
 * @property {PackageManager} [pm]
 * @property {boolean} [git]
 * @property {boolean} [install]
 * @property {boolean} yes
 * @property {boolean} force
 * @property {boolean} help
 * @property {boolean} version
 */

/** A bad command line: printed without a stack trace, exit code 1. */
export class UsageError extends Error {
  name = "UsageError";
}

/** Templates that render pages, so Tailwind applies. */
export const PAGE_TEMPLATES = /** @type {readonly Template[]} */ (["full", "minimal"]);

/**
 * @param {string[]} argv the arguments after the script
 * @returns {Args}
 */
export function parseArgs(argv) {
  /** @type {ReturnType<typeof parse>} */
  let parsed;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new UsageError(cleanMessage(/** @type {Error} */ (error).message));
  }
  const { values, positionals } = parsed;
  if (positionals.length > 1) throw new UsageError(`Expected one project directory, got ${positionals.length}: ${positionals.join(" ")}`);

  const template = values.template;
  if (template !== undefined && !includes(TEMPLATES, template)) {
    throw new UsageError(`Unknown template "${template}". Use one of: ${TEMPLATES.join(", ")}`);
  }
  const pm = values.pm;
  if (pm !== undefined && !includes(PACKAGE_MANAGERS, pm)) {
    throw new UsageError(`Unknown package manager "${pm}". Use one of: ${PACKAGE_MANAGERS.join(", ")}`);
  }
  if (template === "api" && values.tailwind === true) {
    throw new UsageError("--tailwind needs a template with pages (full or minimal); api has none");
  }
  const dir = positionals[0];
  if (dir !== undefined && dir.trim() === "") throw new UsageError("The project directory can't be empty");

  return {
    dir,
    template,
    tailwind: values.tailwind,
    pm,
    git: values.git,
    install: values.install,
    yes: values.yes ?? false,
    force: values.force ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
  };
}

/** @param {string[]} args */
function parse(args) {
  return parseNodeArgs({
    args,
    allowPositionals: true,
    allowNegative: true,
    strict: true,
    options: {
      template: { type: "string", short: "t" },
      tailwind: { type: "boolean" },
      pm: { type: "string" },
      git: { type: "boolean" },
      install: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      force: { type: "boolean", short: "f" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}

/**
 * @template {string} T
 * @param {readonly T[]} list
 * @param {string} value
 * @returns {value is T}
 */
export function includes(list, value) {
  return /** @type {readonly string[]} */ (list).includes(value);
}

/** node:util's messages end with advice about "--" that doesn't fit here. @param {string} message */
function cleanMessage(message) {
  return message.split(". To specify a positional")[0]?.replace(/\.$/, "") ?? message;
}

export const HELP = `Usage: create-yerd [directory] [options]

Scaffold a yerd app. Asks for anything the flags leave out.

Options:
  -t, --template <name>   full | minimal | api
      --tailwind          add Tailwind CSS (full and minimal)
      --no-tailwind       plain CSS
      --pm <name>         npm | pnpm | yarn | bun (default: the one running this)
      --git, --no-git     initialize a git repository (default: yes)
      --install, --no-install
                          install dependencies (default: yes)
  -y, --yes               accept the defaults for everything not given
  -f, --force             write into a directory that isn't empty
  -h, --help              show this help
  -v, --version           show the version

Templates:
  full      catalog, product pages, a session cart, sign-in, a validated form,
            a JSON API, unit tests and a Playwright test
  minimal   one page, a layout, one action, a test
  api       JSON routes, DTO validation, errors, tests; no pages

Examples:
  npm create yerd@latest my-app
  npm create yerd@latest my-app -- --template full --tailwind
  pnpm create yerd my-api --template api --yes
  npm create yerd@latest . -- --yes --no-install
`;
