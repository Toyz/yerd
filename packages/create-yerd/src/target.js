// @ts-check
import { readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

/** Files that don't make a directory "not empty". */
const IGNORABLE = new Set([".git", ".DS_Store", "Thumbs.db", ".idea", ".vscode"]);

/**
 * The project directory as typed: `.` is the current folder.
 * @param {string} dir
 * @param {string} cwd
 */
export function resolveTarget(dir, cwd = process.cwd()) {
  return resolve(cwd, dir);
}

/**
 * A valid npm package name for the folder: lowercased, anything npm refuses
 * turned into dashes. A scope typed as the directory (`@me/app`) is kept.
 * @param {string} path the absolute target
 * @param {string} [typed] what the user typed, for a scoped name
 */
export function packageName(path, typed) {
  if (typed && /^@[^/]+\/[^/]+$/.test(typed.trim())) {
    const [scope, name] = typed.trim().slice(1).split("/");
    return `@${slug(scope ?? "")}/${slug(name ?? "") || "yerd-app"}`;
  }
  return slug(basename(path)) || "yerd-app";
}

/** @param {string} text */
function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/^[._]+/, "")
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 214);
}

/**
 * Why `dir` can't be a project directory, or undefined if it can (as typed into the prompt).
 * @param {string} dir
 */
export function validateDir(dir) {
  if (dir.trim() === "") return "Enter a directory name, or . for this one";
  if (/[<>:"|?*\x00-\x1f]/.test(dir)) return "That name has characters a folder can't have";
  return undefined;
}

/**
 * What's at the target: nothing, an empty folder, a folder with files, or a file.
 * @param {string} path
 * @returns {"missing" | "empty" | "not-empty" | "file"}
 */
export function inspectTarget(path) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return "missing";
  }
  if (!stats.isDirectory()) return "file";
  return readdirSync(path).some((name) => !IGNORABLE.has(name)) ? "not-empty" : "empty";
}
