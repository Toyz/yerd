/**
 * Hand-written attribute typings for JSX intrinsic elements.
 *
 * Attribute names are the HTML names, lowercase, exactly as they render:
 * `tabindex`, `maxlength`, `for`, `http-equiv`. The renderer writes each prop
 * out by name, so camelCase React spellings like `htmlFor` or `tabIndex` would
 * produce wrong HTML and aren't declared. `className` is the one alias, since
 * the renderer maps it to `class`.
 *
 * How values render (see src/render/attrs.ts): `true` writes a bare attribute,
 * `false`, `null` and `undefined` write nothing, strings and numbers are
 * escaped. `class` takes a ClassValue and `style` a string or CSSProperties.
 * Functions write nothing, which is why the `on*` handlers below compile but
 * render nothing, except inside a `<Local>`, where they're shipped to the
 * browser and run against its state.
 *
 * Types only; nothing here exists at runtime.
 */

import type { ActionLambda, BoundAction } from "../actions/action.js";
import type { ClassValue } from "../render/attrs.js";
import type { Child } from "./jsx-runtime.js";
import type { PrefetchValue } from "../attributes/attribute.js";

// ── value helpers ──

/** A number, or a string holding one (`width="100%"`, `tabindex="-1"`). */
type Numberish = number | string;
/** Enumerated "true"/"false" attributes such as `draggable` and `spellcheck`. */
type Booleanish = boolean | "true" | "false";
/** A known set of values, while still accepting anything else as a string. */
type Open<T extends string> = T | (string & {});

/**
 * Inline style. Keys can be camelCase (`fontSize`, rendered as `font-size`),
 * kebab-case, or custom properties (`--gap`). `null`, `undefined`, `false`
 * and `""` drop the declaration. Numbers get no unit (`{ width: 10 }` renders
 * `width:10`, which CSS ignores), so write `"10px"`.
 *
 * ```tsx
 * <div style={{ marginTop: "8px", "--gap": "1rem", display: isOpen ? undefined : "none" }} />
 * // style="margin-top:8px;--gap:1rem"  (when open)
 *
 * function Box({ style, children }: { style?: CSSProperties; children?: Child }) {
 *   return <div style={{ padding: "1rem", ...style }}>{children}</div>;
 * }
 * ```
 */
export interface CSSProperties {
  [property: string]: string | number | null | undefined | false;
}

/**
 * An event handler. Outside a `<Local>` a function handler renders nothing
 * (it's dropped on the server); inside one it's sent to the browser as source
 * and runs against the Local's state. A string is an inline handler and does
 * render. Declared method-style so a handler taking a narrower event, like
 * `(e: MouseEvent) => void`, is accepted.
 *
 * ```tsx
 * <Local state={{ count: 0 }}>
 *   {(s) => <button onClick={(e: MouseEvent) => (s.count += e.shiftKey ? 10 : 1)}>+{s.count}</button>}
 * </Local>
 *
 * <button onclick="history.back()">Back</button>
 * ```
 */
export type EventHandler = { bivarianceHack(event: Event): unknown }["bivarianceHack"] | string;

/**
 * A yerd action: a lambda calling one @action method (`() => this.remove({ id })`),
 * an action that takes no arguments (`this.add`), or bind(...) of one. What
 * the `action` prop takes on any element; type a prop with it to pass any of
 * those down.
 *
 * ```tsx
 * function SaveKey({ save }: { save: ActionValue }) {
 *   return <input action={save} trigger="keydown:Enter" />;
 * }
 *
 * // in the route: <SaveKey save={({ el }) => this.save({ title: el.value })} />
 * ```
 */
export type ActionValue = ActionLambda | BoundAction<any>;

/**
 * Things yerd can turn into a form submission target: a URL or an action.
 * What a form's `action` and a button's `formaction` take.
 *
 * ```tsx
 * function SaveForm({ to, children }: { to: FormActionValue; children?: Child }) {
 *   return <form action={to} method="post">{children}<button>Save</button></form>;
 * }
 *
 * <SaveForm to="/legacy/save" />
 * <SaveForm to={this.save} />
 * ```
 */
export type FormActionValue = string | ActionValue;

type TriggerEvent =
  | "click" | "dblclick" | "input" | "change" | "submit"
  | "keydown" | "keyup" | "keypress" | "focus" | "blur" | "focusin" | "focusout"
  | "mouseenter" | "mouseleave" | "pointerdown" | "pointerup" | "toggle";

/**
 * When an element's action fires. Any DOM event (`"click"`, `"keyup"`, or a
 * custom one), optionally debounced (`"input 250ms"`) or filtered by key
 * (`"keydown:Enter"`); `"drop"` when one of the page's `draggable` elements
 * is dropped on it (the lambda's `drag` is that element), `"drop:<selector>"`
 * for only those matching it, `"drop:files"` for files dropped from outside
 * the page (posted as `form.files("files")`, filtered by `accept`);
 * `"visible"` when it scrolls into view (once per
 * render: infinite scroll); `"load"` as soon as the page has it; `"every 5s"`
 * on a timer while it's on the page and the tab is visible.
 *
 * ```tsx
 * <input type="search" action={({ el }) => this.search({ q: el.value })} trigger="input 250ms" />
 * <input action={({ el }) => this.add({ title: el.value })} trigger="keydown:Enter" />
 * <section action={({ drag }) => this.move({ id: drag.data("id"), to: "done" })} trigger="drop:.card" />
 * <div action={this.refreshStats} trigger="every 30s" />
 * ```
 */
