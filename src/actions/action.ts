/**
 * Actions: route methods that forms call.
 *
 * `<form action={this.add}>` renders as a plain POST form, so it works with
 * JavaScript off: the action runs and the browser is redirected back to the
 * page (post/redirect/get). With yerd's client runtime loaded, the same form
 * is submitted with fetch, the action's JSX comes back without layouts, and the
 * `<Region>`s in it are morphed into the page.
 *
 * The form carries a signed `_yx` token naming the route class, the action and
 * any bound arguments. The signature (HMAC-SHA256 with the app secret) means a
 * client can't call other actions or change the arguments. It doesn't mean the
 * user is allowed to act on them: actions still check ownership.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createKey } from "../decorators/keys.js";
import { resolveRoute, routeRegistry, type RouteDef } from "../decorators/route.js";
import { HttpError } from "../respond/response.js";
import { Logger } from "../log/logger.js";
import { currentContext, type YerdContext } from "../server/context.js";
import { withFiles, type FormFields, type FormFiles } from "../server/body.js";
import { parse, type DtoClass } from "../decorators/dto.js";

/**
 * The submitted form fields, with typed getters. An @action method gets it as
 * its second parameter, after the bound arguments. `parse()` into a DTO is
 * usually what you want; the getters are for a field or two.
 *
 * ```tsx
 * @route("/notes")
 * export class Notes {
 *   @inject(Db) accessor db!: Db;
 *
 *   @get page() {
 *     return (
 *       <form action={this.add}>
 *         <input name="title" required />
 *         <label><input type="checkbox" name="pinned" /> Pinned</label>
 *         <button>Add</button>
 *       </form>
 *     );
 *   }
 *
 *   @action add(_: {}, form: ActionForm) {
 *     this.db.notes.add({ title: form.string("title"), pinned: form.has("pinned") });
 *   }
 * }
 * ```
 */
export class ActionForm {
  /**
   * `uploads` holds files from a multipart form (the runtime sends file forms
   * as multipart). yerd builds this for each action; build one yourself to
   * call an action method directly in a unit test.
   *
   * ```ts
   * const form = new ActionForm({ title: "Milk", tag: ["food", "weekly"] });
   * form.string("title"); // "Milk"
   * form.all("tag");      // ["food", "weekly"]
   *
   * const photo = new File(["..."], "cat.jpg", { type: "image/jpeg" });
   * new ActionForm({}, { photo: [photo] }).file("photo"); // photo
   * ```
   */
  constructor(
    readonly fields: FormFields,
    readonly uploads: FormFiles = Object.create(null) as FormFiles,
  ) {}

  /**
   * The first file uploaded under `name` (an empty file input counts as none), or undefined.
   *
   * ```ts
   * @action async avatar(_: {}, form: ActionForm) {
   *   const photo = form.file("photo");
   *   if (photo) await this.store.save(photo.name, await photo.arrayBuffer());
   * }
   * ```
   */
  file(name: string): File | undefined {
    return this.files(name)[0];
  }

  /**
   * Every file uploaded under `name`: a `multiple` file input, a `dropTo`
   * zone, or `"files"` for a `trigger="drop:files"` target. Empty when none.
   *
   * ```ts
   * @action async upload(_: {}, form: ActionForm) {
   *   for (const file of form.files("photos")) await this.store.save(file.name, await file.arrayBuffer());
   * }
   * ```
   */
  files(name: string): File[] {
    return (this.uploads[name] ?? []).filter((f) => f.size > 0 || f.name !== "");
  }

  /**
   * Whether the form sent a field called `name` (even an empty one). Doesn't
   * look at uploads. An unchecked checkbox isn't sent at all, so this is how
   * you read one.
   *
   * ```ts
   * @action toggle({ id }: { id: number }, form: ActionForm) {
   *   this.db.todos.setDone(id, form.has("done"));
   * }
   * ```
   */
  has(name: string): boolean {
    return this.fields[name] !== undefined;
  }

