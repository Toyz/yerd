// @ts-check
// Plain ANSI styling. Off for NO_COLOR, TERM=dumb and anything that isn't a terminal.

/**
 * Whether to color output written to `stream`.
 * @param {{ isTTY?: boolean }} stream
 * @param {NodeJS.ProcessEnv} env
 */
export function useColor(stream, env = process.env) {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  if (env.TERM === "dumb") return false;
  return Boolean(stream.isTTY);
}

/**
 * @param {boolean} enabled
 */
export function createStyle(enabled) {
  /** @param {number} open @param {number} close */
  const wrap = (open, close) => (/** @type {string} */ text) => (enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text);
  return {
    enabled,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
  };
}

/** @typedef {ReturnType<typeof createStyle>} Style */
