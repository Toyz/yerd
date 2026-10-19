// @ts-check
// Prompts on node:readline. In a terminal: raw mode, arrow keys for selects,
// y/n for confirms. Anywhere else (a pipe, CI): one plain question per line,
// and the default for every question once input runs out.
import { createInterface, emitKeypressEvents } from "node:readline";

/** @typedef {import("./style.js").Style} Style */
/** @typedef {{ name?: string, ctrl?: boolean, meta?: boolean, sequence?: string }} Key */

/** Ctrl-C or Escape at a prompt. */
export class CancelError extends Error {
  name = "CancelError";
  constructor() {
    super("Cancelled");
  }
}

/**
 * @template {string} T
 * @typedef {{ value: T, label: string, hint?: string }} Choice
 */

/**
 * @param {object} io
 * @param {NodeJS.ReadableStream & { isTTY?: boolean, setRawMode?: (on: boolean) => unknown, isRaw?: boolean }} io.input
 * @param {NodeJS.WritableStream} io.output
 * @param {Style} io.style
 * @param {boolean} [io.interactive] raw-mode prompts; default: input and output are both terminals
 */
export function createPrompter({ input, output, style, interactive }) {
  const raw = interactive ?? Boolean(input.isTTY && /** @type {{ isTTY?: boolean }} */ (output).isTTY && input.setRawMode);
  return raw ? rawPrompter(input, output, style) : linePrompter(input, output, style);
}

/** @typedef {ReturnType<typeof createPrompter>} Prompter */

/**
 * The answered question, left on screen: "+ Project name my-app".
 * @param {Style} style @param {string} message @param {string} answer
 */
function answered(style, message, answer) {
  return `${style.green("+")} ${message} ${style.cyan(answer)}\n`;
}

// ---------------------------------------------------------------------------
// Terminal: raw mode

/**
 * @param {NodeJS.ReadableStream & { setRawMode?: (on: boolean) => unknown, isRaw?: boolean }} input
 * @param {NodeJS.WritableStream} output
 * @param {Style} style
 */
function rawPrompter(input, output, style) {
  emitKeypressEvents(input);

  /**
   * Draws `frame()` and redraws it after every key until `onKey` returns a result.
   * @template R
   * @param {() => string} frame
   * @param {(str: string | undefined, key: Key) => { done: R } | void} onKey
   * @returns {Promise<R>}
   */
  function interact(frame, onKey) {
    return new Promise((resolve, reject) => {
      const wasRaw = Boolean(input.isRaw);
      let lines = 0;
      const draw = () => {
        // Back to the frame's first line, clear to the end, draw again.
        const up = lines > 1 ? `\x1b[${lines - 1}A` : "";
        const text = frame();
        output.write(`${up}\r\x1b[J${text}`);
        lines = text.split("\n").length;
      };
      const finish = () => {
        input.off("keypress", onKeypress);
        input.setRawMode?.(wasRaw);
        input.pause();
        const up = lines > 1 ? `\x1b[${lines - 1}A` : "";
        output.write(`${up}\r\x1b[J\x1b[?25h`);
      };
      /** @param {string | undefined} str @param {Key | undefined} key */
      const onKeypress = (str, key = {}) => {
        if ((key.ctrl && key.name === "c") || key.name === "escape") {
          finish();
          reject(new CancelError());
          return;
        }
        const result = onKey(str, key);
        if (result) {
          finish();
          resolve(result.done);
        } else draw();
      };
      input.setRawMode?.(true);
      input.on("keypress", onKeypress);
      input.resume();
      draw();
    });
  }

  return {
    /**
     * @param {{ message: string, initial?: string, validate?: (value: string) => string | undefined }} options
     * @returns {Promise<string>}
     */
    async text({ message, initial = "", validate }) {
      let value = "";
      /** @type {string | undefined} */
      let error;
      const result = await interact(
        () => {
          const shown = value === "" && initial ? style.dim(initial) : value;
          return `${style.cyan("?")} ${style.bold(message)} ${shown}${error ? `\n  ${style.red(error)}` : ""}`;
        },
        (str, key) => {
          if (key.name === "return" || key.name === "enter") {
            const answer = value.trim() || initial;
            error = validate?.(answer);
            return error ? undefined : { done: answer };
          }
          if (key.name === "backspace") value = value.slice(0, -1);
          else if (key.ctrl && key.name === "u") value = "";
          else if (str && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(str)) value += str;
          error = undefined;
        },
      );
      output.write(answered(style, message, result));
      return result;
    },

    /**
     * @template {string} T
     * @param {{ message: string, choices: Choice<T>[], initial?: T }} options
     * @returns {Promise<T>}
     */
    async select({ message, choices, initial }) {
      let index = Math.max(0, choices.findIndex((c) => c.value === initial));
      const width = Math.max(...choices.map((c) => c.label.length));
      output.write("\x1b[?25l");
      const choice = await interact(
        () =>
          [
            `${style.cyan("?")} ${style.bold(message)} ${style.dim("(arrow keys, enter)")}`,
            ...choices.map((c, i) => {
              const label = c.hint ? c.label.padEnd(width) : c.label;
              const hint = c.hint ? `  ${style.dim(c.hint)}` : "";
              return i === index ? `${style.cyan(">")} ${style.cyan(label)}${hint}` : `  ${label}${hint}`;
            }),
          ].join("\n"),
        (_str, key) => {
          if (key.name === "up" || key.name === "k") index = (index - 1 + choices.length) % choices.length;
          else if (key.name === "down" || key.name === "j" || key.name === "tab") index = (index + 1) % choices.length;
          else if (key.name === "return" || key.name === "enter") return { done: /** @type {Choice<T>} */ (choices[index]) };
        },
      );
      output.write(answered(style, message, choice.label));
      return choice.value;
    },

    /**
     * @param {{ message: string, initial?: boolean }} options
     * @returns {Promise<boolean>}
     */
    async confirm({ message, initial = true }) {
      const result = await interact(
        () => `${style.cyan("?")} ${style.bold(message)} ${style.dim(initial ? "(Y/n)" : "(y/N)")}`,
        (str, key) => {
          if (key.name === "return" || key.name === "enter") return { done: initial };
          if (str?.toLowerCase() === "y") return { done: true };
          if (str?.toLowerCase() === "n") return { done: false };
        },
      );
      output.write(answered(style, message, result ? "yes" : "no"));
      return result;
    },

    close() {},
  };
}