export type ActionTrigger =
  | TriggerEvent
  | `${TriggerEvent} ${number}ms`
  | `${"keydown" | "keyup"}:${string}`
  | "drop"
  | "drop:files"
  | `drop:${string}`
  | "visible"
  | "load"
  | `every ${number}${"s" | "ms"}`
  | (string & {});

export type HTMLAttributeReferrerPolicy =
  | ""
  | "no-referrer"
  | "no-referrer-when-downgrade"
  | "origin"
  | "origin-when-cross-origin"
  | "same-origin"
  | "strict-origin"
  | "strict-origin-when-cross-origin"
  | "unsafe-url";

export type HTMLAttributeAnchorTarget = Open<"_self" | "_blank" | "_parent" | "_top">;
export type CrossOrigin = boolean | "" | "anonymous" | "use-credentials";
export type FetchPriority = "high" | "low" | "auto";
export type FormMethod = "get" | "post" | "dialog" | "GET" | "POST" | "DIALOG";
export type FormEnctype = "application/x-www-form-urlencoded" | "multipart/form-data" | "text/plain";
export type PopoverTargetAction = "hide" | "show" | "toggle";

/**
 * Values for `<input type>`; any other string is allowed too. Narrow it in a
 * wrapper component to the types it supports:
 *
 * ```tsx
 * function NumberField({ type = "number", ...rest }: InputAttributes & { type?: Extract<InputType, "number" | "range"> }) {
 *   return <input type={type} {...rest} />;
 * }
 *
 * <NumberField name="qty" min={1} max={10} />
 * ```
 */
export type InputType =
  | "button"
  | "checkbox"
  | "color"
  | "date"
  | "datetime-local"
  | "email"
  | "file"
  | "hidden"
  | "image"
  | "month"
  | "number"
  | "password"
  | "radio"
  | "range"
  | "reset"
  | "search"
  | "submit"
  | "tel"
  | "text"
  | "time"
  | "url"
  | "week"
  | (string & {});

export type AutoFill = Open<
  | "on"
  | "off"
  | "name"
  | "given-name"
  | "family-name"
  | "nickname"
  | "username"
  | "email"
  | "new-password"
  | "current-password"
  | "one-time-code"
  | "organization"
  | "street-address"
  | "address-line1"
  | "address-line2"
  | "country"
  | "country-name"
  | "postal-code"
  | "cc-name"
  | "cc-number"
  | "cc-exp"
  | "cc-csc"
  | "bday"
  | "sex"
  | "tel"
  | "url"
  | "photo"
>;

// ── global ──

/**
 * Custom attributes (see attribute()), on every element. Augment it to type
 * your own: `declare module "@toyz/yerd" { interface CustomAttributes { tooltip?: string } }`.
 *
 * ```tsx
 * export const tooltip = attribute("tooltip", {
 *   client(el, value) {
 *     el.title = value;
 *   },
 * });
 *
 * declare module "@toyz/yerd" {
 *   interface CustomAttributes {
 *     tooltip?: string;
 *   }
 * }
 *
 * <button tooltip="Delete this todo">x</button>
 * ```
 */
export interface CustomAttributes {
  /**
   * Warm the link's page (or `{ url }`) before it's needed. See PrefetchValue.
   *
   * ```tsx
   * <a href="/todos" prefetch>Todos</a>
   * <a href="/reports" prefetch="visible">Reports</a>
   * ```
   */
  prefetch?: PrefetchValue;
}

/**
 * Attributes every HTML element accepts: the standard global attributes,
 * `aria-*` and `data-*`, yerd's `action` / `trigger` / `dropTo` / `sync` /
 * `cue`, and your CustomAttributes. Spread it into a wrapper component's
 * props to pass attributes through:
 *
 * ```tsx
 * function Panel({ heading, children, ...rest }: GlobalAttributes & { heading: string }) {
 *   return <section {...rest} class="panel"><h2>{heading}</h2>{children}</section>;
 * }
 *
 * <Panel heading="Stats" id="stats" data-tab="1" aria-live="polite">{stats}</Panel>
 * ```
 */
