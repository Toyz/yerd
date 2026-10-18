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
 * don't render yet: they become client sprinkles later.
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
 * and `""` drop the declaration.
 */
export interface CSSProperties {
  [property: string]: string | number | null | undefined | false;
}

/**
 * An event handler. Handlers render nothing today (they're dropped on the
 * server) and become client sprinkles later. A string is an inline handler and
 * does render. Declared method-style so a handler taking a narrower event, like
 * `(e: MouseEvent) => void`, is accepted.
 */
export type EventHandler = { bivarianceHack(event: Event): unknown }["bivarianceHack"] | string;

/**
 * A yerd action: a lambda calling one @action method (`() => this.remove({ id })`),
 * an action that takes no arguments (`this.add`), or bind(...) of one.
 */
export type ActionValue = ActionLambda | BoundAction<any>;

/** Things yerd can turn into a form submission target: a URL or an action. */
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

/** Values for `<input type>`; any other string is allowed too. */
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
 */
export interface CustomAttributes {
  /** Warm the link's page (or `{ url }`) before it's needed. See PrefetchValue. */
  prefetch?: PrefetchValue;
}

/** Attributes every HTML element accepts. */
export interface GlobalAttributes extends CustomAttributes {
  children?: Child;
  /**
   * A yerd action this element runs when `trigger` fires (default: click),
   * with the client runtime: `<button action={() => this.remove({ id })}>`,
   * `<input action={({ el }) => this.search({ q: el.value })} trigger="input 250ms">`.
   * Use a form when it must work without JavaScript.
   */
  action?: ActionValue;
  /** When `action` fires. See ActionTrigger. */
  trigger?: ActionTrigger;
  /** For `trigger="drop:files"`: which files it takes, like an input's (`"image/*,.pdf"`). */
  accept?: string;
  /**
   * Make this element a drop zone for a file input elsewhere in the form
   * (a CSS selector, `"#photos"`): files dropped on it are added to that
   * input, filtered by its `accept` (and kept to one unless it's `multiple`),
   * and go up with the form when it's submitted. The input still works on
   * its own, with or without JavaScript. While files are staged the zone has
   * `data-yx-files="<count>"`.
   */
  dropTo?: string;
  /** Not an attribute: the JSX key. On an element it renders as `data-key`. */
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
  /** Event handlers: they compile, but don't render yet (future client sprinkles). */
  [handler: `on${string}`]: EventHandler | undefined;
}

/** For elements that can't have children (`<br>`, `<img>`, `<input>`, ...). */
export interface VoidAttributes extends GlobalAttributes {
  /** Void elements take no children. */
  children?: undefined;
}

// ── per element ──

/** Attributes for `<a>`. */
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

/** Attributes for `<button>`. `formaction` may be a yerd action, like a form's `action`. */
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

/** Attributes for `<form>`. */
export interface FormAttributes extends Omit<GlobalAttributes, "action"> {
  /**
   * A URL, or a yerd action. An action renders as a POST to the owning route
   * with a signed token, so `method` is set for you.
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

/** Attributes for `<img>`. */
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

/** Attributes for `<input>`. */
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

/** Attributes for `<label>`. */
export interface LabelAttributes extends GlobalAttributes {
  for?: string;
}

export interface LiAttributes extends GlobalAttributes {
  value?: Numberish;
}

/** Attributes for `<link>`. */
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

/** Attributes for `<meta>`. */
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

/** Attributes for `<option>`. */
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

/** Attributes for `<script>`. */
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

/** Attributes for `<select>`. */
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

/** Attributes for `<textarea>`. */
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

/** HTML elements, keyed by tag name. */
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

/** SVG elements, keyed by tag name. `<title>` is shared with HTML. */
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

/** A custom element (any tag with a hyphen) takes global attributes plus anything else. */
export type CustomElementAttributes = GlobalAttributes & Record<string, unknown>;

/** Every attribute also takes `null`, which (like `undefined`) renders nothing. */
export type Nullable<T> = { [K in keyof T]: K extends "children" | "key" ? T[K] : T[K] | null };
type NullableElements<E> = { [Tag in keyof E]: Nullable<E[Tag]> };

/**
 * Every intrinsic element yerd knows about. `JSX.IntrinsicElements` extends
 * this, so apps can add their own tags by augmenting `JSX.IntrinsicElements`
 * in "@toyz/yerd/jsx-runtime".
 */
export interface IntrinsicElements extends NullableElements<HTMLElements>, NullableElements<SVGElements> {
  [tag: `${string}-${string}`]: CustomElementAttributes;
}
