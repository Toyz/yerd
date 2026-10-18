# Pages and layouts

This page covers how yerd turns TSX into HTML: components, attributes, layouts, error pages, assets, prerendering and per-request `<Dynamic>` parts.

## A page is just JSX

Return JSX from a handler and yerd renders it to HTML, wrapped in your layouts. There is no React here: TSX compiles against yerd's own JSX runtime, and the result is a plain HTML string streamed to the browser.

```tsx
import { get, route } from "@toyz/yerd";

@route("/hello")
export class Hello {
  @get page() {
    return <h1>Hello from yerd</h1>;
  }
}
```

Your `tsconfig.json` needs `"jsx": "react-jsx"` and `"jsxImportSource": "@toyz/yerd"` (see [getting started](01-getting-started.md)). When the first element rendered is `<html>`, yerd puts `<!doctype html>` in front of it for you.

## Components

A component is a function that takes props and returns JSX. Children arrive as `children`, typed with [Child](api:yerd.Child).

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

Components can be `async`. yerd awaits them in place, and flushes everything above them to the browser first, so a slow query doesn't hold up the top of the page.

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

Arrays render one after another, so `.map()` works as you'd expect. A `key` on an element is written as `data-key`, which the client runtime uses to match elements when it updates the page.

## What renders how

Attribute names are the real HTML names, lowercase: `for`, `maxlength`, `tabindex`, `autocomplete`. The one alias is `className`, which becomes `class`.

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

Style numbers get no unit: `{ width: 10 }` renders `width:10`, which CSS ignores, so write `"10px"`.

> [!NOTE]
> URL attributes (`href`, `src`, `action`, `formaction` and friends) are checked: `javascript:`, `vbscript:` and `data:` URLs become `about:blank#blocked`. `data:image/...` is allowed on `src` and `poster`.

### raw() and escaping

Text is always escaped. When you already have trusted HTML (rendered Markdown, an SVG from disk), wrap it in [raw](api:yerd.raw) to write it as is.

```tsx
import { raw } from "@toyz/yerd";

const article = <article>{raw(markdownToHtml(post.body))}</article>;
```

> [!WARNING]
> `raw()` skips escaping completely. Never pass it anything a user typed unless you sanitized it first.

### script and style

`<script>` and `<style>` contents are raw text, so `a > b` stays `a > b`. To hand data to an inline script, use [json](api:yerd.json): it escapes `<`, `>` and `&` so the data can't close the tag.

```tsx
import { json } from "@toyz/yerd";

<head>
  <style>{"main > p { margin: 0 }"}</style>
  <script type="application/json" id="state">{json({ user: "ada", note: "</script> is fine" })}</script>
</head>
```

Text that could end the element early (`</script`, `<!--`, `</style`) throws at render time instead of breaking your page.

As an attribute value, `json()` is escaped like any string, so `data-props={json(props)}` is safe too.

## Layouts

A layout is a component that receives [LayoutProps](api:yerd.LayoutProps): the page as `children`, plus `meta`. Register the root layout once with `app.layout()`, and every JSX response goes through it.

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

Layouts are ordinary components, so they can be async, resolve services and read the session. Layouts only wrap JSX: JSON, strings and streams go out untouched.

### Page metadata

`meta` is a [PageMeta](api:yerd.PageMeta) object merged from the route's group, the route, and anything the handler sets with [setMeta](api:yerd.setMeta).

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

Add your own fields with declaration merging, and every layout sees them typed:

```ts
declare module "@toyz/yerd" {
  interface PageMeta {
    nav?: "home" | "docs";
  }
}
```

### Nested layouts

Put `@layout()` on a route class, a single handler method, or a `@group` class. Those layouts nest inside the root layout, outermost first.

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

`{ inherit: false }` makes those layouts the whole chain, without the root layout. A layout already in the chain is never applied twice, so naming `RootLayout` again is harmless. Groups and their layouts are covered in [routing](02-routing.md).

## Error pages

Give the app an error page and 404s, thrown [HttpError](api:yerd.HttpError)s and crashes render as HTML inside your root layouts. It gets [ErrorPageProps](api:yerd.ErrorPageProps): the `status`, a `message` safe to show, and the `error` that was thrown.

```tsx
import { HttpError, yerd, type ErrorPageProps } from "@toyz/yerd";

function ErrorPage({ status, message, error }: ErrorPageProps) {
  return (
    <main class="error">
      <h1>{status === 404 ? "Nothing here" : "Something went wrong"}</h1>
      <p>{message}</p>
      {/* The real error, for you: only outside production. */}
      {process.env.NODE_ENV !== "production" && error instanceof Error && !(error instanceof HttpError) ? <pre>{error.stack}</pre> : null}
      <a href="/">Home</a>
    </main>
  );
}

const app = yerd().layout(RootLayout).errorPage(ErrorPage);
```

- Only requests that accept HTML get the page; API clients still get text or JSON.
- `message` is the HttpError's message below 500, and the plain status text (`Internal Server Error`) otherwise. Internal error messages never reach the page unless you render `error` yourself.
- `error` is what was thrown: an `HttpError` for a 404 or anything you threw on purpose, or whatever crashed. Use it to tell cases apart (`error instanceof NotSignedIn`) or to show the stack in development. Don't print its message or stack in production: it can hold secrets, SQL or file paths.
- `meta.title` is the message, unless the route already set a title.

## Assets

