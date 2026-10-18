// Symbol.metadata isn't native in Node 26 or current browsers, but tsc and
// esbuild both read it when a decorated class is defined. @toyz/yerd's entry
// imports this module first, and user modules import @toyz/yerd before
// defining classes, so ESM evaluation order guarantees it runs in time.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

export {};