export interface GlobalAttributes extends CustomAttributes {
  children?: Child;
  /**
   * A yerd action this element runs when `trigger` fires (default: click),
   * with the client runtime: `<button action={() => this.remove({ id })}>`,
   * `<input action={({ el }) => this.search({ q: el.value })} trigger="input 250ms">`.
   * Use a form when it must work without JavaScript.
   *
   * ```tsx
   * <button action={() => this.remove({ id })}>Delete</button>
   * <input type="search" action={({ el }) => this.search({ q: el.value })} trigger="input 250ms" />
   * ```
   */
  action?: ActionValue;
  /**
   * When `action` fires. See ActionTrigger.
   *
   * ```tsx
   * <div action={() => this.more({ page: 2 })} trigger="visible" />
   * ```
   */
  trigger?: ActionTrigger;
  /**
   * For `trigger="drop:files"`: which files it takes, like an input's (`"image/*,.pdf"`).
   *
   * ```tsx
   * <div class="dropzone" action={this.upload} trigger="drop:files" accept="image/*,.pdf">
   *   Drop photos or PDFs
   * </div>
   * ```
   */
  accept?: string;
  /**
   * Make this element a drop zone for a file input elsewhere in the form
   * (a CSS selector, `"#photos"`): files dropped on it are added to that
   * input, filtered by its `accept` (and kept to one unless it's `multiple`),
   * and go up with the form when it's submitted. The input still works on
   * its own, with or without JavaScript. While files are staged the zone has
   * `data-yx-files="<count>"`.
   *
   * ```tsx
   * <form action={this.post} enctype="multipart/form-data">
   *   <input id="photos" type="file" name="photos" multiple accept="image/*" />
   *   <div class="dropzone" dropTo="#photos">Drop photos here</div>
   *   <button>Post</button>
   * </form>
   * ```
   */
  dropTo?: string;
  /**
   * Keep this element's looping CSS animations (and its children's) in step
   * on every screen: each page lines them up against the server's clock, as
   * if they all started at the same moment. `animation-delay` still works,
   * as an offset (stagger a row with it). Only infinite animations are
   * moved; for one-off moments, use `cue`.
   *
   * ```tsx
   * const bob = keyframes`50% { transform: translateY(-12px); }`;
   * const dancer = css`animation: ${bob} 600ms ease-in-out infinite;`;
   *
   * <div class={dancer} sync>gnome</div> // bobs in time with everyone else's
   * ```
   */
  sync?: boolean;
  /**
   * Play when the server plays this cue (`cues.play(name)`), at the same
   * moment as every other page. The element gets `data-yx-cued="<name>"`
   * (restarting a CSS animation keyed off it), an `<audio>` / `<video>`
   * plays, and a `yx:cue` event bubbles from it. Several names: a
   * space-separated string or an array. See Cues.
   *
   * ```tsx
   * const shake = css`&[data-yx-cued] { animation: ${wobble} 400ms; }`;
   *
   * <img class={shake} src="/gnome.png" cue="airhorn" />
   * <audio src="/airhorn.mp3" cue="airhorn" />
   * ```
   */
  cue?: string | readonly string[];
  /**
   * The room `cue` listens to. Default `"main"`, where cues go without a
   * `room`. The built-in stream only serves public rooms (`yerd({ cues: {
   * public } })`); serve the others from your own route with `cueFrom`.
   *
   * ```tsx
   * <div class={confetti} cue="goal" cueRoom={`match:${matchId}`} />
   * ```
   */
  cueRoom?: string;
  /**
   * Listen for `cue` on your own stream route instead of the public one: a
   * route returning `cues.listen(rooms, signal)` behind whatever guards the
   * room needs. Every cue it sends is for this element (narrowed to
   * `cueRoom` if that's set too).
   *
   * ```tsx
   * <div class={confetti} cue="goal" cueFrom={`/teams/${team.id}/cues`} />
   * ```
   */
  cueFrom?: string;
  /**
   * Not an attribute: the JSX key. On an element it renders as `data-key`,
   * which the runtime uses to match elements when it morphs a list.
   *
   * ```tsx
   * <ul>{todos.map((t) => <li key={t.id}>{t.title}</li>)}</ul>
   * ```
   */
  key?: string | number;

  id?: string;
  class?: ClassValue;
  /** Alias for `class`; renders as `class`. */
  className?: ClassValue;
  style?: string | CSSProperties;
  title?: string;
  lang?: string;
  dir?: "ltr" | "rtl" | "auto";
  hidden?: boolean | "" | "hidden" | "until-found";
  tabindex?: Numberish;
  accesskey?: string;
  autofocus?: boolean;
  autocapitalize?: "off" | "none" | "on" | "sentences" | "words" | "characters";
  autocorrect?: "on" | "off" | boolean;
  contenteditable?: Booleanish | "" | "plaintext-only" | "inherit";
  draggable?: Booleanish;
  enterkeyhint?: "enter" | "done" | "go" | "next" | "previous" | "search" | "send";
  inputmode?: "none" | "text" | "decimal" | "numeric" | "tel" | "search" | "email" | "url";
  inert?: boolean;
  is?: string;
  nonce?: string;
  part?: string;
  exportparts?: string;
  popover?: boolean | "" | "auto" | "manual" | "hint";
  role?: string;
  slot?: string;
  spellcheck?: Booleanish;
  translate?: boolean | "" | "yes" | "no";
  writingsuggestions?: Booleanish;

  // microdata
  itemscope?: boolean;
  itemprop?: string;
  itemtype?: string;
  itemid?: string;
  itemref?: string;

  // RDFa, commonly used for Open Graph <meta property> tags and the like
  about?: string;
  property?: string;
  resource?: string;
  typeof?: string;
  vocab?: string;
  prefix?: string;

  [aria: `aria-${string}`]: string | number | boolean | null | undefined;
  [data: `data-${string}`]: string | number | boolean | null | undefined;
  /** Event handlers: they compile, but render nothing outside a `<Local>` (see EventHandler). */
  [handler: `on${string}`]: EventHandler | undefined;
}

/**
 * For elements that can't have children (`<br>`, `<img>`, `<input>`, ...).
 * Passing children to one is a compile error.
 *
 * ```tsx
 * function Divider(props: VoidAttributes) {
 *   return <hr class="divider" {...props} />;
 * }
 *
 * <Divider id="end" />
 * ```
 */
export interface VoidAttributes extends GlobalAttributes {
  /** Void elements take no children. */
  children?: undefined;
}

// ── per element ──

/**
 * Attributes for `<a>`. A boosted link (inside `data-yx-boost`) with a
 * `target`, `download` or `rel="external"` is left to the browser.
 *
 * ```tsx
 * <a href="/report.csv" download="report.csv">Download</a>
 *
 * function ExternalLink(props: AnchorAttributes) {
 *   return <a target="_blank" rel="noopener noreferrer" {...props} />;
 * }
 *
 * <ExternalLink href="https://example.com/docs">Docs</ExternalLink>
 * ```
 */
