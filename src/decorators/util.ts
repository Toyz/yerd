/**
 * Plumbing shared by yerd's own decorators. Internal: not exported from the
 * package.
 */

/** The parts of a class member decorator's context that say where it was applied. */
interface MemberContext {
  readonly kind: string;
  readonly name: string | symbol;
  readonly static: boolean;
  readonly private: boolean;
}

/**
 * Throw a TypeError unless the decorator sits on a public instance member:
 * static and `#private` members aren't reachable the way yerd reads them.
 * `stringNamed` also refuses symbol names.
 */
export function assertPublicInstance<C extends MemberContext>(context: C, label: string, options: { stringNamed: true }): asserts context is C & { readonly name: string };
export function assertPublicInstance(context: MemberContext, label: string, options?: { stringNamed?: boolean }): void;
export function assertPublicInstance(context: MemberContext, label: string, options?: { stringNamed?: boolean }): void {
  const stringNamed = options?.stringNamed ?? false;
  if (context.static || context.private || (stringNamed && typeof context.name !== "string")) {
    throw new TypeError(`${label} must decorate a public${stringNamed ? ", string-named" : ""} instance ${context.kind} (got ${String(context.name)})`);
  }
}

type ContextOfKind<K extends DecoratorContext["kind"]> = Extract<DecoratorContext, { kind: K }>;

/**
 * Whether `value` is a decorator context (of `kind`, when given). Tells a bare
 * decorator, called with (value, context), from its factory form.
 */
export function isDecoratorContext<K extends DecoratorContext["kind"] = DecoratorContext["kind"]>(value: unknown, kind?: K): value is ContextOfKind<K> {
  if (typeof value !== "object" || value === null || !("metadata" in value)) return false;
  const actual = (value as { kind?: unknown }).kind;
  return kind === undefined ? typeof actual === "string" : actual === kind;
}

export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function";
}
