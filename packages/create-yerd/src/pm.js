// @ts-check
import { includes, PACKAGE_MANAGERS } from "./args.js";

/** @typedef {import("./args.js").PackageManager} PackageManager */

/**
 * The package manager that ran us, from npm_config_user_agent
 * ("pnpm/10.4.1 npm/? node/v24.0.0 linux x64"). npm when there's none.
 * @param {string | undefined} userAgent
 * @returns {PackageManager}
 */
export function detectPackageManager(userAgent) {
  const name = userAgent?.split(" ")[0]?.split("/")[0];
  return name && includes(PACKAGE_MANAGERS, name) ? name : "npm";
}

/**
 * The commands to print and run for one package manager.
 * @param {PackageManager} pm
 */
export function commands(pm) {
  return {
    /** argv for installing dependencies */
    install: pm === "yarn" ? ["yarn"] : [pm, "install"],
    /** `npm run dev`, `pnpm dev`... for a script. Not `bun test`: that's bun's own runner. */
    run: (/** @type {string} */ script) => {
      if (pm === "npm") return script === "test" || script === "start" ? `npm ${script}` : `npm run ${script}`;
      return pm === "bun" ? `bun run ${script}` : `${pm} ${script}`;
    },
    /** `npx`, `pnpm exec`... for a binary from node_modules */
    exec: pm === "npm" ? "npx" : pm === "bun" ? "bunx" : pm === "pnpm" ? "pnpm exec" : "yarn",
  };
}
