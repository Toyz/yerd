# Client code

Most pages need no client code: actions, Regions and [custom attributes](06-interactivity.md#custom-attributes) cover forms, live updates and small behaviours. Reach for a client module when something has to run in the browser on its own: a chart, a map, an editor, a custom element.

yerd gives you three ways to ship one, each loaded only on pages that use it:

- [Island](api:yerd.Island): a part of the page mounted by a module.
- [lazyElement](api:yerd.lazyElement): a custom element whose definition loads when the tag appears.
- [attribute](api:yerd.attribute) with `client: "path"`: a custom attribute whose client half is a module.

## Client modules

Name client modules `*.client.ts` (or `.tsx`, `.js`, `.jsx`). The Vite plugin builds every one it finds as a client entry, so they don't go in the `client` option.

```
src/
  widgets/
    sparkline.client.ts
  elements/
    share-link.client.tsx
```

- Refer to a module by its source path from the Vite root: `"src/widgets/sparkline.client.ts"`.
- In dev that's the file itself; in production, the hashed build output.
- Modules can import packages and each other. Shared code is split into chunks by Vite as usual.

## Islands

Render an [Island](api:yerd.Island) with the module, a trigger and props. Its children show until the module mounts.

```tsx
import { Island } from "@toyz/yerd";

<Island src="src/widgets/sparkline.client.ts" when="visible" props={{ points: [3, 5, 2, 8] }}>
  <p>Sales: 3, 5, 2, 8</p>
</Island>
```

The module's default export mounts it. It gets the `<yerd-island>` element, the props and the runtime API, and may return a cleanup.

```ts
// src/widgets/sparkline.client.ts
import type { IslandMount } from "@toyz/yerd/client";

export interface SparklineProps {
  points: number[];
}

const mount: IslandMount<SparklineProps> = (el, { points }) => {
  const canvas = document.createElement("canvas");
  draw(canvas, points);
  el.replaceChildren(canvas);
  return () => canvas.remove();
};

export default mount;
```

For type-checked props, make a component with [island](api:yerd.island) and share the props type with a type-only import:

```tsx
import { island } from "@toyz/yerd";
import type { SparklineProps } from "./widgets/sparkline.client.js";

export const Sparkline = island<SparklineProps>("src/widgets/sparkline.client.ts", { when: "visible" });

<Sparkline props={{ points: [3, 5, 2, 8] }}>3, 5, 2, 8</Sparkline>;
```

- Props must be JSON: plain objects, arrays, strings, finite numbers, booleans and null. Anything else (a Date, a Map, a function) throws while rendering.
- The cleanup runs when the island leaves the page: a Region update, a boosted navigation.
- Morphs leave a mounted island alone while its module and props are the same. New props remount it.
- Other props (`class`, `style`, `id`) go on the `<yerd-island>` element. It's inline by default; give it `display: block` for a widget with a size.

## Lazy elements

[lazyElement](api:yerd.lazyElement) ties a tag to the module that defines it, after loom's `@lazy`. Call it at module level in a file the server imports.

```ts
import { lazyElement } from "@toyz/yerd";

export const shareLink = lazyElement("share-link", "src/elements/share-link.client.tsx", { when: "idle" });
```

The module defines the element itself. A loom component works as is (the pragma gives the file loom's JSX instead of yerd's):

```tsx
// src/elements/share-link.client.tsx
/** @jsxImportSource @toyz/loom */
import { component, LoomElement } from "@toyz/loom";

@component("share-link")
export class ShareLink extends LoomElement {
  update() {
    return <button onClick={() => navigator.share({ url: this.getAttribute("url")! })}>Share</button>;
  }
}
```

So does a plain `customElements.define("share-link", class extends HTMLElement { ... })`. In a page, use the tag; its children show until it upgrades:

```tsx
<share-link url={url}>
  <a href={url}>Link to this page</a>
</share-link>
```

- The module loads when the first element with the tag fires its trigger. Every instance upgrades then.
- A morph patches an element's light DOM back to what the server sent. Use shadow DOM, or `key` and `data-yx-keep` on the tag.

## Lazy attribute halves

A custom attribute's `client` can be a module path instead of a function. Its default export has the same signature as an inline client half.

```ts
import { attribute } from "@toyz/yerd";

export const confetti = attribute("confetti", {
  client: "src/attrs/confetti.client.ts",
  when: "interaction",
});
```

```ts
// src/attrs/confetti.client.ts
import type { AttributeSetup } from "@toyz/yerd/client";

const confetti: AttributeSetup = (el) => {
  const burst = () => fire(el);
  el.addEventListener("click", burst);
  return () => el.removeEventListener("click", burst);
};

export default confetti;
```

- Unlike an inline half, the module can import things, and pages without the attribute never download it.
- The first element to fire its trigger loads the module. From then on every element with the attribute connects, as with an inline half.
- `update` and `disconnect` work the same way.

## Triggers

`when` takes the same values for all three:

| `when` | Loads |
|--------|-------|
| `"load"` (default) | as soon as the element is on the page |
| `"idle"` | when the browser is idle (two seconds at most) |
| `"visible"` | when the element comes within 200px of the viewport |
| `"interaction"` | on the first pointerenter, pointerdown, focusin or touchstart |
| `"media:<query>"` | once the media query matches, e.g. `"media:(min-width: 800px)"` |

- `"load"` modules get a `<link rel="modulepreload">` after `<Scripts />`, so they download with the page.
- The triggering event isn't replayed. Hover, press and focus come before a click, so an `"interaction"` module is usually in by the time the click lands.
- Each module is imported once per page, however many elements use it.

## Loading state

While its module loads, the element whose trigger fired has `data-yx-loading`. If the import or the mount throws, it gets `data-yx-failed` and the error is logged.

```css
yerd-island[data-yx-loading] { opacity: 0.6; }
yerd-island[data-yx-failed]::after { content: "Couldn't load this."; }
```

The element also dispatches `yx:lazy-start` and `yx:lazy-end`, which bubble:

```ts
document.addEventListener("yx:lazy-end", (event) => {
  if (!event.detail.ok) report(event.detail.src, event.detail.error);
});
```

## CSS

Import CSS from a client module as usual.

```ts
import "./sparkline.css";
```

- In dev, Vite injects it.
- In production, yerd links the module's stylesheets (from the Vite manifest) before it runs.

## Types

`@toyz/yerd/client` is types only, so `import type` adds nothing to a bundle:

| Type | For |
|------|-----|
| [IslandMount<P>](api:client.IslandMount) | an island module's default export |
| [AttributeSetup](api:client.AttributeSetup) | a lazy attribute half's default export |
| [YerdClient](api:client.YerdClient) | the runtime API passed to both |
| [LazyStartDetail](api:client.LazyStartDetail), [LazyEndDetail](api:client.LazyEndDetail) | the loading events (typed on `addEventListener`) |
| [LoadTrigger](api:client.LoadTrigger) | the `when` values |
