# Client code

The product page gets "Recently viewed": a list that lives in one browser, so it's client code, in an island loaded when the browser is idle.

Actions, Regions and [custom attributes](06-interactivity.md#custom-attributes) cover forms, live updates and small behaviours. A client module is for what runs in the browser on its own: a chart, a map, an editor, browser storage. Three ways to ship one, each loaded only on pages that use it:

- [Island](api:yerd.Island): a part of the page mounted by a module.
- [lazyElement](api:yerd.lazyElement): a custom element whose definition loads when the tag appears.
- [attribute](api:yerd.attribute) with `client: "path"`: a custom attribute whose client half is a module.

## Client modules

Name client modules `*.client.ts` (or `.tsx`, `.js`, `.jsx`); the Vite plugin builds each as a client entry, with no need to list them in the `client` option. The shop's is `src/recent.client.ts`.

- Refer to a module by its source path from the Vite root: `"src/recent.client.ts"`, the file itself in dev and the hashed build output in production.
- Modules can import packages and each other; Vite splits shared code as usual.

## Islands

The module's default export mounts the island. It gets the `<yerd-island>` element, the props and the runtime API, and may return a cleanup:

```ts
// src/recent.client.ts
import type { IslandMount } from "@toyz/yerd/client";

/** The product on the page, as the server passes it. */
export interface RecentProps {
  id: number;
  name: string;
}

const KEY = "paperyard:recent";

const mount: IslandMount<RecentProps> = (el, product) => {
  let seen: RecentProps[] = [];
  // ...read localStorage[KEY], keeping only entries of the right shape
  const others = seen.filter((p) => p.id !== product.id).slice(0, 3);
  localStorage.setItem(KEY, JSON.stringify([{ id: product.id, name: product.name }, ...others]));
  if (others.length === 0) return;
  // ...an <h2>Recently viewed</h2> and a <ul> of links to the others
  el.replaceChildren(heading, list);
};

export default mount;
```

[island](api:yerd.island) makes a component with type-checked props; the props type comes over with a type-only import, so the module stays out of the server:

```tsx
// src/components.tsx
import { island } from "@toyz/yerd";
import type { RecentProps } from "./recent.client.js";

export const RecentlyViewed = island<RecentProps>("src/recent.client.ts", { when: "idle" });

// src/routes/products.tsx, at the end of the product page:
<RecentlyViewed class="recent" props={{ id: product.id, name: product.name }} />
```

```answer
GET /products/7
200 OK
content-type: text/html; charset=utf-8

<!doctype html><html lang="en"><head><!-- ... --><script type="module" src="/_yerd/runtime.js"></script><link rel="modulepreload" href="/_yerd/runtime-lazy.js?v=V5LIUwkHzD"></head><body><!-- ... --><div data-yx-live="/products/7/stock" hidden></div><yerd-island class="recent" data-yx-island="/src/recent.client.ts" data-yx-when="idle" data-yx-props="{&quot;id&quot;:7,&quot;name&quot;:&quot;Field notebook&quot;}" data-yx-keep data-key="yx-island-1o4ugeb"></yerd-island></article></main></body></html>
```

- Children show until the module mounts, and without JavaScript; the shop's island has none. [Island](api:yerd.Island) takes `src`, `when` and `props` directly, without a component.
- Props must be JSON: plain objects, arrays, strings, finite numbers, booleans and null. Anything else (a Date, a Map, a function) throws while rendering.
- The cleanup runs when the island leaves the page: a Region update, a boosted navigation.
- Morphs leave a mounted island alone while its module and props are the same, so the product page's live stock updates don't touch it. New props remount it.
- Other props (`class`, `style`, `id`) go on the `<yerd-island>` element. It's inline by default; the shop's `.recent` makes it a block.

> [!TAKE]
> Client code is the exception, and it's per page. The product page works without the island, and a page that doesn't render one never downloads it. You give up a client app that owns the page: islands share nothing but the DOM, the server and storage.

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

So does a plain `customElements.define(...)`. In a page, use the tag; its children show until it upgrades:

```tsx
<share-link url={url}>
  <a href={url}>Link to this page</a>
</share-link>
```

- The module loads when the first element with the tag fires its trigger; every instance upgrades then.
- Once upgraded, the element owns its children: a morph updates only its attributes.

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
- The first element to fire its trigger loads the module; then every element with the attribute connects, with `update` and `disconnect` as usual.

## Triggers

`when` takes the same values for all three:

| `when` | Loads |
|--------|-------|
| `"load"` (default) | as soon as the element is on the page |
| `"idle"` | when the browser is idle (two seconds at most): the shop's island |
| `"visible"` | when the element comes within 200px of the viewport |
| `"interaction"` | on the first pointerenter, pointerdown, focusin or touchstart |
| `"media:<query>"` | once the media query matches, e.g. `"media:(min-width: 800px)"` |

- `"load"` modules get a `<link rel="modulepreload">` after `<Scripts />`, so they download with the page (as does the runtime's loader, `runtime-lazy.js`, for any lazy module).
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

Import CSS from a client module as usual: `import "./recent.css";`. In dev, Vite injects it; in production, yerd links the module's stylesheets (from the Vite manifest) before it runs.

## Types

`@toyz/yerd/client` is types only, so `import type` adds nothing to a bundle:

| Type | For |
|------|-----|
| [IslandMount<P>](api:client.IslandMount) | an island module's default export |
| [AttributeSetup](api:client.AttributeSetup) | a lazy attribute half's default export |
| [YerdClient](api:client.YerdClient) | the runtime API passed to both |
| [LazyStartDetail](api:client.LazyStartDetail), [LazyEndDetail](api:client.LazyEndDetail) | the loading events (typed on `addEventListener`) |
| [LoadTrigger](api:client.LoadTrigger) | the `when` values |
