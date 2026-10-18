# Writing the guides

How the user guides in `docs/guide/` are written. For anyone (person or
agent) editing them.

## Voice

- Plain, direct, a little dry. Short sentences. Say what something does, then show it.
- Second person ("you"), present tense. No "simply", "just", "easy", "powerful".
- Terse: one lead sentence, then code, then the answer, then bullets for rules. Paragraphs of three lines at most.
- No internals unless you need them to use the feature correctly. How yerd does it inside goes in `docs/DYNAMICS.md`.
- Opinions are welcome where yerd chose something on purpose: put them in a "yerd's take" callout, not in the running text.

## One app, all the way

The core guides build one small shop together: `examples/shop`. Each guide
starts where the previous one stopped and ends with the shop working.

- Snippets come from `examples/shop` (trimmed with `// ...` where the rest is unchanged). If the code in a guide doesn't match the example, the example wins: fix the guide.
- A section opens with what we're adding to the shop, in one line ("The product page needs a 404 when the id is wrong.").
- Reference material that doesn't fit the shop (every option, edge cases) goes below the shop part of a section, under a plain heading or a table.
- Standalone guides (Recipes, Security, Deploying, Testing) still use the shop for their examples where it fits.

## Every example answers

yerd turns what a handler returns into the response, so show the response.
Put an `answer` block right after the code it answers. The site draws them
as one card; on GitHub it reads as a plain block.

````md
```tsx
@get show() {
  return this.catalog.find(this.id) ?? new NotFound("No such product");
}
```

```answer
GET /products/7
200 OK
content-type: application/json; charset=utf-8

{"id":7,"name":"Field notebook","price":2400}
---
GET /products/99
404 Not Found
content-type: application/json; charset=utf-8

{"error":"No such product","code":"not_found"}
```
````

- Each exchange: the request line, a blank-free block of the status line and the headers worth showing (not all of them), a blank line, then the body.
- Several exchanges are separated by a line with `---`.
- A request with a body: put it after the request line, then a line with `>>>` before the status line. An action's token is long and unreadable: write `_yx=(the form's token)&qty=3`.
- The request side has no headers. When one matters (a browser's `Accept: text/html`, the runtime's `yx`), say so in the line before the block.
- Write the standard reason phrase (`303 See Other`): `app.request()` leaves `statusText` empty.
- An HTML body is shown as source and, on the site, rendered in a small preview. Keep it short: elide with `<!-- ... -->`.
- Answers must be true. Take them from running `examples/shop` (or a test), not from memory.
- A tutorial step whose code is a subset of the shop answers for that subset: run it, or elide the parts the step doesn't have yet so the answer holds for both.

Errors are the named classes (`NotFound`, `Conflict`...), returned or thrown, never a bare
`404`. Numbers are for statuses without a body: `return 204` after a delete.

## yerd's take

````md
> [!TAKE]
> Handlers return, they don't call `res.send()`. A returned value can be
> tested, negotiated and wrapped in layouts; a sent one already happened.
````

- At most one or two per guide, where yerd does something on purpose differently. Say why and what you give up.

## Pictures

A drawn diagram, by name; the site draws it (see `site/src/diagrams.tsx`).
On GitHub it shows the fallback text inside the block.

````md
```diagram lifecycle
request -> middleware -> guards -> handler -> layouts -> response
```
````

Available: `lifecycle` (a request through middleware, guards, the handler,
layouts, the session commit), `action` (a form or element action posting,
the server answering with Regions, the morph). Ask for a new one rather than
drawing ASCII art.

## Toggles

When a few versions of one example differ in one place (what the handler
returns, which trigger, which store), show them as tabs instead of
repeating near-identical blocks. Consecutive code blocks with a `tab=`
label are grouped; an `answer` right after a tabbed block belongs to that tab.

````md
```tsx tab="A string"
@get hello() { return "hello"; }
```

```answer
GET /hello
200 OK
content-type: text/plain; charset=utf-8

hello
```

```tsx tab="An object"
@get hello() { return { hello: "world" }; }
```

```answer
GET /hello
200 OK
content-type: application/json; charset=utf-8

{"hello":"world"}
```
````

## Callouts

`> [!NOTE]`, `> [!WARNING]` and `> [!TAKE]` only. Keep them to two lines
where you can.

## Links

- Other guides: `[sessions](09-sessions-and-auth.md#section)`. Renaming a heading changes its anchor: update every link to it (grep `docs/`, `site/`, `src/` JSDoc and the README).
- The API: `[Session](api:yerd.Session)`.
- Files in the repository: a full GitHub URL (`https://github.com/Toyz/yerd/blob/main/examples/shop/src/cart.ts`). A relative path breaks on either GitHub or the site.