  /**
   * First value of a field, or undefined. For optional fields; use `string()`
   * when the field must be there.
   *
   * ```tsx
   * @action search(_: {}, form: ActionForm) {
   *   const q = form.get("q") ?? "";
   *   return <Region id="results">{q}</Region>;
   * }
   * ```
   */
  get(name: string): string | undefined {
    const value = this.fields[name];
    return Array.isArray(value) ? value[0] : value;
  }

  /**
   * First value of a field; a 400 if it's missing. An empty string counts as
   * sent, so check its length (or `parse()` with a validator) if that matters.
   *
   * ```ts
   * @action rename({ id }: { id: number }, form: ActionForm) {
   *   this.db.notes.rename(id, form.string("title"));
   * }
   * ```
   */
  string(name: string): string {
    const value = this.get(name);
    if (value === undefined) throw new HttpError(400, `Missing form field: ${name}`);
    return value;
  }

  /**
   * Every value of a repeated field (checkboxes sharing a name, a
   * `<select multiple>`), in the order sent. Empty when none.
   *
   * ```ts
   * @action tag({ id }: { id: number }, form: ActionForm) {
   *   this.db.notes.setTags(id, form.all("tag"));
   * }
   * ```
   */
  all(name: string): string[] {
    const value = this.fields[name];
    return value === undefined ? [] : Array.isArray(value) ? value : [value];
  }

  /**
   * Validate the form into a DTO class (400 with every issue on failure,
   * which the runtime shows next to the fields). Uploads join the fields, so
   * the DTO can use `is.file()`; yerd's own `_yx` fields are left out.
   *
   * ```ts
   * class Profile {
   *   @is.string({ transform: trim, validate: length(1, 60) }) name!: string;
   *   @is.file({ types: ["image/*"], maxSize: 2_000_000, optional: true }) avatar?: File;
   * }
   *
   * @action async save(_: {}, form: ActionForm) {
   *   const { name, avatar } = form.parse(Profile);
   *   if (avatar) await this.store.save(`${name}-${avatar.name}`, await avatar.arrayBuffer());
   * }
   * ```
   */
  parse<T>(dto: DtoClass<T>): T {
    // No prototype: a field named "__proto__" is plain data, not a prototype swap.
    // Uploads join the fields, for is.file() / is.files().
    const plain = withFiles(this.fields, this.uploads);
    for (const key of Object.keys(plain)) if (key.startsWith("_yx")) delete plain[key];
    return parse(dto, plain);
  }
}

/**
 * The shape of an action method: bound args first, then the form. The form
 * is optional here so a component can call one in an action lambda
 * (`() => bump({ id })`) without inventing one. Type a component's prop with
 * it to pass an action down, and call it there like the method itself:
 *
 * ```tsx
 * function Item({ item, remove }: { item: { id: number; title: string }; remove: Action<{ id: number }> }) {
 *   return (
 *     <li>
 *       {item.title}
 *       <form action={() => remove({ id: item.id })}>
 *         <button>Delete</button>
 *       </form>
 *     </li>
 *   );
 * }
 *
 * // in the route: <Item item={item} remove={this.remove} />
 * ```
 */
// Method syntax, so an action declared with a required form still fits.
export type Action<A = {}> = { bivarianceHack(args: A, form?: ActionForm): unknown }["bivarianceHack"];

/**
 * An element's live state, read in an action lambda: `el.value` is whatever
 * the input holds when the action fires. Values are filled in by the browser,
 * so pass them straight into the action's arguments (`{ q: el.value }`);
 * computing with them while the page renders (`el.value.trim()`) throws.
 * They arrive typed: booleans for `checked`, `open` and `disabled`, numbers
 * for the numeric fields, strings for the rest.
 *
 * ```tsx
 * <input type="search" action={({ el }) => this.find({ q: el.value })} trigger="input 250ms" />
 * <input type="checkbox" action={({ el }) => this.done({ id, done: el.checked })} trigger="change" />
 * <ul action={({ drag }) => this.move({ id: drag.data("id"), to: "done" })} trigger="drop" />
 * ```
 */