export interface AnchorAttributes extends GlobalAttributes {
  href?: string;
  target?: HTMLAttributeAnchorTarget;
  download?: boolean | string;
  rel?: string;
  hreflang?: string;
  type?: string;
  ping?: string;
  referrerpolicy?: HTMLAttributeReferrerPolicy;
}

export interface AreaAttributes extends VoidAttributes {
  alt?: string;
  coords?: string;
  shape?: "rect" | "circle" | "poly" | "default";
  href?: string;
  target?: HTMLAttributeAnchorTarget;
  download?: boolean | string;
  rel?: string;
  ping?: string;
  referrerpolicy?: HTMLAttributeReferrerPolicy;
}

export interface MediaAttributes extends GlobalAttributes {
  src?: string;
  autoplay?: boolean;
  controls?: boolean;
  controlslist?: string;
  crossorigin?: CrossOrigin;
  loop?: boolean;
  muted?: boolean;
  preload?: "" | "none" | "metadata" | "auto";
  disableremoteplayback?: boolean;
}

export interface AudioAttributes extends MediaAttributes {}

export interface VideoAttributes extends MediaAttributes {
  width?: Numberish;
  height?: Numberish;
  poster?: string;
  playsinline?: boolean;
  disablepictureinpicture?: boolean;
}

export interface BaseAttributes extends VoidAttributes {
  href?: string;
  target?: HTMLAttributeAnchorTarget;
}

export interface QuoteAttributes extends GlobalAttributes {
  cite?: string;
}

export interface ModAttributes extends GlobalAttributes {
  cite?: string;
  datetime?: string;
}

/** Shared by `<button>` and `<input>`: the form-overriding submit attributes. */
interface FormSubmitterAttributes {
  /** A URL, or a yerd action (`this.save`, `bind(this.remove, { id })`). */
  formaction?: FormActionValue;
  formenctype?: FormEnctype;
  formmethod?: FormMethod;
  formnovalidate?: boolean;
  formtarget?: HTMLAttributeAnchorTarget;
  popovertarget?: string;
  popovertargetaction?: PopoverTargetAction;
}

/**
 * Attributes for `<button>`. `formaction` may be a yerd action, like a form's
 * `action`: that button posts to its own action ("Save" and "Delete" in one
 * form). Such a button can't have its own `name` or `value`.
 *
 * ```tsx
 * <form action={this.save}>
 *   <input name="title" />
 *   <button>Save</button>
 *   <button formaction={() => this.remove({ id: note.id })}>Delete</button>
 * </form>
 *
 * function Button({ variant = "primary", ...rest }: ButtonAttributes & { variant?: "primary" | "ghost" }) {
 *   return <button {...rest} class={["btn", `btn-${variant}`]} />;
 * }
 *
 * <Button type="submit">Save</Button>
 * ```
 */
export interface ButtonAttributes extends GlobalAttributes, FormSubmitterAttributes {
  type?: "submit" | "reset" | "button";
  name?: string;
  value?: Numberish;
  disabled?: boolean;
  form?: string;
  command?: Open<"show-modal" | "close" | "request-close" | "show-popover" | "hide-popover" | "toggle-popover">;
  commandfor?: string;
}

export interface CanvasAttributes extends GlobalAttributes {
  width?: Numberish;
  height?: Numberish;
}

export interface ColAttributes extends VoidAttributes {
  span?: Numberish;
}

export interface ColgroupAttributes extends GlobalAttributes {
  span?: Numberish;
}

export interface DataAttributes extends GlobalAttributes {
  value?: Numberish;
}

export interface DetailsAttributes extends GlobalAttributes {
  open?: boolean;
  name?: string;
}

export interface DialogAttributes extends GlobalAttributes {
  open?: boolean;
  closedby?: "any" | "closerequest" | "none";
}

export interface EmbedAttributes extends VoidAttributes {
  src?: string;
  type?: string;
  width?: Numberish;
  height?: Numberish;
}

export interface FieldsetAttributes extends GlobalAttributes {
  disabled?: boolean;
  form?: string;
  name?: string;
}

/**
 * Attributes for `<form>`. `action` takes a URL or a yerd action; with an
 * action, `method` is set for you. File forms need `enctype` for the
 * browser's own (no JavaScript) post.
 *
 * ```tsx
 * <form action={this.post} enctype="multipart/form-data">
 *   <input name="title" />
 *   <input type="file" name="photos" multiple accept="image/*" />
 *   <button>Post</button>
 * </form>
 *
 * <form action="/search" method="get" role="search">
 *   <input type="search" name="q" />
 * </form>
 * ```
 */
export interface FormAttributes extends Omit<GlobalAttributes, "action"> {
  /**
   * A URL, or a yerd action. An action renders as a POST to the owning route
   * with a signed token, so `method` is set for you.
   *
   * ```tsx
   * <form action={this.add}>{fields}</form>
   * <form action={() => this.remove({ id })}><button>Delete</button></form>
   * ```
   */
  action?: FormActionValue;
  method?: FormMethod;
  enctype?: FormEnctype;
  "accept-charset"?: string;
  autocomplete?: "on" | "off";
  name?: string;
  novalidate?: boolean;
  target?: HTMLAttributeAnchorTarget;
  rel?: string;
}

export interface HtmlAttributes extends GlobalAttributes {
  xmlns?: string;
  manifest?: string;
}

