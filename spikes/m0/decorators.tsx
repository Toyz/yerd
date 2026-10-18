// M0 spike: TC39 decorators + accessor + context.metadata + JSX through our
// runtime, compiled by whichever transformer is under test, run on Node 26.

// Symbol.metadata polyfill. Must run before any decorated class is defined.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

import { isYerdNode, type Child } from "@toyz/yerd/jsx-runtime";

const order: string[] = [];
const ROUTES = Symbol("routes");

function route(path: string) {
  return (_value: Function, context: ClassDecoratorContext) => {
    order.push(`class:${String(context.name)}`);
    const verbs = (context.metadata[ROUTES] as string[] | undefined) ?? [];
    registry.push({ path, verbs: [...verbs] });
  };
}

function get(_value: Function, context: ClassMethodDecoratorContext) {
  order.push(`method:${String(context.name)}`);
  const verbs = Object.hasOwn(context.metadata, ROUTES)
    ? (context.metadata[ROUTES] as string[])
    : (context.metadata[ROUTES] = [] as string[]);
  verbs.push(String(context.name));
}

function param(name: string) {
  return function <This, V>(
    _target: ClassAccessorDecoratorTarget<This, V>,
    context: ClassAccessorDecoratorContext<This, V>,
  ): ClassAccessorDecoratorResult<This, V> {
    order.push(`accessor:${String(context.name)}`);
    return {
      get() {
        return currentParams[name] as V;
      },
    };
  };
}

const registry: { path: string; verbs: string[] }[] = [];
let currentParams: Record<string, string> = {};

@route("/users/:id")
class UserPage {
  @param("id") accessor id!: string;

  @get
  show(): Child {
    return <main><h1>user {this.id}</h1></main>;
  }
}

currentParams = { id: "7" };
const node = new UserPage().show();

const result = {
  order,
  registry,
  metadataIsObject: typeof (UserPage as unknown as Record<symbol, unknown>)[Symbol.metadata!] === "object",
  isNode: isYerdNode(node),
  h1Child: isYerdNode(node) ? (node.props.children as { props: { children: unknown } }).props.children : null,
};

console.log(JSON.stringify(result));