export interface ActionElement {
  /**
   * An input's, select's or textarea's value.
   *
   * ```tsx
   * <input type="search" action={({ el }) => this.find({ q: el.value })} trigger="input 250ms" />
   * ```
   */
  readonly value: string;
  /**
   * `value` as a number (NaN when empty): number, range and date inputs.
   *
   * ```tsx
   * <input type="range" action={({ el }) => this.volume({ level: el.valueAsNumber })} trigger="change" />
   * ```
   */
  readonly valueAsNumber: number;
  /**
   * A checkbox or radio's state.
   *
   * ```tsx
   * <input type="checkbox" action={({ el }) => this.done({ id, done: el.checked })} trigger="change" />
   * ```
   */
  readonly checked: boolean;
  /**
   * A select's selected option index (-1 when none).
   *
   * ```tsx
   * <select action={({ el }) => this.pick({ index: el.selectedIndex })} trigger="change">{options}</select>
   * ```
   */
  readonly selectedIndex: number;
  /**
   * A `<details>` or `<dialog>` is open.
   *
   * ```tsx
   * <details action={({ el }) => this.remember({ open: el.open })} trigger="toggle">{body}</details>
   * ```
   */
  readonly open: boolean;
  readonly disabled: boolean;
  readonly textContent: string;
  readonly id: string;
  readonly name: string;
  /**
   * How far the element is scrolled.
   *
   * ```tsx
   * <div action={({ el }) => this.scrolled({ top: el.scrollTop })} trigger="scrollend">{log}</div>
   * ```
   */
  readonly scrollTop: number;
  readonly scrollLeft: number;
  /**
   * `data-*` attributes ("" when missing). Under `noUncheckedIndexedAccess`
   * each one is typed `string | undefined`; `data(name)` avoids that.
   *
   * ```tsx
   * <ul action={({ drag }) => this.move({ id: drag.dataset.id ?? "", to: "done" })} trigger="drop" />
   * ```
   */
  readonly dataset: Readonly<Record<string, string>>;
  /**
   * One `data-*` attribute by its dataset name ("" when missing): the same as
   * `dataset[name]`, but always a string, even under `noUncheckedIndexedAccess`.
   * `drag.data("id")` reads `data-id`.
   *
   * ```tsx
   * <li key={card.id} data-id={card.id} draggable="true">{card.title}</li>
   * <ul action={({ drag }) => this.move({ id: drag.data("id"), to: "done" })} trigger="drop" />
   * ```
   */
  data(name: string): string;
}

/**
 * What an action lambda gets. Use what you need: `({ el }) => ...`, `({ ctx }) => ...`.
 * `el`, `ref()` and `drag` are read in the browser when the action fires;
 * `ctx` is read now, on the server, while the page renders.
 *
 * ```tsx
 * <input action={({ el }) => this.search({ q: el.value })} trigger="input 250ms" />
 * <button action={({ ref }) => this.search({ q: ref("#q").value })}>Search</button>
 * <div action={({ ctx }) => this.more({ page: Number(ctx.query.get("page") ?? 1) + 1 })} trigger="visible" />
 * <form action={({ form }) => this.rename({ id }, form)}><input name="title" /></form>
 * ```
 */
export interface ActionScope {
  /**
   * The element the action is on (the form, for a form's action), as it is when the action fires.
   *
   * ```tsx
   * <input type="checkbox" action={({ el }) => this.done({ id, done: el.checked })} trigger="change" />
   * ```
   */
  readonly el: ActionElement;
  /**
   * Another element on the page, by CSS selector, as it is when the action fires: `ref("#sort").value`.
   *
   * ```tsx
   * <input id="q" type="search" />
   * <button action={({ ref }) => this.search({ q: ref("#q").value })}>Search</button>
   * ```
   */
  ref(selector: string): ActionElement;
  /**
   * For `trigger="drop"`: the element that was dropped (the `draggable`
   * element being dragged), as it is when it lands: `drag.dataset.id`.
   *
   * ```tsx
   * <ul action={({ drag }) => this.move({ id: drag.data("id"), to: "done" })} trigger="drop" />
   * ```
   */
  readonly drag: ActionElement;
  /**
   * The request rendering this page (params, query, session...). Read now, not when the action fires.
   *
   * ```tsx
   * <div action={({ ctx }) => this.more({ page: Number(ctx.query.get("page") ?? 1) + 1 })} trigger="visible" />
   * ```
   */
  readonly ctx: YerdContext;
  /**
   * A stand-in form for actions that take one: `({ form }) => this.rename({ id }, form)`.
   * The action gets the real submitted form when it runs.
   *
   * ```tsx
   * <form action={({ form }) => this.rename({ id }, form)}>
   *   <input name="title" />
   * </form>
   * ```
   */
  readonly form: ActionForm;
}

