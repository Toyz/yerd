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
  headers: Record<string, string>;
}

/** Per handler method: the headers its @setHeader decorators declared, the top one winning. */
const HEADERS = methodValue<Readonly<Record<string, string>>>("setHeader");

/** What @status and @setHeader declared for a handler method, or undefined when neither did. */
export function responseDefaults(target: DecoratorTarget, method: string | symbol): ResponseDefaults | undefined {
  const code = status.get(target, method);
  const headers = HEADERS.get(target, method);
  if (code === undefined && headers === undefined) return undefined;
  return { ...(code === undefined ? {} : { status: code }), headers: { ...headers } };
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

/**
 * The status for this handler's result when it would otherwise be the
 * default 200 (or 204 for nothing). An explicit `res(..., { status })` or a
 * returned number still wins. It doesn't apply when the handler throws: an
 * error keeps its own status. For a status decided at run time, use
 * `ctx.status(code)`.
 *
 * ```ts
 * @route("/comments")
 * export class Comments {
 *   @post @status(201) create() {
 *     return { id: 7 }; // 201, JSON
 *   }
 *
 *   @post @status(202) queue() {
 *     return { queued: true };
 *   }
 * }
 * ```
 */
export const status = methodValue<number>("status", { validate: (code) => assertStatus(code, "@status") });

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
