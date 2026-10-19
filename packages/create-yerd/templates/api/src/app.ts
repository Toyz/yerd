import { yerd, type YerdOptions } from "@toyz/yerd";

/**
 * The app without routes: main.ts discovers them, tests import the ones they need.
 * No sessions, no layout: every answer is JSON (or a bare status).
 */
export function createApp(options?: YerdOptions) {
  return yerd(options);
}