export interface IframeAttributes extends GlobalAttributes {
  src?: string;
  srcdoc?: string;
  name?: string;
  sandbox?: string;
  allow?: string;
  allowfullscreen?: boolean;
  width?: Numberish;
  height?: Numberish;
  loading?: "eager" | "lazy";
  referrerpolicy?: HTMLAttributeReferrerPolicy;
  credentialless?: boolean;
}

/**
 * Attributes for `<img>`, with the browser's loading hints typed (`loading`,
 * `decoding`, `fetchpriority`, `srcset` / `sizes`). Give images a `width` and
 * `height` so the page doesn't jump as they load.
 *
 * ```tsx
 * <img src={p.photo} alt={p.name} width={320} height={240} loading="lazy" decoding="async"
 *   srcset={`${p.photo}?w=320 320w, ${p.photo}?w=640 640w`} sizes="(max-width: 600px) 50vw, 320px" />
 *
 * function Avatar({ size = 40, ...rest }: ImgAttributes & { size?: number }) {
 *   return <img width={size} height={size} loading="lazy" alt="" {...rest} />;
 * }
 * ```
 */
export interface ImgAttributes extends VoidAttributes {
  src?: string;
  alt?: string;
  srcset?: string;
  sizes?: string;
  width?: Numberish;
  height?: Numberish;
  loading?: "eager" | "lazy";
  decoding?: "sync" | "async" | "auto";
  crossorigin?: CrossOrigin;
  referrerpolicy?: HTMLAttributeReferrerPolicy;
  usemap?: string;
  ismap?: boolean;
  fetchpriority?: FetchPriority;
}

/**
 * Attributes for `<input>`. Names are the HTML ones (`maxlength`,
 * `autocomplete`, `readonly`), and `type` and `autocomplete` suggest their
 * known values.
 *
 * ```tsx
 * <input id="email" type="email" name="email" maxlength={120} required autocomplete="email" />
 *
 * function TextInput({ label, ...input }: InputAttributes & { label: string }) {
 *   return <label>{label} <input type="text" {...input} /></label>;
 * }
 *
 * <TextInput label="Name" name="name" required />
 * ```
 */
export interface InputAttributes extends VoidAttributes, FormSubmitterAttributes {
  type?: InputType;
  name?: string;
  value?: Numberish;
  checked?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  required?: boolean;
  multiple?: boolean;
  form?: string;
  placeholder?: string;
  autocomplete?: AutoFill;
  accept?: string;
  alt?: string;
  capture?: boolean | "user" | "environment";
  dirname?: string;
  list?: string;
  max?: Numberish;
  min?: Numberish;
  step?: Numberish;
  maxlength?: Numberish;
  minlength?: Numberish;
  pattern?: string;
  size?: Numberish;
  src?: string;
  width?: Numberish;
  height?: Numberish;
}

/**
 * Attributes for `<label>`. It's `for`, the HTML name (not React's `htmlFor`).
 *
 * ```tsx
 * <label for="email">Email</label>
 * <input id="email" name="email" />
 * ```
 */
export interface LabelAttributes extends GlobalAttributes {
  for?: string;
}

export interface LiAttributes extends GlobalAttributes {
  value?: Numberish;
}

/**
 * Attributes for `<link>`. For your own stylesheets and icons, assetUrl()
 * and `<Stylesheet>` give the right URL in dev and production.
 *
 * ```tsx
 * <head>
 *   <link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin />
 *   <link rel="icon" href={assetUrl("src/favicon.svg")} type="image/svg+xml" />
 * </head>
 * ```
 */
export interface LinkAttributes extends VoidAttributes {
  href?: string;
  rel?: string;
  as?: Open<
    | "audio"
    | "document"
    | "embed"
    | "fetch"
    | "font"
    | "image"
    | "object"
    | "script"
    | "style"
    | "track"
    | "video"
    | "worker"
  >;
  crossorigin?: CrossOrigin;
  media?: string;
  hreflang?: string;
  type?: string;
  sizes?: string;
  imagesrcset?: string;
  imagesizes?: string;
  integrity?: string;
  referrerpolicy?: HTMLAttributeReferrerPolicy;
  fetchpriority?: FetchPriority;
  disabled?: boolean;
  blocking?: string;
  color?: string;
}

export interface MapAttributes extends GlobalAttributes {
  name?: string;
}

/**
 * Attributes for `<meta>`. Open Graph's `property` comes from the RDFa
 * attributes on GlobalAttributes.
 *
 * ```tsx
 * <head>
 *   <meta charset="utf-8" />
 *   <meta name="viewport" content="width=device-width, initial-scale=1" />
 *   <meta property="og:title" content={meta.title ?? "My app"} />
 * </head>
 * ```
 */
export interface MetaAttributes extends VoidAttributes {
  name?: string;
  content?: string;
  charset?: string;
  "http-equiv"?: Open<"content-security-policy" | "content-type" | "default-style" | "refresh" | "x-ua-compatible">;
  media?: string;
}

export interface MeterAttributes extends GlobalAttributes {
  value?: Numberish;
  min?: Numberish;
  max?: Numberish;
  low?: Numberish;
  high?: Numberish;
  optimum?: Numberish;
}

export interface ObjectAttributes extends GlobalAttributes {
  data?: string;
  type?: string;
  name?: string;
  form?: string;
  width?: Numberish;
  height?: Numberish;
}

export interface OlAttributes extends GlobalAttributes {
  reversed?: boolean;
  start?: Numberish;
  type?: "1" | "a" | "A" | "i" | "I";
}

