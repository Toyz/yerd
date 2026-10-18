/**
 * Response defaults and error handlers, declared on handler methods.
 *
 * ```tsx
 * @route("/todos")
 * class Todos {
 *   @post @status(201) @setHeader("cache-control", "no-store")
 *   create() { return { id: 1 }; }                 // 201, JSON
 *
 *   @catches(NotFound)
 *   missing(error: NotFound) { return <Gone what={error.what} />; }  // HTML, the error's status
 * }
 * ```
 */

import { createMethodDecorator, methodList, methodValue, type DecoratorTarget } from "./kit.js";
import { assertStatus, checkHeader } from "../respond/response.js";

export interface ResponseDefaults {
  status?: number;
  /** Every status @status([...]) listed, when it was given a list: what the handler says it can answer. */
  listed?: readonly number[];
  headers: Record<string, string>;
}

/** Per handler method: the headers its @setHeader decorators declared, the top one winning. */
const HEADERS = methodValue<Readonly<Record<string, string>>>("setHeader");

/** What @status and @setHeader declared for a handler method, or undefined when neither did. */
export function responseDefaults(target: DecoratorTarget, method: string | symbol): ResponseDefaults | undefined {
  const declared = STATUS.get(target, method);
  const headers = HEADERS.get(target, method);
  if (declared === undefined && headers === undefined) return undefined;
  return {
    ...(declared === undefined ? {} : { status: declared.code }),
    ...(declared?.listed ? { listed: declared.listed } : {}),
    headers: { ...headers },
  };
}

export interface CatchEntry {
  method: string | symbol;
  /** Error classes this method handles; empty: every error. */
  types: readonly Function[];
}

/** A route class's @catches methods, in declaration order. */
export function catchesOf(target: DecoratorTarget): CatchEntry[] {
  return [...catches.entries(target)].map(([method, types]) => ({ method, types }));
}

interface StatusDeclaration {
  /** The status a plain return value gets. */
  code: number;
  /** Given as a list: every status the handler says it can answer. */
  listed?: readonly number[];
}

const STATUS = methodValue<StatusDeclaration>("status", {
  validate: ({ code, listed }) => {
    for (const c of listed ?? [code]) assertStatus(c, "@status");
    return listed && listed.length === 0 ? "give at least one status" : undefined;
  },
});

/**
 * The status for this handler's result when it would otherwise be the
 * default 200 (or 204 for nothing). An explicit `res(..., { status })` or a
 * returned status still wins, and an error keeps its own. For a status
 * decided at run time, use `ctx.status(code)`.
 *
 * Given a list, it also says every status the endpoint can answer: the first
 * is the default, and in development yerd warns when the handler answers
 * with one that isn't listed (5xx crashes and 304s aside). The list is
 * optional; tooling can read it with `status.listed()`.
 *
 * ```ts
 * @route("/products")
 * export class Products {
 *   @post @status(HttpStatus.Created) create() {
 *     return this.catalog.add(this.input); // 201, JSON
 *   }
 *
 *   @put @status([HttpStatus.Ok, HttpStatus.Created, HttpStatus.Conflict]) upsert() {
 *     if (this.catalog.locked(this.id)) return new Conflict("Locked");
 *     return this.catalog.save(this.id, this.input); // 200, the first listed
 *   }
 * }
 * ```
 */
export const status = Object.assign(
  (codes: number | readonly number[]) =>
    STATUS(Array.isArray(codes) ? { code: (codes as readonly number[])[0]!, listed: [...(codes as readonly number[])] } : { code: codes as number }),
  {
    /**
     * The default status @status declared for a handler method, or undefined.
     *
     * ```ts
     * status.get(Products, "create"); // 201
     * ```
     */
    get: (target: DecoratorTarget, method: string | symbol): number | undefined => STATUS.get(target, method)?.code,
    /**
     * Every status @status([...]) listed for a handler method, or undefined
     * when it wasn't given a list: for docs and API tooling.
     *
     * ```ts
     * status.listed(Products, "upsert"); // [200, 201, 409]
     * ```
     */
    listed: (target: DecoratorTarget, method: string | symbol): readonly number[] | undefined => STATUS.get(target, method)?.listed,
  },
);

/**
 * A header on this handler's responses (a header the result sets itself
 * wins; `Vary` values add up instead). Checked when the decorator runs, so a
 * bad name or value fails at startup. Not sent when the handler throws; use
 * `ctx.setHeader()` for headers that must go out on errors too.
 *
 * ```ts
 * @route("/comments")
 * export class Comments {
 *   @get @setHeader("cache-control", "public, max-age=60") list() {
 *     return [{ id: 7 }];
 *   }
 *
 *   @post @status(201) @setHeader("cache-control", "no-store") create() {
 *     return { id: 8 };
 *   }
 * }
 * ```
 */
export const setHeader = createMethodDecorator("setHeader", {
  validate: (name: string, value: string) => checkHeader(name, value, `@setHeader(${JSON.stringify(name)}): the value`),
  // Applied bottom-up: each one goes over what's there, so the top one wins, and a subclass's over its parent's.
  apply: (context, name, value) => HEADERS.set(context, { ...HEADERS.get(context.metadata, context.name), [name.toLowerCase()]: value }),
});

/**
 * Handle errors thrown by this route's handlers, guards and actions. The
 * method gets the error and returns anything a handler can; JSX is rendered
 * in the route's layouts. The response keeps the error's status (an
 * YerdError's, else 500) unless the method returns `res(..., { status })` or
 * a number. Return undefined to pass the error on (to `app.onError`, then the
 * error page). With no classes it handles every error. Methods are tried in
 * the order written.
 *
 * ```tsx
 * class NotFound extends Error {
 *   constructor(readonly what: string) {
 *     super(`${what} not found`);
 *   }
 * }
 *
 * @route("/pets/:name")
 * export class Pet {
 *   @get show(): never {
 *     throw new NotFound("cat");
 *   }
 *
 *   @catches(NotFound)
 *   missing(error: NotFound) {
 *     return res(<p>No {error.what} here.</p>, { status: 404 });
 *   }
 *
 *   @catches()
 *   anythingElse(error: unknown) {
 *     if (error instanceof TypeError) return "try again later";
 *     return undefined; // not mine: pass it on
 *   }
 * }
 * ```
 */
export const catches = methodList<Function>("catches");
