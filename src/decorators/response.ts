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

import { createKey } from "./keys.js";
import { assertPublicInstance } from "./util.js";
import { assertStatus, checkHeader } from "../respond/response.js";

export interface ResponseDefaults {
  status?: number;
  headers: Record<string, string>;
}

/** Per handler method: the status and headers @status / @setHeader declared. */
export const METHOD_RESPONSE = createKey<Map<string | symbol, ResponseDefaults>>("response:method");

export interface CatchEntry {
  method: string | symbol;
  /** Error classes this method handles; empty: every error. */
  types: Function[];
}

/** Per route class: its @catches methods, in declaration order. */
export const CATCHES = createKey<CatchEntry[]>("catches");

function defaultsFor(context: ClassMethodDecoratorContext): ResponseDefaults {
  const map = METHOD_RESPONSE.ownMap<string | symbol, ResponseDefaults>(context.metadata);
  let entry = map.get(context.name);
  if (!entry) map.set(context.name, (entry = { headers: {} }));
  return entry;
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
export function status(code: number) {
  assertStatus(code, "@status");
  return (_method: Function, context: ClassMethodDecoratorContext): void => {
    defaultsFor(context).status = code;
  };
}

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
export function setHeader(name: string, value: string) {
  checkHeader(name, value, `@setHeader(${JSON.stringify(name)}): the value`);
  return (_method: Function, context: ClassMethodDecoratorContext): void => {
    defaultsFor(context).headers[name.toLowerCase()] = value;
  };
}

/**
 * Handle errors thrown by this route's handlers, guards and actions. The
 * method gets the error and returns anything a handler can; JSX is rendered
 * in the route's layouts. The response keeps the error's status (an
 * HttpError's, else 500) unless the method returns `res(..., { status })` or
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
export function catches(...types: Function[]) {
  return (_method: Function, context: ClassMethodDecoratorContext): void => {
    assertPublicInstance(context, "@catches");
    CATCHES.ownArray<CatchEntry>(context.metadata).push({ method: context.name, types });
  };
}