export interface OptgroupAttributes extends GlobalAttributes {
  disabled?: boolean;
  label?: string;
}

/**
 * Attributes for `<option>`.
 *
 * ```tsx
 * <select name="plan">
 *   <option value="free" selected={plan === "free"}>Free</option>
 *   <option value="pro" disabled label="Pro (soon)" />
 * </select>
 * ```
 */
export interface OptionAttributes extends GlobalAttributes {
  disabled?: boolean;
  label?: string;
  selected?: boolean;
  value?: Numberish;
}

export interface OutputAttributes extends GlobalAttributes {
  for?: string;
  form?: string;
  name?: string;
}

export interface ProgressAttributes extends GlobalAttributes {
  value?: Numberish;
  max?: Numberish;
}

/**
 * Attributes for `<script>`. Its contents are raw text; hand data to an
 * inline script with json(), which can't close the tag.
 *
 * ```tsx
 * <script type="module" src="/app.js" />
 * <script type="application/json" id="state">{json({ user: "ada" })}</script>
 * ```
 */
export interface ScriptAttributes extends GlobalAttributes {
  src?: string;
  type?: Open<"module" | "importmap" | "speculationrules" | "text/javascript" | "application/json" | "application/ld+json">;
  async?: boolean;
  defer?: boolean;
  crossorigin?: CrossOrigin;
  integrity?: string;
  nomodule?: boolean;
  referrerpolicy?: HTMLAttributeReferrerPolicy;
  blocking?: string;
  fetchpriority?: FetchPriority;
}

/**
 * Attributes for `<select>`. With `multiple`, read the choices in an action
 * with `form.all(name)`.
 *
 * ```tsx
 * function Select({ options, ...rest }: SelectAttributes & { options: { value: string; label: string }[] }) {
 *   return <select {...rest}>{options.map((o) => <option value={o.value}>{o.label}</option>)}</select>;
 * }
 *
 * <Select name="size" required options={[{ value: "s", label: "Small" }, { value: "m", label: "Medium" }]} />
 * ```
 */
export interface SelectAttributes extends GlobalAttributes {
  autocomplete?: AutoFill;
  disabled?: boolean;
  form?: string;
  multiple?: boolean;
  name?: string;
  required?: boolean;
  size?: Numberish;
}

export interface SlotAttributes extends GlobalAttributes {
  name?: string;
}

export interface SourceAttributes extends VoidAttributes {
  src?: string;
  srcset?: string;
  sizes?: string;
  type?: string;
  media?: string;
  width?: Numberish;
  height?: Numberish;
}

export interface StyleAttributes extends GlobalAttributes {
  media?: string;
  blocking?: string;
}

export interface TableCellAttributes extends GlobalAttributes {
  colspan?: Numberish;
  rowspan?: Numberish;
  headers?: string;
}

export interface ThAttributes extends TableCellAttributes {
  scope?: "row" | "col" | "rowgroup" | "colgroup";
  abbr?: string;
}

export interface TemplateAttributes extends GlobalAttributes {
  shadowrootmode?: "open" | "closed";
  shadowrootdelegatesfocus?: boolean;
  shadowrootclonable?: boolean;
  shadowrootserializable?: boolean;
}

/**
 * Attributes for `<textarea>`. Its value is its children, not a `value` attribute.
 *
 * ```tsx
 * <textarea name="note" rows={4} maxlength={500} placeholder="Say something" required>{note.body}</textarea>
 * ```
 */
export interface TextareaAttributes extends GlobalAttributes {
  autocomplete?: AutoFill;
  cols?: Numberish;
  rows?: Numberish;
  dirname?: string;
  disabled?: boolean;
  form?: string;
  maxlength?: Numberish;
  minlength?: Numberish;
  name?: string;
  placeholder?: string;
  readonly?: boolean;
  required?: boolean;
  wrap?: "hard" | "soft" | "off";
}

export interface TimeAttributes extends GlobalAttributes {
  datetime?: string;
}

export interface TrackAttributes extends VoidAttributes {
  default?: boolean;
  kind?: "subtitles" | "captions" | "descriptions" | "chapters" | "metadata";
  label?: string;
  src?: string;
  srclang?: string;
}

/**
 * HTML elements, keyed by tag name. Index it to get one element's attribute
 * type without knowing its interface name:
 *
 * ```tsx
 * function Video(props: HTMLElements["video"]) {
 *   return <video controls playsinline preload="metadata" {...props} />;
 * }
 *
 * <Video src="/intro.mp4" poster="/intro.jpg" width={640} />
 * ```
 */
