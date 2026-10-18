# M0 spike results (2026-10-17)

Toolchain: Node 26.12.0, npm 11.20.0, TypeScript 7.0.2 (`latest`, the Go-native
compiler), Vite 8.3.4, esbuild 0.28.2, Chrome stable (system install).

Spike code lives in `spikes/m0/`; each one is runnable.

| # | Question | Result |
|---|----------|--------|
| 1 | tsc 7 compiles TSX through our runtime; Node resolves `@toyz/yerd/jsx-runtime` with no `node_modules/@toyz` (package self-reference) | **pass** |
| 2 | tsc 7 lowers TC39 decorators + `accessor` + `context.metadata` at ES2022; member decorators run before class decorators; Node 26 runs it | **pass** |
| 3 | One tsc-emitted island file: Node picks the server twin via the `exports` `"node"` condition, Chrome picks the browser twin via an import map | **pass** |
| 4 | tsc 7 still lowers `async` to `__awaiter` + generators at target ES2016, with an observable `.then` (async-context polyfill trick) | **pass** |
| 5 | Vite 8's own transformer (Oxc) lowers TC39 decorators | **fail**: Oxc only supports legacy decorators; it passes `@dec` and `accessor` through untouched |
| 6 | esbuild lowers the same file identically (order, metadata, JSX) | **pass** |
| 7 | Vite 8 dev server, `oxc: false`, esbuild pre-transform plugin, SSR module runner executes the decorated module | **pass** (32ms) |
| 8 | `crypto.argon2` in Node 26 | **present** (`argon2`, `argon2Sync`) |

Facts that also came out of it:

- Node 26 has **no native decorators, no native `accessor`, no `Symbol.metadata`**.
  The compiler must lower all of it, and yerd's `Symbol.metadata` polyfill is
  required.
- **TypeScript 7 has no classic JS compiler API.** No `ts.transpileModule`, no
  `program.emit()`, no custom transformers. Its npm API (`typescript/unstable/*`)
  is type information over IPC. The `tsc` binary still emits.

## What changed in the plan

1. **Vite plugin transforms with esbuild, not tsc.** The earlier
   `transpiler: "tsc"` default relied on `ts.transpileModule`, which doesn't
   exist in TS 7, and Oxc can't lower TC39 decorators. The plugin runs
   esbuild's `transform` directly (Vite's `transformWithEsbuild` wrapper is
   deprecated), with `oxc` disabled for app TS. `esbuild` becomes an optional
   peer dependency next to `vite`. When Oxc supports TC39 decorators, the plugin
   can switch to it. tsc 7 does type-checking (`tsc --noEmit`, fast).
2. **Raw lite drives the `tsc` binary**, not a compiler API: one run for the
   server, a second run over the client graph with a generated tsconfig at
   ES2016.
3. **BUILDER.md's custom-transformer design depends on a JS compiler API.**
   With TS 7 it would need TS 6.x via an npm alias, or a different engine.
   Parked anyway; noted there.
4. **Passwords: argon2id via `crypto.argon2`**, scrypt as fallback when it's
   unavailable.
5. **Pinned:** `typescript@^7`, `vite@^8`, `esbuild` (devDeps of this repo; optional peers of the package).

## Still to verify later

- esbuild lowering `async` at ES2016 with an observable `.then` (M6, Vite-mode
  islands with the async-context polyfill).
- Vite 8 client environment build of islands + manifest (M6).
- Whether `crypto.argon2` is marked stable or experimental in Node 26 docs.