/**
 * What `action={...}` takes: a lambda that calls one @action method with its
 * arguments, `() => this.remove({ id })`. It runs while the page renders, but
 * the action doesn't: yerd records which action was called with what and
 * signs that into the element, with `el` / `ref()` values left for the
 * browser to fill in when it fires. An action that takes no arguments can be
 * passed as is: `action={this.add}`.
 *
 * You write these inline; the type is for a component that takes one ready
 * made from its caller:
 *
 * ```tsx
 * function Confirm({ label, run }: { label: string; run: ActionLambda }) {
 *   return (
 *     <form action={run} data-yx-confirm={`${label}?`}>
 *       <button>{label}</button>
 *     </form>
 *   );
 * }
 *
 * // in the route: <Confirm label="Delete" run={() => this.remove({ id })} />
 * ```
 */
export type ActionLambda = (scope: ActionScope, form: ActionForm) => unknown;

interface ActionInfo {
  name: string;
  metadata: DecoratorMetadataObject;
}

export const ACTIONS = createKey<Set<string>>("actions");
const actionFunctions = new WeakMap<Function, ActionInfo>();

const BOUND: unique symbol = Symbol.for("yerd.bound-action");

/**
 * An action with its arguments attached, from bind(). Pass it as a form's
 * `action`, a button's `formaction`, or any element's `action`. Type a prop
 * with it when a component should get the action already bound:
 *
 * ```tsx
 * function ArchiveButton({ archive }: { archive: BoundAction<{ id: number }> }) {
 *   return <form action={archive}><button>Archive</button></form>;
 * }
 *
 * // in the route: <ArchiveButton archive={bind(this.archive, { id: message.id })} />
 * ```
 */
export interface BoundAction<A = unknown> {
  /** Brand that marks a bind() result. */
  readonly [BOUND]: true;
  /** The @action method. */
  readonly fn: Action<A>;
  /** The arguments signed into the form's token and passed as the action's first parameter. */
  readonly args: A;
  /** Values the browser fills in when the action fires (from an action lambda's `el` / `ref()`). */
  readonly holes?: HoleSource[];
}

/**
 * Set while an action lambda runs at render time: action calls are recorded,
 * not run. Async context, not a flag, so an async lambda's code after an
 * await (which runs once the capture is over) still can't run the action.
 */
const capturing = new AsyncLocalStorage<{ fn?: Function; args?: unknown; calls: number; done: boolean }>();

/**
 * Mark a route method as an action. Its first parameter is the arguments the
 * page passed (`action={() => this.remove({ id })}`), the second the
 * submitted form.
 *
 * ```tsx
 * @route("/todos")
 * export class Todos {
 *   @inject(TodoList) accessor todos!: TodoList;
 *
 *   @get page() {
 *     return (
 *       <Region id="todos">
 *         <form action={this.add}><input name="title" /><button>Add</button></form>
 *         {this.todos.all().map((t) => <button action={() => this.remove({ id: t.id })}>{t.title}</button>)}
 *       </Region>
 *     );
 *   }
 *
 *   @action add(_: {}, form: ActionForm) {
 *     this.todos.add(form.string("title"));
 *   }
 *
 *   @action remove({ id }: { id: string }) {
 *     this.todos.remove(id);
 *   }
 * }
 * ```
 */
