/**
 * Response defaults and error handlers, declared on handler methods.
 *
 * ```ts
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
 * returned number still wins.
 */
export function status(code: number) {
  if (!Number.isInteger(code) || code < 200 || code > 599) throw new TypeError(`@status(${code}): not a response status (200-599)`);
  return (_method: Function, context: ClassMethodDecoratorContext): void => {
    defaultsFor(context).status = code;
  };
}

/** A header on this handler's responses (a header the result sets itself wins). */
export function setHeader(name: string, value: string) {
  if (/[\r\n\0]/.test(value)) throw new TypeError(`@setHeader(${JSON.stringify(name)}): the value contains a line break or NUL`);
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
 * error page). With no classes it handles every error.
 */
export function catches(...types: Function[]) {
  return (_method: Function, context: ClassMethodDecoratorContext): void => {
    if (context.static || context.private) throw new TypeError("@catches goes on a public instance method");
    CATCHES.ownArray<CatchEntry>(context.metadata).push({ method: context.name, types });
  };
}