[Stylesheet](api:yerd.Stylesheet) and [assetUrl](api:yerd.assetUrl) take a source path and give you the right URL in dev and production.

```tsx
import { Stylesheet, assetUrl } from "@toyz/yerd";

<head>
  <Stylesheet href="src/styles.css" />
  <link rel="icon" href={assetUrl("src/favicon.svg")} />
</head>
```

In dev that's `/src/styles.css`, served by Vite. After `vite build` it's the hashed file (`/assets/styles-AbC123.css`), as long as the file is listed in the Vite plugin's `client` option. See [deploying](11-deploying.md).

### Scoped CSS: css``

[css](api:yerd.css) turns a block of rules into a class name, and a page gets those rules only if something on it uses the class. Styles live next to the component they style, with no stylesheet to keep in sync.

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

- The class (`yx-1k3j9a...`) is a hash of the rules: the same on every server and every restart, so it can be cached and shared. The rules are written as `.yx-1k3j9a { ...your rules }`, so `&` is the element (native CSS nesting) and `& h2` its headings.
- Use it like any class: `class={card}`, `class={[card, "wide"]}`, `class={{ [selected]: isSelected }}`. A flag that's off still sends its rules, since `<Local>` state may switch it on in the browser.
- Interpolate another class to get its selector (`${card}:hover & { ... }`), a `keyframes` name for an animation (the keyframes go wherever the rule goes), anything else as text.
- [css.global](api:yerd.css) is for rules that aren't scoped: resets, `body`, `:root` variables, `@font-face`.

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

Where the rules go:

| | Scoped rules | Global rules |
| --- | --- | --- |
| Development | into `<head>` at `<Styles />`, once per page; if the head has already been sent (see below), a `<style>` just before the first element using the class, which the runtime moves into `<head>` | written by `<Styles />` |
| After `vite build` | one hashed stylesheet (`/assets/yerd-<hash>.css`, cached for a year), linked by `<Styles />`; nothing is inlined | in that stylesheet too |

A page is held in memory until its first async boundary (an async component, a `<Dynamic>`), so for most pages the head is still there when the body renders and every rule lands in `<head>`: structural selectors like `li:first-child` or `h1 + p` see only your elements, with or without JavaScript. Classes first used after the head has gone out get their `<style>` next to the element instead, which the runtime moves into `<head>`; until it runs, that `<style>` counts as a sibling. To keep structural selectors exact everywhere, use the class before the first async boundary, or ship a build (`vite build` inlines nothing). An action's response repeats the rules of what it renders, so a Region that arrives later is styled too.

> [!NOTE]
> Classes are found in `class` and `className` props (strings, arrays, flag objects, `raw()` values, `<Local>` bindings), and `keyframes` names in `style` (`style={{ animation: `${pop} 1s` }}`). A class name buried in other HTML isn't seen. Without `<Styles />`, or after the head has gone out, rules for classes inside `<select>`, `<colgroup>`, `<svg>` or `<math>` are written right after the element closes, where a `<style>` is parsed properly.

### Images

Images are plain HTML, and the browser's loading hints are typed: `loading="lazy"` defers offscreen images and iframes, `decoding="async"` keeps decoding off the main thread, `fetchpriority="high"` hurries the one that matters (your hero image), and `srcset` / `sizes` / `<picture>` pick the right file for the screen.

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

In development, `assetUrl()` and `<Stylesheet>` warn in the terminal (once per file) when a file doesn't exist, when it's in `public/` but written with the folder (`assetUrl("public/x.svg")` instead of `assetUrl("x.svg")`), or when it isn't in the plugin's `client` option: those work in dev and break after `vite build`. In production, files from `public/` resolve as they are.

Give images a `width` and `height` so the page doesn't jump as they load. Files in `public/` are served as they are; `assetUrl()` is for files Vite should fingerprint (list them in the plugin's `client` option).

## Prerendering

Pages that are the same for everyone can be rendered once at build time. Add [@prerender](api:yerd.prerender) and `vite build` writes them as static files that the server sends without running your handler.

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

- HTML goes to `<path>/index.html`. Anything else is written to the path itself, so give JSON routes an extension.
- Routes with params need `paths`: a list, or a function (async is fine) that may `resolve()` services.
- A prerendered route can't read request data (query, headers, cookies, session, body, the signed-in user). The build fails and names the route, instead of freezing one visitor's data into a file.

## Dynamic parts

A mostly-static page often has one per-visitor corner, like "Log in" vs. "@ada". Wrap it in [Dynamic](api:yerd.Dynamic): the prerendered file ships the `fallback`, and the client runtime fetches the real content after the page loads.

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

On normal (not prerendered) requests, `<Dynamic>` just renders its children inline. All of a page's Dynamic parts are fetched in one request, and the page needs `<Scripts />` (see [interactivity](06-interactivity.md)).

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

- Names are HTML names: `htmlFor` and `tabIndex` don't exist, because they'd render as wrong HTML.
- `aria-*` and `data-*` attributes are accepted on every element.
- Custom elements (any tag with a dash, like `<my-widget>`) take any attributes.
- `on*` handlers are dropped on the server, except inside [`<Local>`](06-interactivity.md#local-state-no-server-at-all), where they run in the browser against its state. For server-side reactions, use an [action](06-interactivity.md#actions-forms-that-call-methods).
- Your own [custom attributes](06-interactivity.md#custom-attributes) are typed by extending `CustomAttributes`.
