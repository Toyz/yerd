/**
 * The client runtime script, minified. Undefined in a checkout, where
 * runtimeSource() serves the runtime function's own source (comments and
 * all); `npm run build` replaces this module's output with the minified
 * script (scripts/minify-runtime.ts), so the published package serves that.
 */
export const minified: string | undefined = undefined;
