/// <reference types="vite/client" />
import { yerd } from "@toyz/yerd";
import { RootLayout } from "./layout.js";
// Module-level registrations (a lazy element, a module-backed attribute) the pages use.
import "./registry.js";

/**
 * The runtime fixture app. Cue rooms named fx-* are public, so each test can
 * listen on a room of its own. It runs under the default security headers,
 * so every runtime feature is tested against yerd's own CSP ('unsafe-eval'
 * added for the <Local> page, as documented).
 */
export default yerd({ cues: { public: (room) => room.startsWith("fx-") } })
  .securityHeaders({ csp: { "script-src": ["'self'", "'unsafe-eval'"] } })
  .layout(RootLayout)
  .sessions()
  .discover(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }));