// ---------------------------------------------------------------------------
// Pipes and CI: plain lines

/**
 * @param {NodeJS.ReadableStream} input
 * @param {NodeJS.WritableStream} output
 * @param {Style} style
 */
function linePrompter(input, output, style) {
  /** @type {import("node:readline").Interface | undefined} */
  let rl;
  /** @type {AsyncIterator<string> | undefined} */
  let lines;
  let ended = false;

  /** The next line of input, or undefined once there's no more. */
  async function nextLine() {
    if (ended) return undefined;
    if (!lines) {
      rl = createInterface({ input, terminal: false });
      lines = rl[Symbol.asyncIterator]();
    }
    const next = await lines.next();
    if (next.done) {
      ended = true;
      return undefined;
    }
    return next.value.trim();
  }

  /**
   * Asks until `parse` accepts the line; no input left means the default.
   * `parse` returns `{ value }`, or a message saying what's wrong.
   * @template T
   * @param {string} question
   * @param {T} fallback
   * @param {(line: string) => { value: T } | string} parse
   * @returns {Promise<T>}
   */
  async function ask(question, fallback, parse) {
    for (;;) {
      output.write(question);
      const line = await nextLine();
      if (line === undefined) {
        output.write("\n");
        return fallback;
      }
      if (line === "") return fallback;
      const result = parse(line);
      if (typeof result !== "string") return result.value;
      output.write(`${style.red(result)}\n`);
    }
  }

  return {
    /**
     * @param {{ message: string, initial?: string, validate?: (value: string) => string | undefined }} options
     * @returns {Promise<string>}
     */
    async text({ message, initial = "", validate }) {
      const value = await ask(`${message}${initial ? ` (${initial})` : ""}: `, initial, (line) => {
        const error = validate?.(line);
        return error ?? { value: line };
      });
      const error = validate?.(value);
      // The default itself failing (no input left) has nobody to ask again.
      if (error) throw new Error(`${message}: ${error}`);
      return value;
    },

    /**
     * @template {string} T
     * @param {{ message: string, choices: Choice<T>[], initial?: T }} options
     * @returns {Promise<T>}
     */
    async select({ message, choices, initial }) {
      const fallback = initial ?? /** @type {Choice<T>} */ (choices[0]).value;
      const list = choices.map((c, i) => `  ${i + 1}) ${c.label}${c.hint ? ` - ${c.hint}` : ""}`).join("\n");
      output.write(`${message}\n${list}\n`);
      return ask(`Choose 1-${choices.length} or a name (${fallback}): `, fallback, (line) => {
        const byNumber = /^\d+$/.test(line) ? choices[Number(line) - 1] : undefined;
        const lower = line.toLowerCase();
        const match = byNumber ?? choices.find((c) => c.value.toLowerCase() === lower || c.label.toLowerCase() === lower);
        return match ? { value: match.value } : `Pick 1-${choices.length} or one of: ${choices.map((c) => c.value).join(", ")}`;
      });
    },

    /**
     * @param {{ message: string, initial?: boolean }} options
     * @returns {Promise<boolean>}
     */
    async confirm({ message, initial = true }) {
      return ask(`${message} ${initial ? "(Y/n)" : "(y/N)"}: `, initial, (line) => {
        if (/^(y|yes)$/i.test(line)) return { value: true };
        if (/^(n|no)$/i.test(line)) return { value: false };
        return "Answer y or n";
      });
    },

    close() {
      rl?.close();
    },
  };
}
