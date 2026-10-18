# Pages and layouts

How TSX becomes HTML: components, attributes, layouts, error pages, assets, prerendering and per-request `<Dynamic>` parts.

## A page is just JSX

Return JSX from a handler and yerd renders it to HTML inside your layouts. There's no React: TSX compiles against yerd's own JSX runtime and streams a plain HTML string.

```tsx
import { get, route } from "@toyz/yerd";

@route("/hello")
export class Hello {
  @get page() {
    return <h1>Hello from yerd</h1>;
  }
}
```

- `tsconfig.json` needs `"jsx": "react-jsx"` and `"jsxImportSource": "@toyz/yerd"` (see [getting started](01-getting-started.md)).
- When the first element is `<html>`, `<!doctype html>` is added in front.

## Components

A component is a function from props to JSX; children arrive as `children`, typed with [Child](api:yerd.Child).

```tsx
import type { Child } from "@toyz/yerd";

function Card({ title, children }: { title: string; children?: Child }) {
  return (
    <section class="card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

const page = <Card title="Inbox">Nothing new.</Card>;
```

Components can be `async`. They're awaited in place, and everything above them is flushed to the browser first:

```tsx
async function Stats() {
  const res = await fetch("https://api.example.com/stats");
  const { visits } = (await res.json()) as { visits: number };
  return <p>{visits} visits today</p>;
}

const page = (
  <main>
    <h1>Dashboard</h1> {/* sent right away */}
    <Stats />          {/* streamed in when the fetch finishes */}
  </main>
);
```

Async siblings wait together, so three slow sections take as long as the slowest:

```tsx
const page = (
  <main>
    <Stats />    {/* these three start together */}
    <Orders />
    <Activity />
  </main>
);
```

- Output still goes out in page order. If one fails, the page fails at that point, as if they ran one by one.
- Only `async` components among the same children (a `.map()` array or fragment included) start early; one nested inside a later element (`<section><Orders /></section>`) runs when reached. Make slow parts siblings.
- An early starter runs before the components above it render, so don't depend on their side effects.
- Arrays render in order. A `key` is written as `data-key`, which the client runtime uses to match elements.

## What renders how

Attribute names are the real lowercase HTML names (`for`, `maxlength`, `tabindex`); the one alias is `className` for `class`.

```tsx
<div
  class={["todo", { done: true, hidden: false }]}   // class="todo done"
  style={{ marginTop: "8px", "--gap": "1rem" }}     // style="margin-top:8px;--gap:1rem"
  hidden={false}                                    // omitted
  aria-hidden={false}                               // aria-hidden="false"
  data-open={true}                                  // data-open
  title={`<"quoted">`}                              // escaped
>
  {"<b>not bold</b>"}
</div>
```

