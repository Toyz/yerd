# tailwind

Tailwind CSS v4 in a yerd app. `npm run tailwind` from the repo root.

- `vite.config.ts` adds `@tailwindcss/vite` next to the yerd plugin.
- `src/app.css` is just `@import "tailwindcss";`.
- The root layout does `import css from "./app.css?inline"` and renders
  `<style>{raw(css)}</style>`: Vite runs Tailwind over the CSS and hands it
  over as a string, so server-rendered pages get it with no extra request.
  (`<style>` children are raw text, so `<style>{css}</style>` works too; text
  containing `</style` is refused.)
- Tailwind scans the TSX as text, so `class="..."` (not `className`), arrays
  and objects all work, as long as full class names appear in the source.
- Regions morphed in by actions are styled too, and `data-[yx-new]:animate-bounce`
  animates only what the runtime just inserted.

Caveats: the CSS is inlined into every page. For a separate, cacheable file,
list it in the plugin's `client` option and link it with `<Stylesheet>`, as
the todo example does. Raw mode would need the Tailwind CLI to build the CSS.
