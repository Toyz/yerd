# tailwind

Tailwind CSS v4 in a yerd app. `npm run tailwind` from the repo root.

- `vite.config.ts` adds `@tailwindcss/vite` next to the yerd plugin.
- `src/app.css` is just `@import "tailwindcss";`.
- The root layout links it like any stylesheet: `<Stylesheet href="src/app.css" />`.
  In dev that's `/src/app.css`, which Vite serves after Tailwind builds it
  (edits show up on reload). `vite.config.ts` lists the file in the yerd
  plugin's `client` option, so `vite build` emits it hashed
  (`/assets/app-AbC123xy.css`, cached for a year) and the same tag links that.
- Tailwind scans the TSX as text, so `class="..."` (not `className`), arrays
  and objects all work, as long as full class names appear in the source.
- Four counters, one action. Each `Counter` renders its own
  `<Region id="counter-{id}">` and a form bound to itself with
  `bind(bump, { id })`, so the action knows which counter to bump (signed:
  the browser can't change it) and returns just that counter; the runtime
  morphs the Region with the matching id. The component takes the action as
  a typed prop, `bump: Action<{ id: string }>`.
- Regions morphed in by actions are styled too, and `data-[yx-new]:animate-bounce`
  animates only what the runtime just inserted.

Prefer one request less? `import css from "./app.css?inline"` and
`<style>{raw(css)}</style>` inline it into every page instead. Raw mode
(no Vite) would need the Tailwind CLI to build the CSS.