export function action<M extends Action<any>>(method: M, context: ClassMethodDecoratorContext): M {
  if (context.static || context.private || typeof context.name !== "string") {
    throw new TypeError(`@action must decorate a public, string-named instance method (got ${String(context.name)})`);
  }
  const set = ACTIONS.hasOwn(context.metadata) ? ACTIONS.from(context.metadata)! : new Set(ACTIONS.from(context.metadata));
  set.add(context.name);
  ACTIONS.set(context.metadata, set);
  const info = { name: context.name, metadata: context.metadata };
  // Called inside an action lambda while the page renders, the action only
  // says who it is and what it was given; otherwise it runs.
  const wrapped = function (this: unknown, args: unknown, form?: ActionForm): unknown {
    const box = capturing.getStore();
    if (box) {
      if (box.done) return undefined;
      box.calls++;
      box.fn = wrapped;
      box.args = args;
      return undefined;
    }
    return method.call(this, args, form);
  };
  Object.defineProperty(wrapped, "name", { value: method.name });
  actionFunctions.set(method, info);
  actionFunctions.set(wrapped, info);
  return wrapped as unknown as M;
}

/** Stand-in form for action lambdas; the action never sees it. */
const STAND_IN = new ActionForm(Object.create(null) as FormFields);

/** Where a hole's value comes from: ["el", ...path], ["drag", ...path] or ["ref", selector, ...path]. */
export type HoleSource = string[];

const HOLE: unique symbol = Symbol("yerd.hole");
/** How a hole travels in signed args: `{ "__yxHole": n }`, filled from the posted `_yxh<n>` field. */
const HOLE_KEY = "__yxHole";

const ELEMENT_FIELDS = new Set(["value", "valueAsNumber", "checked", "selectedIndex", "open", "disabled", "textContent", "id", "name", "scrollTop", "scrollLeft"]);
const BOOLEAN_FIELDS = new Set(["checked", "open", "disabled"]);
const NUMBER_FIELDS = new Set(["valueAsNumber", "selectedIndex", "scrollTop", "scrollLeft"]);

/** A live element at render time: every field read is a hole for the browser to fill. */
function liveElement(base: HoleSource, holes: HoleSource[]): ActionElement {
  const hole = (path: string[]) => {
    const key = JSON.stringify(path);
    let index = holes.findIndex((h) => JSON.stringify(h) === key);
    if (index < 0) index = holes.push(path) - 1;
    const label = `${path[0] === "ref" ? `ref(${JSON.stringify(path[1])})` : path[0]}.${path.slice(path[0] === "ref" ? 2 : 1).join(".")}`;
    const fail = () => {
      throw new TypeError(`${label} is filled in by the browser when the action fires; pass it straight into the action's arguments ({ q: ${label} }), don't compute with it`);
    };
    // Anything but being placed in the args (el.value.trim(), `${el.value}`, el.value + 1) explains itself.
    return new Proxy(Object.create(null) as object, {
      get(_h, key) {
        if (key === HOLE) return index;
        if (key === "then" || key === "toJSON") return undefined;
        if (key === Symbol.toPrimitive) return fail;
        return fail();
      },
      has: (_h, key) => key === HOLE,
    });
  };
  const name = base[0] === "ref" ? `ref(${JSON.stringify(base[1])})` : base[0]!;
  return new Proxy({} as ActionElement, {
    get(_t, key) {
      if (typeof key === "symbol") return undefined;
      if (key === "data") return (attr: string) => hole([...base, "dataset", attr]);
      if (key === "dataset") {
        return new Proxy({}, { get: (_d, attr) => (typeof attr === "string" ? hole([...base, "dataset", attr]) : undefined) });
      }
      if (ELEMENT_FIELDS.has(key)) return hole([...base, key]);
      throw new TypeError(`${name}.${key} can't be read in an action lambda; use one of: ${[...ELEMENT_FIELDS, "dataset", "data()"].join(", ")}`);
    },
  });
}

function isHole(value: unknown): value is { [HOLE]: number } {
  return typeof value === "object" && value !== null && HOLE in value;
}

/** Holes become `{ __yxHole: n }` so they survive JSON signing. */
function encodeHoles(value: unknown): unknown {
  if (isHole(value)) return { [HOLE_KEY]: value[HOLE] };
  if (Array.isArray(value)) return value.map(encodeHoles);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeHoles(v)]));
  }
  return value;
}