export interface HTMLElements {
  a: AnchorAttributes;
  abbr: GlobalAttributes;
  address: GlobalAttributes;
  area: AreaAttributes;
  article: GlobalAttributes;
  aside: GlobalAttributes;
  audio: AudioAttributes;
  b: GlobalAttributes;
  base: BaseAttributes;
  bdi: GlobalAttributes;
  bdo: GlobalAttributes;
  blockquote: QuoteAttributes;
  body: GlobalAttributes;
  br: VoidAttributes;
  button: ButtonAttributes;
  canvas: CanvasAttributes;
  caption: GlobalAttributes;
  cite: GlobalAttributes;
  code: GlobalAttributes;
  col: ColAttributes;
  colgroup: ColgroupAttributes;
  data: DataAttributes;
  datalist: GlobalAttributes;
  dd: GlobalAttributes;
  del: ModAttributes;
  details: DetailsAttributes;
  dfn: GlobalAttributes;
  dialog: DialogAttributes;
  div: GlobalAttributes;
  dl: GlobalAttributes;
  dt: GlobalAttributes;
  em: GlobalAttributes;
  embed: EmbedAttributes;
  fieldset: FieldsetAttributes;
  figcaption: GlobalAttributes;
  figure: GlobalAttributes;
  footer: GlobalAttributes;
  form: FormAttributes;
  h1: GlobalAttributes;
  h2: GlobalAttributes;
  h3: GlobalAttributes;
  h4: GlobalAttributes;
  h5: GlobalAttributes;
  h6: GlobalAttributes;
  head: GlobalAttributes;
  header: GlobalAttributes;
  hgroup: GlobalAttributes;
  hr: VoidAttributes;
  html: HtmlAttributes;
  i: GlobalAttributes;
  iframe: IframeAttributes;
  img: ImgAttributes;
  input: InputAttributes;
  ins: ModAttributes;
  kbd: GlobalAttributes;
  label: LabelAttributes;
  legend: GlobalAttributes;
  li: LiAttributes;
  link: LinkAttributes;
  main: GlobalAttributes;
  map: MapAttributes;
  mark: GlobalAttributes;
  menu: GlobalAttributes;
  meta: MetaAttributes;
  meter: MeterAttributes;
  nav: GlobalAttributes;
  noscript: GlobalAttributes;
  object: ObjectAttributes;
  ol: OlAttributes;
  optgroup: OptgroupAttributes;
  option: OptionAttributes;
  output: OutputAttributes;
  p: GlobalAttributes;
  picture: GlobalAttributes;
  pre: GlobalAttributes;
  progress: ProgressAttributes;
  q: QuoteAttributes;
  rp: GlobalAttributes;
  rt: GlobalAttributes;
  ruby: GlobalAttributes;
  s: GlobalAttributes;
  samp: GlobalAttributes;
  script: ScriptAttributes;
  search: GlobalAttributes;
  section: GlobalAttributes;
  select: SelectAttributes;
  slot: SlotAttributes;
  small: GlobalAttributes;
  source: SourceAttributes;
  span: GlobalAttributes;
  strong: GlobalAttributes;
  style: StyleAttributes;
  sub: GlobalAttributes;
  summary: GlobalAttributes;
  sup: GlobalAttributes;
  table: GlobalAttributes;
  tbody: GlobalAttributes;
  td: TableCellAttributes;
  template: TemplateAttributes;
  textarea: TextareaAttributes;
  tfoot: GlobalAttributes;
  th: ThAttributes;
  thead: GlobalAttributes;
  time: TimeAttributes;
  /** Also SVG's `<title>`, which takes the same attributes. */
  title: GlobalAttributes;
  tr: GlobalAttributes;
  track: TrackAttributes;
  u: GlobalAttributes;
  ul: GlobalAttributes;
  var: GlobalAttributes;
  video: VideoAttributes;
  wbr: VoidAttributes;
}

// ── SVG ──

type SVGUnits = "userSpaceOnUse" | "objectBoundingBox";

/**
 * Attributes common to SVG elements. The usual presentation attributes are
 * declared; the long tail of kebab-case ones (`stroke-width`, `stop-color`,
 * `font-family`, ...) goes through the index signature.
 *
 * ```tsx
 * function Icon({ d, ...rest }: SVGAttributes & { d: string }) {
 *   return (
 *     <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" stroke-width="2" {...rest}>
 *       <path d={d} />
 *     </svg>
 *   );
 * }
 *
 * <Icon d="M3 6h18" aria-hidden="true" />
 * ```
 */
export interface SVGAttributes extends GlobalAttributes {
  xmlns?: string;
  "xmlns:xlink"?: string;
  "xlink:href"?: string;
  "xml:space"?: string;
  viewBox?: string;
  preserveAspectRatio?: string;
  transform?: string;
  x?: Numberish;
  y?: Numberish;
  width?: Numberish;
  height?: Numberish;
  fill?: string;
  stroke?: string;
  opacity?: Numberish;
  color?: string;
  cursor?: string;
  display?: string;
  visibility?: string;
  overflow?: string;
  filter?: string;
  mask?: string;
  clip?: string;
  direction?: string;
  pathLength?: Numberish;
  systemLanguage?: string;
  requiredExtensions?: string;
  // `object` too: a dashed custom attribute (CustomAttributes) may take one.
  [presentation: `${string}-${string}`]: string | number | boolean | object | null | undefined;
}

export interface SVGSvgAttributes extends SVGAttributes {
  version?: string;
}

export interface SVGPathAttributes extends SVGAttributes {
  d?: string;
}

export interface SVGCircleAttributes extends SVGAttributes {
  cx?: Numberish;
  cy?: Numberish;
  r?: Numberish;
}

export interface SVGEllipseAttributes extends SVGAttributes {
  cx?: Numberish;
  cy?: Numberish;
  rx?: Numberish;
  ry?: Numberish;
}

export interface SVGLineAttributes extends SVGAttributes {
  x1?: Numberish;
  y1?: Numberish;
  x2?: Numberish;
  y2?: Numberish;
}

export interface SVGPolyAttributes extends SVGAttributes {
  points?: string;
}

export interface SVGRectAttributes extends SVGAttributes {
  rx?: Numberish;
  ry?: Numberish;
}

