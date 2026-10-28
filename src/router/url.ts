/**
 * urlFor(): a route's URL from its class, so links follow the route when its
 * path (or a group prefix) changes, rather than repeating the path as a
 * string. Params are checked when the URL is built: a missing one, or one
 * the route doesn't have, throws, so a stale link fails in the first test
 * that renders it instead of 404ing in production.
 */

import { metadataOf } from "../decorators/keys.js";
import { resolveRoute, routeRegistry, type RouteDef } from "../decorators/route.js";

/** Path params for urlFor(), by name. Numbers are written as they print. */
export type UrlParams = Readonly<Record<string, string | number>>;

/** A query value: `undefined` and `null` leave the name out, a list repeats it. */
type QueryValue = string | number | boolean | null | undefined | readonly (string | number | boolean)[];

/** The rest of a URL from urlFor(). */
export interface UrlOptions {
  /**
   * The query string. Entries that are undefined or null are left out, so
   * optional filters can be passed as they are.
   *
   * ```ts
   * urlFor(Search, {}, { query: { q: "lamp", tag: ["new", "sale"], page: undefined } }); // "/search?q=lamp&tag=new&tag=sale"
   * ```
   */
  query?: Readonly<Record<string, QueryValue>> | URLSearchParams;
  /** The fragment, with or without its leading "#". */
  hash?: string;
}

/** A route pattern split for filling: static text, or a param (`:name`) or splat (`*name`) to fill. */
export interface CompiledPattern {
  pattern: string;
  segments: ({ text: string } | { param: string } | { splat: string })[];
  names: Set<string>;
}

/** What's wrong with a param fillPattern() was given. */
export interface FillProblem {
  /** missing: no value; empty: "" for a :param; invalid: a non-finite number, or a "." / ".." segment. */
  kind: "missing" | "empty" | "invalid";
  name: string;
  /** Says what's wrong, e.g. `:id is missing`. */
  message: string;
}

export function compilePattern(pattern: string): CompiledPattern {
  const segments: CompiledPattern["segments"] = [];
  const names = new Set<string>();
  for (const segment of pattern.split("/").slice(1)) {
    if (segment.startsWith(":")) {
      segments.push({ param: segment.slice(1) });
      names.add(segment.slice(1));
    } else if (segment.startsWith("*")) {
      const name = segment.slice(1) || "wildcard";
      segments.push({ splat: name });
      names.add(name);
    } else {
      segments.push({ text: segment });
    }
  }
  return { pattern, segments, names };
}

/**
 * The path of a pattern with its params filled in, percent-encoded: a splat
 * segment by segment, so its slashes stay slashes. `fail` turns a problem
 * into the error to throw. Params the pattern doesn't name are ignored.
 */
export function fillPattern(compiled: CompiledPattern, params: Readonly<Record<string, string | number | undefined>>, fail: (problem: FillProblem) => Error): string {
  const text = (name: string, value: string | number): string => {
    if (typeof value === "number" && !Number.isFinite(value)) throw fail({ kind: "invalid", name, message: `:${name} is ${value}` });
    return String(value);
  };
  // "." and ".." would be resolved away by the browser, landing on another path.
  const encode = (name: string, value: string): string => {
    if (value === "." || value === "..") throw fail({ kind: "invalid", name, message: `:${name} can't be ${JSON.stringify(value)}` });
    return encodeURIComponent(value);
  };
  const parts: string[] = [];
  for (const segment of compiled.segments) {
    if ("text" in segment) {
      parts.push(segment.text);
    } else if ("param" in segment) {
      const value = params[segment.param];
      if (value === undefined) throw fail({ kind: "missing", name: segment.param, message: `:${segment.param} is missing` });
      const filled = text(segment.param, value);
      if (filled === "") throw fail({ kind: "empty", name: segment.param, message: `:${segment.param} is empty` });
      parts.push(encode(segment.param, filled));
    } else {
      const value = params[segment.splat];
      const filled = value === undefined ? "" : text(segment.splat, value);
      // An empty splat matches the path without it: /files/* answers /files.
      if (filled !== "") parts.push(filled.split("/").map((part) => encode(segment.splat, part)).join("/"));
    }
  }
  return `/${parts.join("/")}`;
}

interface Compiled extends CompiledPattern {
  /** Where the def sat in the registry, to notice a reset (dev reloads). */
  index: number;
  def: RouteDef;
}

const compiled = new WeakMap<DecoratorMetadataObject, Compiled>();

function compile(route: Function): Compiled {
  const metadata = metadataOf(route);
  const cached = compiled.get(metadata);
  if (cached && routeRegistry[cached.index] === cached.def) return cached;
  const index = routeRegistry.findIndex((d) => d.metadata === metadata);
  if (index < 0) throw new TypeError(`urlFor: ${route.name || "that class"} isn't a @route`);
  const def = routeRegistry[index]!;
  const entry = { ...compilePattern(resolveRoute(def).pattern), index, def };
  compiled.set(metadata, entry);
  return entry;
}

/**
 * The URL of a route class, its params filled in (percent-encoded), group
 * prefixes included. A splat takes a path with slashes, each segment encoded
 * on its own; it may be empty. Throws when the class isn't a @route, a param
 * is missing or empty, `params` names one the route doesn't have, or a
 * segment is "." or ".." (which the browser would resolve to another path).
 *
 * ```tsx
 * @route("/users/:id")
 * export class UserPage { ... }
 *
 * <a href={urlFor(UserPage, { id: user.id })}>{user.name}</a>          // "/users/42"
 * redirect(urlFor(UserPage, { id: 42 }, { query: { tab: "posts" } }));  // "/users/42?tab=posts"
 * urlFor(Files, { path: "docs/read me.txt" });                          // "/files/docs/read%20me.txt"
 * ```
 */
export function urlFor(route: Function, params: UrlParams = {}, options: UrlOptions = {}): string {
  const compiledRoute = compile(route);
  for (const name of Object.keys(params)) {
    if (!compiledRoute.names.has(name)) {
      const has = [...compiledRoute.names].map((n) => `:${n}`).join(", ") || "no params";
      throw new TypeError(`urlFor ${compiledRoute.pattern}: there's no :${name} param (it has ${has})`);
    }
  }
  let url = fillPattern(compiledRoute, params, (problem) => new TypeError(`urlFor ${compiledRoute.pattern}: ${problem.message}`));
  const search = queryString(options.query);
  if (search) url += `?${search}`;
  if (options.hash) url += options.hash.startsWith("#") ? options.hash : `#${options.hash}`;
  return url;
}

function queryString(query: UrlOptions["query"]): string {
  if (!query) return "";
  if (query instanceof URLSearchParams) return query.toString();
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const v of value) search.append(name, String(v));
    else search.append(name, String(value));
  }
  return search.toString();
}