/**
 * Fill a verified token's holes from the posted `_yxh<n>` fields, typed by
 * what was read (`checked` is a boolean, `valueAsNumber` a number, the rest
 * strings). The holes' places are signed; only their values come from the
 * browser, like any form field. A missing one is a 400 (the action needs
 * the client runtime: a plain form post can't fill it).
 */
export function fillHoles(args: unknown, holes: HoleSource[] | undefined, fields: FormFields): unknown {
  if (!holes?.length) return args;
  const fill = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(fill);
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (typeof record[HOLE_KEY] === "number" && Object.keys(record).length === 1) {
      const index = record[HOLE_KEY] as number;
      const source = holes[index];
      const raw = fields[`_yxh${index}`];
      const text = Array.isArray(raw) ? raw[0] : raw;
      if (!source || text === undefined) throw new HttpError(400, "This action reads the page when it fires, which needs JavaScript");
      // The path after the element: [field], or ["dataset", name] (always a string).
      const path = source.slice(source[0] === "ref" ? 2 : 1);
      if (path.length === 1 && BOOLEAN_FIELDS.has(path[0]!)) return text === "true";
      if (path.length === 1 && NUMBER_FIELDS.has(path[0]!)) return Number(text);
      return text;
    }
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, fill(v)]));
  };
  return fill(args);
}

/**
 * Run an action lambda to find out which action it calls and with what.
 * Nothing runs for real: the action records the call and returns. `el` and
 * `ref()` reads become holes the browser fills when the action fires.
 */
export function captureAction(lambda: Function, holes: HoleSource[] = []): BoundAction {
  if (capturing.getStore()) throw new TypeError("An action lambda can't render another action lambda");
  const box: { fn?: Function; args?: unknown; calls: number; done: boolean } = { calls: 0, done: false };
  const scope: ActionScope = {
    el: liveElement(["el"], holes),
    drag: liveElement(["drag"], holes),
    ref: (selector: string) => liveElement(["ref", selector], holes),
    ctx: currentContext(),
    form: STAND_IN,
  };
  let result: unknown;
  try {
    result = capturing.run(box, () => lambda(scope, STAND_IN));
  } finally {
    box.done = true;
  }
  // An async lambda: the call before its first await was recorded; don't leave a rejection hanging.
  if (result instanceof Promise) result.catch(() => {});
  if (!box.fn) {
    throw new TypeError("An action lambda must call an @action method, like action={() => this.remove({ id })}");
  }
  if (box.calls > 1) throw new TypeError(`An action lambda calls one @action method, not ${box.calls}`);
  const bound = bind(box.fn as Action<unknown>, encodeHoles(box.args ?? {}));
  return holes.length ? { ...bound, holes } : bound;
}

/**
 * Attach arguments to an action for one form. They're signed, so the client
 * can't change them. The same as the lambda `() => this.archive({ id })`, as
 * a value you can build outside JSX:
 *
 * ```tsx
 * @route("/inbox")
 * export class Inbox {
 *   @inject(Db) accessor db!: Db;
 *
 *   @get page() {
 *     const rows = this.db.messages.all().map((m) => ({ ...m, archive: bind(this.archive, { id: m.id }) }));
 *     return <ul>{rows.map((m) => <li>{m.subject} <form action={m.archive}><button>Archive</button></form></li>)}</ul>;
 *   }
 *
 *   @action archive({ id }: { id: number }) {
 *     this.db.messages.archive(id);
 *   }
 * }
 * ```
 */
export function bind<A>(fn: Action<A>, args: A): BoundAction<A> {
  return { [BOUND]: true, fn, args };
}

export function isBoundAction(value: unknown): value is BoundAction {
  return typeof value === "object" && value !== null && (value as BoundAction)[BOUND] === true;
}

export function isAction(value: unknown): value is Action<unknown> {
  return typeof value === "function" && actionFunctions.has(value);
}

// ── signing ──

let processSecret: string | undefined;

/**
 * The app's secrets, newest first: options.secret, else YERD_SECRET (comma
 * separated for rotation), else one random secret per process. New tokens and
 * sessions use the first; any of them is accepted, so rotating is: prepend a
 * new secret, deploy, drop the old one later.
 */