export interface SVGTextAttributes extends SVGAttributes {
  dx?: Numberish;
  dy?: Numberish;
  rotate?: Numberish;
  textLength?: Numberish;
  lengthAdjust?: "spacing" | "spacingAndGlyphs";
}

export interface SVGUseAttributes extends SVGAttributes {
  href?: string;
}

export interface SVGSymbolAttributes extends SVGAttributes {
  refX?: Numberish;
  refY?: Numberish;
}

export interface SVGMarkerAttributes extends SVGSymbolAttributes {
  markerUnits?: "userSpaceOnUse" | "strokeWidth";
  markerWidth?: Numberish;
  markerHeight?: Numberish;
  orient?: Numberish;
}

export interface SVGClipPathAttributes extends SVGAttributes {
  clipPathUnits?: SVGUnits;
}

export interface SVGMaskAttributes extends SVGAttributes {
  maskUnits?: SVGUnits;
  maskContentUnits?: SVGUnits;
}

interface SVGGradientAttributes extends SVGAttributes {
  href?: string;
  gradientUnits?: SVGUnits;
  gradientTransform?: string;
  spreadMethod?: "pad" | "reflect" | "repeat";
}

export interface SVGLinearGradientAttributes extends SVGGradientAttributes {
  x1?: Numberish;
  y1?: Numberish;
  x2?: Numberish;
  y2?: Numberish;
}

export interface SVGRadialGradientAttributes extends SVGGradientAttributes {
  cx?: Numberish;
  cy?: Numberish;
  r?: Numberish;
  fx?: Numberish;
  fy?: Numberish;
  fr?: Numberish;
}

export interface SVGStopAttributes extends SVGAttributes {
  offset?: Numberish;
}

export interface SVGPatternAttributes extends SVGAttributes {
  href?: string;
  patternUnits?: SVGUnits;
  patternContentUnits?: SVGUnits;
  patternTransform?: string;
}

export interface SVGImageAttributes extends SVGAttributes {
  href?: string;
  crossorigin?: CrossOrigin;
  decoding?: "sync" | "async" | "auto";
}

export interface SVGFilterAttributes extends SVGAttributes {
  filterUnits?: SVGUnits;
  primitiveUnits?: SVGUnits;
}

/**
 * SVG elements, keyed by tag name. `<title>` is shared with HTML. Attribute
 * names keep SVG's own casing (`viewBox`, `gradientUnits`, `stdDeviation`).
 *
 * ```tsx
 * <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width={100} height={100}>
 *   <defs>
 *     <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
 *       <stop offset="0" stop-color="#4f46e5" />
 *       <stop offset="1" stop-color="#4f46e5" stop-opacity="0" />
 *     </linearGradient>
 *   </defs>
 *   <circle cx={50} cy={50} r={40} fill="url(#fade)" />
 * </svg>
 * ```
 */
export interface SVGElements {
  svg: SVGSvgAttributes;
  g: SVGAttributes;
  path: SVGPathAttributes;
  circle: SVGCircleAttributes;
  ellipse: SVGEllipseAttributes;
  line: SVGLineAttributes;
  polyline: SVGPolyAttributes;
  polygon: SVGPolyAttributes;
  rect: SVGRectAttributes;
  text: SVGTextAttributes;
  tspan: SVGTextAttributes;
  textPath: SVGTextAttributes & { href?: string; startOffset?: Numberish };
  defs: SVGAttributes;
  desc: SVGAttributes;
  use: SVGUseAttributes;
  symbol: SVGSymbolAttributes;
  marker: SVGMarkerAttributes;
  clipPath: SVGClipPathAttributes;
  mask: SVGMaskAttributes;
  linearGradient: SVGLinearGradientAttributes;
  radialGradient: SVGRadialGradientAttributes;
  stop: SVGStopAttributes;
  pattern: SVGPatternAttributes;
  image: SVGImageAttributes;
  filter: SVGFilterAttributes;
  foreignObject: SVGAttributes;
}

// ── custom elements ──

/**
 * A custom element (any tag with a hyphen) takes global attributes plus
 * anything else. To type one strictly, augment `JSX.IntrinsicElements`.
 *
 * ```tsx
 * <my-widget size="large" any-prop="ok" class="widget" />
 * ```
 */
export type CustomElementAttributes = GlobalAttributes & Record<string, unknown>;

/**
 * Every attribute also takes `null`, which (like `undefined`) renders nothing.
 * IntrinsicElements applies it to every tag, so a conditional attribute can
 * be written with `null`:
 *
 * ```tsx
 * <a href={user ? `/u/${user.name}` : null}>Profile</a>
 *
 * const link: Nullable<AnchorAttributes> = { href: null, target: "_blank" };
 * ```
 */
export type Nullable<T> = { [K in keyof T]: K extends "children" | "key" ? T[K] : T[K] | null };
type NullableElements<E> = { [Tag in keyof E]: Nullable<E[Tag]> };

/**
 * Every intrinsic element yerd knows about. `JSX.IntrinsicElements` extends
 * this, so apps can add their own tags by augmenting `JSX.IntrinsicElements`
 * in "@toyz/yerd/jsx-runtime". Index it for one tag's props as TSX sees
 * them (with `null` allowed):
 *
 * ```tsx
 * type InputProps = IntrinsicElements["input"];
 *
 * function Checkbox(props: InputProps) {
 *   return <input type="checkbox" {...props} />;
 * }
 * ```
 */
export interface IntrinsicElements extends NullableElements<HTMLElements>, NullableElements<SVGElements> {
  [tag: `${string}-${string}`]: CustomElementAttributes;
}
