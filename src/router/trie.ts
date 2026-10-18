/**
 * Segment trie router. At each segment a static match is tried first, then a
 * named parameter, then a splat, backtracking on failure. So `/users/new`
 * beats `/users/:id` whatever order the routes were registered in.
 */

import type { Verb } from "../decorators/route.js";

interface Node<T> {
  statics: Map<string, Node<T>>;
  param?: { name: string; node: Node<T> };
  splat?: { name: string; node: Node<T> };
  handlers: Map<Verb, T>;
  pattern?: string;
}

export interface Match<T> {
  handlers: ReadonlyMap<Verb, T>;
  params: Record<string, string>;
  pattern: string;
}

function createNode<T>(): Node<T> {
  return { statics: new Map(), handlers: new Map() };
}

function segmentsOf(path: string): string[] {
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed === "/" ? [] : trimmed.slice(1).split("/");
}

/** Parameter names declared by a pattern, in order. */
export function paramNames(pattern: string): string[] {
  return segmentsOf(pattern)
    .filter((s) => s.startsWith(":") || s.startsWith("*"))
    .map((s) => s.slice(1) || "wildcard");
}

function safeDecode(value: string): string {
  // Most segments have nothing escaped.
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** No params: shared by every static match, so it must never be written to. */
const NO_PARAMS: Record<string, string> = Object.freeze({}) as Record<string, string>;

export class Router<T> {
  #root: Node<T> = createNode();
  /** Routes without params, by path: answered without walking the tree. */
  readonly #exact = new Map<string, Match<T>>();

  add(pattern: string, verb: Verb, handler: T): void {
    const segments = segmentsOf(pattern);
    // A repeated name would leave one of the two values silently overwritten in params.
    const names = paramNames(pattern);
    const repeated = names.find((name, i) => names.indexOf(name) !== i);
    if (repeated !== undefined) throw new Error(`${pattern}: the parameter name ${repeated} appears twice`);
    let node = this.#root;
    segments.forEach((segment, i) => {
      if (segment.startsWith(":")) {
        const name = segment.slice(1);
        if (!name) throw new Error(`Empty parameter name in ${pattern}`);
        if (node.param && node.param.name !== name) {
          throw new Error(
            `${pattern} names this segment :${name}, but another route already named it :${node.param.name}`,
          );
        }
        node.param ??= { name, node: createNode() };
        node = node.param.node;
      } else if (segment.startsWith("*")) {
        if (i !== segments.length - 1) throw new Error(`A splat must be the last segment: ${pattern}`);
        const name = segment.slice(1) || "wildcard";
        if (node.splat && node.splat.name !== name) {
          throw new Error(`${pattern} names this splat *${name}, but another route named it *${node.splat.name}`);
        }
        node.splat ??= { name, node: createNode() };
        node = node.splat.node;
      } else {
        let next = node.statics.get(segment);
        if (!next) node.statics.set(segment, (next = createNode()));
        node = next;
      }
    });
    if (node.handlers.has(verb)) {
      throw new Error(`Duplicate route: ${verb} ${pattern} (already registered as ${node.pattern})`);
    }
    node.handlers.set(verb, handler);
    node.pattern ??= pattern;
    if (names.length === 0) this.#exact.set(segments.length === 0 ? "/" : `/${segments.join("/")}`, { handlers: node.handlers, params: NO_PARAMS, pattern: node.pattern });
  }

  match(path: string): Match<T> | null {
    // A static route wins over a param at the same place in the tree too, so the shortcut agrees with the walk.
    const exact = this.#exact.get(path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);
    if (exact) return exact;
    const params: Record<string, string> = {};
    const found = this.#walk(this.#root, segmentsOf(path), 0, params);
    return found ? { handlers: found.handlers, params, pattern: found.pattern! } : null;
  }

  #walk(node: Node<T>, segments: string[], i: number, params: Record<string, string>): Node<T> | null {
    if (i === segments.length) {
      if (node.handlers.size > 0) return node;
      // A splat can match zero remaining segments: /files/* matches /files.
      if (node.splat && node.splat.node.handlers.size > 0) {
        params[node.splat.name] = "";
        return node.splat.node;
      }
      return null;
    }
    const segment = segments[i]!;

    const staticNext = node.statics.get(segment);
    if (staticNext) {
      const found = this.#walk(staticNext, segments, i + 1, params);
      if (found) return found;
    }

    if (node.param && segment !== "") {
      const found = this.#walk(node.param.node, segments, i + 1, params);
      if (found) {
        params[node.param.name] = safeDecode(segment);
        return found;
      }
    }

    if (node.splat && node.splat.node.handlers.size > 0) {
      params[node.splat.name] = segments.slice(i).map(safeDecode).join("/");
      return node.splat.node;
    }

    return null;
  }
}
