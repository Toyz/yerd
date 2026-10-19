/// <reference types="vite/client" />
import { yerd } from "@toyz/yerd";
import { RootLayout } from "./layout.js";
// Module-level registrations (a lazy element, a module-backed attribute) the pages use.
import "./registry.js";

/**
 * The runtime fixture app. Cue rooms named fx-* are public, so each test can
 * listen on a room of its own.
 */
export default yerd({ cues: { public: (room) => room.startsWith("fx-") } })
  .layout(RootLayout)
  .sessions()
  .discover(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }));