export function resolveSecrets(explicit: string | string[] | undefined): string[] {
  const secrets = explicit === undefined
    ? (process.env.YERD_SECRET ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    : Array.isArray(explicit) ? explicit : [explicit];
  if (secrets.length > 0) {
    for (const s of secrets) if (Buffer.byteLength(s) < 32) throw new Error("Every yerd secret must be at least 32 bytes");
    return secrets;
  }
  if (process.env.NODE_ENV === "production") {
    new Logger("yerd::boot").warn("no YERD_SECRET set; using a random secret, so forms and sessions break across restarts and instances");
  }
  return [(processSecret ??= devSecret() ?? randomBytes(32).toString("base64url"))];
}

/**
 * In development, a random secret kept in node_modules/.cache/yerd/secret, so
 * a restarted dev server still accepts the open page's forms and sessions.
 * Undefined (a per-process secret) in production, under test, or when the
 * file can't be written.
 */
function devSecret(): string | undefined {
  const env = process.env.NODE_ENV;
  if (env !== undefined && env !== "development") return undefined;
  const file = join(process.cwd(), "node_modules", ".cache", "yerd", "secret");
  try {
    const saved = readFileSync(file, "utf8").trim();
    if (Buffer.byteLength(saved) >= 32) return saved;
  } catch {
    // not there yet
  }
  try {
    const secret = randomBytes(32).toString("base64url");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  } catch {
    return undefined;
  }
}

export interface TokenPayload {
  /** route class name */
  c: string;
  /** action name */
  a: string;
  /** bound args */
  p: unknown;
  /** where the args' holes are filled from (action lambdas' el / ref()) */
  h?: HoleSource[];
  /** expiry, unix seconds; absent on prerendered pages */
  e?: number;
  /** tag of the session's CSRF nonce; ties the token to one visitor's session */
  s?: string;
}

/** The session field holding the per-session CSRF nonce. */
export const CSRF_FIELD = "__yerd_csrf";

declare module "../session/session.js" {
  interface SessionData {
    /** yerd's per-session CSRF nonce (action tokens carry a hash of it). */
    __yerd_csrf?: string;
  }
}

// The last nonce csrfTag() hashed, and its tag.
let lastNonce: string | undefined;
let lastTag = "";

/**
 * What a token carries for a session nonce: a hash of it rather than the
 * nonce itself, so a token seen in page source says nothing about the session.
 */
export function csrfTag(nonce: string): string {
  // Every token on a page carries the same session's tag: hash it once.
  if (nonce !== lastNonce) {
    lastTag = createHash("sha256").update(nonce).digest("base64url").slice(0, 22);
    lastNonce = nonce;
  }
  return lastTag;
}

/**
 * Check a verified token against the request: not expired, and made for this
 * session. Tokens without an expiry come from prerendered pages (built with
 * no visitor), and are accepted on their signature and the origin check alone.
 */
export function checkActionToken(payload: TokenPayload, sessionNonce: string | undefined, sessionsOn: boolean): void {
  if (payload.e === undefined) return;
  if (payload.e < Date.now() / 1000) throw new HttpError(403, "This form has expired; reload the page and try again");
  if (sessionsOn && (payload.s === undefined || sessionNonce === undefined || payload.s !== csrfTag(sessionNonce))) {
    throw new HttpError(403, "This form was made for a different session; reload the page and try again");
  }
}

function mac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signAction(secret: string, payload: TokenPayload): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${mac(secret, data)}`;
}

export function verifyAction(secrets: readonly string[], token: string): TokenPayload {
  const dot = token.indexOf(".");
  if (dot <= 0) throw new HttpError(400, "Malformed action token");
  const data = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const valid = secrets.some((secret) => {
    const expected = Buffer.from(mac(secret, data));
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!valid) throw new HttpError(400, "Invalid action signature");
  try {
    return JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as TokenPayload;
  } catch {
    throw new HttpError(400, "Malformed action token");
  }
}

// ── rendering a form ──

export interface FormAction {
  /** URL the form posts to. */
  url: string;
  /** Signed token for the hidden _yx field. */
  token: string;
  /** Values for the browser to send with it (`_yxh<n>`), from an action lambda's `el` / `ref()`. */
  holes?: HoleSource[];
}

/**
 * Work out where a form for this action posts and what it carries. The URL is
 * the owning route's path, filled with the current request's params (plus the
 * query string, when that's the page being rendered).
 */
export function formAction(value: ActionLambda | Action<unknown> | BoundAction): FormAction {
  if (typeof value === "function" && !actionFunctions.has(value)) value = captureAction(value);
  const fn = isBoundAction(value) ? value.fn : (value as Action<unknown>);
  const args = isBoundAction(value) ? value.args : {};
  const info = actionFunctions.get(fn);
  if (!info) throw new TypeError("An action must be an @action method, a lambda calling one, or bind(...) of one");
  const owner = ownerRoute(info);
  const ctx = currentContext();
  const url = owner.pattern.replace(/[:*]([A-Za-z0-9_]+)/g, (_, name: string) => {
    const value = ctx.params[name];
    if (value === undefined) {
      throw new Error(`Can't render a form for ${owner.className}.${info.name}: the current page has no :${name} param`);
    }
    return encodeURIComponent(value);
  });
  // Keep the page's query string when posting to the page's own route, so the
  // action sees the same @query values (filters, sort) as the page did. The
  // page's own URL may spell a param differently ("/u/@ada" for "/u/%40ada").
  const samePage = url === ctx.path || decodedPath(url) === decodedPath(ctx.path);
  const holes = isBoundAction(value) ? value.holes : undefined;
  const token = ctx.signAction(holes?.length ? { c: owner.className, a: info.name, p: args, h: holes } : { c: owner.className, a: info.name, p: args });
  return { url: samePage ? url + ctx.url.search : url, token, ...(holes?.length ? { holes } : {}) };
}

