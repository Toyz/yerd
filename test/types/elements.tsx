// Compile-only checks for intrinsic element typings, run by `npm run check`
// (tsc). Each @ts-expect-error must stay an error; if one stops erroring, tsc
// fails.
import { action, bind, route, type ActionForm, type Child, type CSSProperties } from "@toyz/yerd";

@route("/types/elements")
export class Forms {
  @action save(_: {}, form: ActionForm) {
    return form;
  }

  @action remove({ id }: { id: string }) {
    return id;
  }

  page(): Child {
    return (
      <>
        <form action={this.save}>
          <button type="submit">Save</button>
          <button formaction={bind(this.remove, { id: "1" })}>Delete</button>
          <input type="submit" formaction={this.save} />
        </form>
        <form action="/search" method="get" enctype="multipart/form-data" novalidate>
          <input name="q" />
        </form>
      </>
    );
  }
}

const style: CSSProperties = { fontSize: 12, "--gap": "4px", "margin-top": "1rem", color: undefined };

export const valid = (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta http-equiv="refresh" content="5" />
      <meta property="og:title" content="yerd" />
      <link rel="stylesheet" href="/app.css" crossorigin />
      <script type="module" src="/app.js" async></script>
      <title>Types</title>
    </head>
    <body class={["page", { dark: true }]} style={style}>
      <a href="/" target="_blank" rel="noopener" download>home</a>
      <div id="x" className="y" hidden tabindex={-1} data-id={3} aria-hidden="true" aria-level={2} key="k">
        <span style="color: red" role="note" data-flag>text</span>
      </div>
      <img src="a.png" alt="" width={10} height="10" loading="lazy" decoding="async" />
      <input type="email" maxlength={20} minlength="1" required autocomplete="email" value={null} />
      <input type="x-custom" />
      <label for="q">Query</label>
      <textarea rows={3} wrap="soft">hi</textarea>
      <select name="s" multiple>
        <option value={1} selected>one</option>
      </select>
      <details open name="faq"><summary>More</summary></details>
      <dialog open closedby="any">dialog</dialog>
      <button type="button" popovertarget="p" popovertargetaction="toggle">menu</button>
      <div popover="auto" id="p" onclick={(e: MouseEvent) => e.clientX} ontoggle={(e) => e.type}>popover</div>
      <table><tbody><tr><th scope="col" colspan={2}>h</th><td rowspan="1">d</td></tr></tbody></table>
      <template shadowrootmode="open"><slot name="s" /></template>
      <video src="v.mp4" controls muted playsinline poster="p.png"><track kind="captions" src="c.vtt" default /></video>
      <time datetime="2026-01-01">new year</time>
      <ol start={3} type="i" reversed><li value={3}>three</li></ol>
      <br />
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width={10} fill="none" aria-hidden="true">
        <title>icon</title>
        <defs>
          <linearGradient id="g" x1="0" x2="1" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="red" stop-opacity={0.5} />
          </linearGradient>
        </defs>
        <g transform="translate(1 1)" stroke="currentColor" stroke-width={2} stroke-linecap="round">
          <path d="M0 0L10 10" />
          <circle cx={5} cy={5} r={2} />
          <rect x={1} y={1} width={2} height={2} rx={1} />
          <polyline points="0,0 1,1" />
          <use href="#g" />
        </g>
        <text x={0} y={9} font-family="sans-serif">t</text>
      </svg>
      <my-widget some-prop="x" anything={{ ok: true }} class="w">custom</my-widget>
    </body>
  </html>
);

// Async function components still work as tags.
const Async = async ({ name }: { name: string }) => <p>{name}</p>;
export const asyncUse = <Async name="x" key={1} />;

// @ts-expect-error unknown tag
export const unknownTag = <dvi />;

// @ts-expect-error typo'd attribute
export const typo = <a hreff="x" />;

// @ts-expect-error wrong value type
export const wrongType = <input maxlength={{}} />;

// @ts-expect-error void elements can't have children
export const voidChildren = <br>text</br>;

// @ts-expect-error put isn't a form method
export const badMethod = <form method="put" />;

// @ts-expect-error React spelling; the renderer writes prop names as-is
export const htmlFor = <label htmlFor="q" />;

// @ts-expect-error not a button type
export const badButton = <button type="link" />;

// @ts-expect-error boolean attribute given a number
export const badBool = <input disabled={1} />;

// @ts-expect-error unknown SVG attribute (camelCase names aren't covered by the kebab index)
export const badSvg = <circle radius={2} />;