| Value | Renders as |
|---|---|
| string | escaped text or attribute value |
| number | as is (`NaN` attributes are dropped) |
| `true` | a bare attribute (`disabled`) |
| `false`, `null`, `undefined` | nothing (children and attributes) |
| `aria-*`, `draggable`, `spellcheck`, `contenteditable`, `writingsuggestions` + boolean | the words `"true"` / `"false"` (`translate`: `"yes"` / `"no"`, `autocorrect`: `"on"` / `"off"`) |
| `class` / `className` | strings, arrays and `{ name: boolean }` objects, merged into one attribute |
| `style` object | camelCase to kebab-case, `--custom` kept, empty values skipped |
| `Date` / `URL` attribute | ISO string / `href` |
| `on*` handler function | nothing, except inside [`<Local>`](06-interactivity.md#local-state-no-server-at-all), where it runs in the browser (a string handler renders as written) |

- Style numbers get no unit: `{ width: 10 }` renders `width:10`, which CSS ignores; write `"10px"`.

> [!NOTE]
> URL attributes (`href`, `src`, `action`, `formaction` and friends) with `javascript:`, `vbscript:` or `data:` URLs become `about:blank#blocked`. `data:image/...` is allowed on `src` and `poster`.

### raw() and escaping

Text is always escaped; wrap trusted HTML (rendered Markdown, an SVG from disk) in [raw](api:yerd.raw) to write it as is.

```tsx
import { raw } from "@toyz/yerd";

const article = <article>{raw(markdownToHtml(post.body))}</article>;
```

> [!WARNING]
> `raw()` skips escaping completely. Never pass it user input you haven't sanitized.

### script and style

`<script>` and `<style>` contents are raw text (`a > b` stays as is). Hand data to an inline script with [json](api:yerd.json), which escapes `<`, `>` and `&` so it can't close the tag.

```tsx
import { json } from "@toyz/yerd";

<head>
  <style>{"main > p { margin: 0 }"}</style>
  <script type="application/json" id="state">{json({ user: "ada", note: "</script> is fine" })}</script>
</head>
```

- Text that could end the element early (`</script`, `<!--`, `</style`) throws at render time.
- As an attribute value `json()` is escaped like any string, so `data-props={json(props)}` is safe.

## Layouts

A layout is a component that receives [LayoutProps](api:yerd.LayoutProps) (the page as `children`, plus `meta`). Register the root layout with `app.layout()`.

```tsx
import { Scripts, Stylesheet, yerd, type LayoutProps } from "@toyz/yerd";

function RootLayout({ children, meta }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{meta.title ? `${meta.title} | My app` : "My app"}</title>
        <Stylesheet href="src/styles.css" />
        <Scripts />
      </head>
      <body>{children}</body>
    </html>
  );
}

const app = yerd().layout(RootLayout);
```

- Layouts can be async, resolve services and read the session.
- They only wrap JSX: JSON, strings and streams go out untouched.

### Page metadata

`meta` is a [PageMeta](api:yerd.PageMeta) merged from the route's group, the route, and the handler's [setMeta](api:yerd.setMeta) calls.

```tsx
import { get, param, route, setMeta } from "@toyz/yerd";

@route("/posts/:slug", { meta: { title: "Blog" } })
export class Post {
  @param("slug") accessor slug!: string;

  @get page() {
    setMeta({ title: `Post ${this.slug}`, description: "A post" });
    return <article>...</article>;
  }
}
```

Add your own typed fields with declaration merging:

```ts
declare module "@toyz/yerd" {
  interface PageMeta {
    nav?: "home" | "docs";
  }
}
```

### Nested layouts

`@layout()` on a route class, a handler method or a `@group` class nests layouts inside the root layout, outermost first.

```tsx
import { get, layout, noLayout, route, type LayoutProps } from "@toyz/yerd";

function DocsLayout({ children }: LayoutProps) {
  return <div class="docs"><nav>...</nav>{children}</div>;
}
function PrintLayout({ children }: LayoutProps) {
  return <html><body class="print">{children}</body></html>;
}

@route("/docs")
@layout(DocsLayout)
export class Docs {
  @get page() { return <h1>Docs</h1>; } // RootLayout > DocsLayout
}

@route("/docs/print")
@layout(PrintLayout, { inherit: false })
export class DocsPrint {
  @get page() { return <h1>Docs</h1>; } // PrintLayout only
}

@route("/docs/toc")
export class DocsToc {
  @get @noLayout toc() { return <ul><li>Intro</li></ul>; } // no layouts at all
}
```

- `{ inherit: false }` drops the root layout from the chain.
- A layout already in the chain is never applied twice.
- Groups are covered in [routing](02-routing.md).

## Error pages

With an error page, 404s, thrown [YerdError](api:yerd.YerdError)s and crashes render as HTML inside your root layouts. It gets [ErrorPageProps](api:yerd.ErrorPageProps): `status`, a safe-to-show `message`, and the thrown `error`.

```tsx
import { YerdError, yerd, type ErrorPageProps } from "@toyz/yerd";

function ErrorPage({ status, message, error }: ErrorPageProps) {
  return (
    <main class="error">
      <h1>{status === 404 ? "Nothing here" : "Something went wrong"}</h1>
      <p>{message}</p>
      {/* The real error, for you: only outside production. */}
      {process.env.NODE_ENV !== "production" && error instanceof Error && !(error instanceof YerdError) ? <pre>{error.stack}</pre> : null}
      <a href="/">Home</a>
    </main>
  );
}

const app = yerd().layout(RootLayout).errorPage(ErrorPage);
```

- Only requests that accept HTML get the page; API clients still get text or JSON.
- `message` is the YerdError's message below 500, else the status text (`Internal Server Error`).
- Use `error` to tell cases apart (`error instanceof NotSignedIn`). Don't print its message or stack in production: it can hold secrets, SQL or paths.
- `meta.title` is the message unless the route set a title.

## Assets

[Stylesheet](api:yerd.Stylesheet) and [assetUrl](api:yerd.assetUrl) take a source path and give the right URL in dev and production.

```tsx
import { Stylesheet, assetUrl } from "@toyz/yerd";

<head>
  <Stylesheet href="src/styles.css" />
  <link rel="icon" href={assetUrl("src/favicon.svg")} />
</head>
```

- In dev that's `/src/styles.css`, served by Vite. After `vite build` it's the hashed file (`/assets/styles-AbC123.css`), if the file is listed in the Vite plugin's `client` option (see [deploying](11-deploying.md)).
- Files in `public/` are served as they are; write `assetUrl("x.svg")`, not `"public/x.svg"`.
- In dev, both warn once per file when it doesn't exist, is written with `public/`, or isn't in `client`: those break after `vite build`.

### Scoped CSS: css``

[css](api:yerd.css) turns a block of rules into a class name; a page gets the rules only if something on it uses the class.

```tsx
import { css, keyframes, type Child } from "@toyz/yerd";

const pop = keyframes`from { transform: scale(0.9); opacity: 0; }`;

const card = css`
  padding: 16px;
  border-radius: 12px;
  animation: ${pop} 0.2s ease-out;
  &:hover { box-shadow: 0 4px 12px #0002; }
  & h2 { margin: 0 0 8px; }
`;

export function Card({ title, children }: { title: string; children: Child }) {
  return (
    <section class={card}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
```

- The class (`yx-1k3j9a...`) is a hash of the rules, stable across servers and restarts. `&` is the element (native CSS nesting).
- Use it like any class: `class={card}`, `class={[card, "wide"]}`, `class={{ [selected]: isSelected }}`. A flag that's off still sends its rules, since `<Local>` state may switch it on.
- Interpolate another class for its selector (`${card}:hover & { ... }`), a `keyframes` name for an animation, anything else as text.
- [css.global](api:yerd.css) is for unscoped rules: resets, `body`, `:root` variables, `@font-face`.

Put [`<Styles />`](api:yerd.Styles) in your root layout's `<head>`:

```tsx
css.global`
  :root { --accent: #d6452b; }
  body { margin: 0; font-family: system-ui, sans-serif; }
`;

export function RootLayout({ children }: LayoutProps) {
  return (
    <html>
      <head>
        <Styles />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

- In dev, rules are inlined at `<Styles />`. After `vite build`, scoped and global rules go into one hashed stylesheet that `<Styles />` links.
- In dev, a class first used after an async boundary (an async component, a `<Dynamic>`) gets its `<style>` next to the element until the runtime moves it into `<head>`, which can throw off structural selectors like `li:first-child`. Use such classes before the first async boundary, or rely on the build.
- An action's response carries the rules for what it renders.

> [!NOTE]
> Classes are found in `class` and `className` props (strings, arrays, flag objects, `raw()` values, `<Local>` bindings) and `keyframes` names in `style`. A class name buried in other HTML isn't seen.

### Images

Images are plain HTML with typed loading hints: `loading="lazy"`, `decoding="async"`, `fetchpriority="high"` for the hero image, and `srcset` / `sizes` / `<picture>`.

```tsx
<img src={assetUrl("src/hero.jpg")} alt="" width={1200} height={600} fetchpriority="high" />

{products.map((p) => (
  <img src={p.photo} alt={p.name} width={320} height={240} loading="lazy" decoding="async"
    srcset={`${p.photo}?w=320 320w, ${p.photo}?w=640 640w`} sizes="(max-width: 600px) 50vw, 320px" />
))}

<picture>
  <source type="image/avif" srcset="/cat.avif" />
  <img src="/cat.jpg" alt="A cat" loading="lazy" />
</picture>
```

Give images a `width` and `height` so the page doesn't jump as they load.

## Prerendering

[@prerender](api:yerd.prerender) renders a page once at `vite build`; the server then sends the static file without running your handler.

```tsx
import { get, param, prerender, route } from "@toyz/yerd";

@prerender
@route("/about", { meta: { title: "About" } })
export class About {
  @get page() { return <h1>About us</h1>; }
}

@prerender({ paths: ["/docs/intro", "/docs/setup"] })
@route("/docs/:slug")
export class Doc {
  @param("slug") accessor slug!: string;
  @get page() { return <article>{this.slug}</article>; }
}

@prerender
@route("/config.json")
export class PublicConfig {
  @get config() { return { name: "my app", builtAt: new Date().toISOString() }; }
}
```

- HTML goes to `<path>/index.html`; anything else to the path itself, so give JSON routes an extension.
- Routes with params need `paths`: a list, or a function (async is fine) that may `resolve()` services.
- A prerendered route can't read request data (query, headers, cookies, session, body, user); the build fails naming the route.

## Dynamic parts

Wrap a per-visitor corner of a static page ("Log in" vs. "@ada") in [Dynamic](api:yerd.Dynamic): the prerendered file ships the `fallback`, and the runtime fetches the real content after load.

```tsx
import { Dynamic, type LayoutProps } from "@toyz/yerd";

function MarketingLayout({ children }: LayoutProps) {
  return (
    <div>
      <header>
        <Dynamic
          id="account"
          fallback={<span class="skeleton" aria-label="Loading" />}
          noscript={<a href="/login">Log in</a>}
        >
          {() => <AccountMenu />}
        </Dynamic>
      </header>
      <main>{children}</main>
    </div>
  );
}
```

| Prop | What it does |
|---|---|
| `id` | Required, unique on the page. Letters, digits, `-` and `_`. |
| `children` | A function that renders the real content. It may read the session or user, because it never runs at build time. |
| `fallback` | What the static file shows until the runtime fills it in. |
| `noscript` | What visitors without JavaScript see instead of the fallback. |
| `as` | The wrapper element, `div` by default. Other props become its attributes. |

- On normal requests `<Dynamic>` renders its children inline.
- All of a page's Dynamic parts are fetched in one request. The page needs `<Scripts />` (see [interactivity](06-interactivity.md)).

## Typed JSX elements

Every HTML and SVG element is typed, so typos and wrong values fail at compile time.

```tsx
const signup = (
  <form method="post">
    <label for="email">Email</label>
    <input id="email" type="email" name="email" maxlength={120} required autocomplete="email" />
    <my-widget size="large" any-prop="ok" />
  </form>
);
```

- Names are HTML names: `htmlFor` and `tabIndex` don't exist.
- `aria-*` and `data-*` are accepted everywhere; custom elements (tags with a dash) take any attributes.
- `on*` handlers are dropped on the server except inside [`<Local>`](06-interactivity.md#local-state-no-server-at-all). For server-side reactions, use an [action](06-interactivity.md#actions-forms-that-call-methods).
- Type your own [custom attributes](06-interactivity.md#custom-attributes) by extending `CustomAttributes`.