interface OwnerRoute {
  className: string;
  /** The full pattern, group prefixes included. */
  pattern: string;
  /** Where the route sat in the registry, to notice a reset (dev reloads) without a hook. */
  index: number;
  def: RouteDef;
}

// Per route class: every form for one of its actions needs the same pattern,
// and resolving it walks the group chain.
const owners = new WeakMap<DecoratorMetadataObject, OwnerRoute>();

/** The route an action belongs to: its class name and full pattern. */
function ownerRoute(info: ActionInfo): OwnerRoute {
  const cached = owners.get(info.metadata);
  // A reset registry (or one refilled since) no longer holds this def where it did.
  if (cached && routeRegistry[cached.index] === cached.def) return cached;
  const index = routeRegistry.findIndex((d) => d.metadata === info.metadata);
  if (index < 0) throw new TypeError(`@action ${info.name} belongs to a class that isn't a @route`);
  const def = routeRegistry[index]!;
  const owner = { className: def.className, pattern: resolveRoute(def).pattern, index, def };
  owners.set(info.metadata, owner);
  return owner;
}

function decodedPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Only same-site paths are followed after an action: "/x", not "//evil.com",
 * "/\\evil.com", "https://..." or "javascript:...". Browsers drop tabs and
 * newlines anywhere in a URL and read a backslash as "/", so "/\t/evil.com" is
 * "//evil.com" to them: control characters and backslashes are refused
 * outright, then the URL parser has the last word on the origin. What we
 * hand back is the parsed path, and parsing drops dot segments: "/.//evil.com"
 * (or "/%2e//evil.com", "/x/..//evil.com") comes out as "//evil.com", which a
 * browser reads as another host. A result starting with "//" is refused too.
 * A refused value becomes `fallback` (default "/"). Public as auth's safeNext.
 */
export function safeBack(value: string | null | undefined, fallback = "/"): string {
  if (!value || !value.startsWith("/") || /[\x00-\x1f\x7f\\]/.test(value)) return fallback;
  let url: URL;
  try {
    url = new URL(value, "http://x");
  } catch {
    return fallback;
  }
  if (url.origin !== "http://x" || url.pathname.startsWith("//")) return fallback;
  return url.pathname + url.search + url.hash;
}
