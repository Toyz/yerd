// Compile-only checks for rendering edges: <Local>, <Dynamic>, raw()/json(),
// class and style values. Each @ts-expect-error must stay an error.
import { Dynamic, Local, eq, json, not, raw, type Child } from "@toyz/yerd";

// ── <Local> ──

export const counter = (
  <Local state={{ count: 0, open: false, tab: "a" as "a" | "b", user: { name: "ada" }, tags: [] as string[] }}>
    {(s) => (
      <div>
        <button onClick={() => s.count++}>{s.count}</button>
        <p hidden={not(s.open)} aria-expanded={s.open}>{s.user.name}</p>
        <button class={["tab", { active: eq(s.tab, "a") }]} onClick={() => (s.tab = "b")}>a</button>
        <i hidden={not(eq(s.tab, "b"))}>{s.tags.length}</i>
        <input value={s.user.name} onInput={(e: Event) => (s.user.name = (e.target as HTMLInputElement).value)} />
      </div>
    )}
  </Local>
);

// An async render prop is fine: it returns a promise of JSX.
export const asyncProp = <Local state={{ a: 1 }}>{async (s) => <b>{s.a}</b>}</Local>;

export const persisted = (
  <>
    <Local state={{ a: 1 }} persist="key">{(s) => s.a}</Local>
    <Local state={{ a: 1 }} persist={{ key: "key", storage: "session" }}>{(s) => s.a}</Local>
  </>
);

// @ts-expect-error unknown field of the state
export const unknownField = <Local state={{ a: 1 }}>{(s) => s.b}</Local>;

// @ts-expect-error not() takes a boolean
export const notNumber = <Local state={{ n: 1 }}>{(s) => <b hidden={not(s.n)} />}</Local>;

// @ts-expect-error eq() compares with a value of the field's type
export const eqWrongType = <Local state={{ n: 1 }}>{(s) => <b hidden={eq(s.n, "1")} />}</Local>;

// @ts-expect-error the state is an object
export const primitiveState = <Local state={5}>{(s) => s}</Local>;

// @ts-expect-error storage is "local" or "session"
export const badStorage = <Local state={{}} persist={{ key: "k", storage: "disk" }}>{() => null}</Local>;

// @ts-expect-error the children are a render prop
export const notAFunction = <Local state={{}}><b /></Local>;

// @ts-expect-error a state is required
export const noState = <Local>{() => null}</Local>;

// ── <Dynamic> ──

export const dynamic = (
  <Dynamic id="who" as="span" class="x" fallback={<i>...</i>} noscript={<a href="/login">log in</a>}>
    {async () => <b>ada</b>}
  </Dynamic>
);

// @ts-expect-error the children are a function, called per request
export const dynamicText = <Dynamic id="x">text</Dynamic>;

// @ts-expect-error an id is required
export const dynamicNoId = <Dynamic>{() => null}</Dynamic>;

// ── raw(), json(), class, style ──

export const rawChild: Child = <div>{raw("<b>trusted</b>")}{json({ a: 1 })}</div>;
export const scriptData = <script type="application/json">{json({ a: "</script>" })}</script>;
export const classes = <b class={["a", null, false, undefined, ["b", { c: true, d: 0 }]]} className="e" />;
export const styles = <b style={{ marginTop: 0, "--gap": "1px", color: null, display: false, width: undefined }} />;
// json() output on a custom element (escaped by the renderer).
export const customJson = <my-widget props={json({ a: "<b>" })} />;

// @ts-expect-error a style value can't be true
export const styleTrue = <b style={{ color: true }} />;

// @ts-expect-error a style value can't be an object
export const styleObject = <b style={{ color: { r: 1 } }} />;

// @ts-expect-error class names aren't numbers
export const classNumber = <b class={5} />;

// TypeScript doesn't check hyphenated JSX attributes against the data-*
// index signature, so json() compiles here: the renderer escapes it.
export const dataJson = <b data-props={json({ a: "<b>" })} />;

// @ts-expect-error a key is a string or number
export const keyObject = <b key={{}} />;

// @ts-expect-error event handlers are functions or strings
export const handlerNumber = <b onclick={1} />;
