import type { RuntimePieces } from "./runtime.js";

/**
 * The client runtime's functions (the core and each chunk), minified.
 * Undefined in a checkout, where runtimeSource() serves each function's own
 * source (comments and all); `npm run build` replaces this module's output
 * with the minified functions (scripts/minify-runtime.ts), so the published
 * package serves those.
 */
export const minified: RuntimePieces | undefined = undefined;
