/**
 * Typed metadata keys, ported from loom's LoomSymbol / createSymbol.
 *
 * Decorators write into `context.metadata`. A subclass's metadata object
 * prototype-chains to its parent's, so a plain read walks up the chain and a
 * `.push()` on the result would mutate the parent's array, leaking a
 * subclass's routes into its base and siblings. `ownArray` / `ownMap` return a
 * collection the target owns, seeded from the inherited one.
 *
 * Brand markers that appear as computed keys in interfaces (YERD_NODE, RAW,
 * BARE, RESOLVER) stay plain `unique symbol` constants: TypeScript only allows
 * `unique symbol` types as property keys in type declarations.
 *
 * Use one when writing your own decorators: store what the decorator knows on
 * `context.metadata`, read it back later from the class.
 *
 * ```ts
 * const AUDIT = createKey<string>("app:audit");
 *
 * export const audit = (area: string) => (_cls: Function, context: ClassDecoratorContext) => {
 *   AUDIT.set(context.metadata, area);
 * };
 *
 * @audit("billing") class Invoices {}
 * AUDIT.from(metadataOf(Invoices)); // "billing"
 * ```
 */
export class YerdKey<T = unknown> {
  /** The symbol values are stored under, described `yerd:<name>`. */
  readonly key: symbol;

  /** Use createKey() (shared by name) or localKey() (private) rather than `new`. */
  constructor(readonly name: string) {
    this.key = Symbol(`yerd:${name}`);
  }

  /**
   * Read the value on `target`, walking the prototype chain (so a subclass
   * sees its parent's metadata).
   *
   * ```ts
   * const area = AUDIT.from(metadataOf(Invoices)); // string | undefined
   * ```
   */
  from(target: object): T | undefined {
    return (target as Record<symbol, unknown>)[this.key] as T | undefined;
  }

  /**
   * Write the value on `target` as an own property. A plain assignment: symbol
   * keys are already invisible to for-in, Object.keys and JSON, and
   * defineProperty is markedly slower on the per-request path.
   *
   * ```ts
   * (_cls: Function, context: ClassDecoratorContext) => AUDIT.set(context.metadata, "billing");
   * ```
   */
  set(target: object, value: T): void {
    (target as Record<symbol, unknown>)[this.key] = value;
  }

  /**
   * True when `target` carries the value, own or inherited.
   *
   * ```ts
   * if (AUDIT.has(metadataOf(cls))) auditedRoutes.push(cls);
   * ```
   */
  has(target: object): boolean {
    return this.key in target;
  }

  /**
   * True when `target` carries the value as its own property, not inherited.
   *
   * ```ts
   * class Archive extends Invoices {}
   * AUDIT.hasOwn(metadataOf(Archive)); // false: it inherits "billing" from Invoices
   * ```
   */
  hasOwn(target: object): boolean {
    return Object.prototype.hasOwnProperty.call(target, this.key);
  }

  /**
   * Array value guaranteed to be own to `target`; copy-on-inherit. Push to
   * this, never to what from() returns, or a subclass's entries leak into
   * its parent.
   *
   * ```ts
   * const TAGS = createKey<string[]>("app:tags");
   * const tag = (name: string) => (_method: Function, context: ClassMethodDecoratorContext) => {
   *   TAGS.ownArray<string>(context.metadata).push(name);
   * };
   * ```
   */
  ownArray<E>(target: object): E[] {
    if (this.hasOwn(target)) return this.from(target) as E[];
    const inherited = this.from(target) as E[] | undefined;
    const own = inherited ? inherited.slice() : [];
    this.set(target, own as T);
    return own;
  }

  /**
   * Map value guaranteed to be own to `target`; copy-on-inherit. The usual
   * shape for per-method metadata, keyed by method name.
   *
   * ```ts
   * const NOTES = createKey<Map<string | symbol, string>>("app:notes");
   * const note = (text: string) => (_method: Function, context: ClassMethodDecoratorContext) => {
   *   NOTES.ownMap<string | symbol, string>(context.metadata).set(context.name, text);
   * };
   * ```
   */
  ownMap<K, V>(target: object): Map<K, V> {
    if (this.hasOwn(target)) return this.from(target) as Map<K, V>;
    const inherited = this.from(target) as Map<K, V> | undefined;
    const own = new Map<K, V>(inherited);
    this.set(target, own as T);
    return own;
  }

  /** The symbol's description, `yerd:<name>`. */
  get description(): string | undefined {
    return this.key.description;
  }

  /** `Symbol(yerd:<name>)`, for messages. */
  toString(): string {
    return this.key.toString();
  }
}

const KEY_REGISTRY = new Map<string, YerdKey>();

/**
 * A shared, named key. Asking twice for the same name returns the same key, and
 * every one is listed in the registry, so tooling (`yerd routes`, an inspector)
 * can enumerate what decorators have attached to a class. Because keys are
 * shared by name, two modules can reach the same metadata without importing
 * each other; prefix your names (`app:`) so they can't collide with yerd's.
 *
 * ```ts
 * export const AUDIT = createKey<string>("app:audit");
 * createKey<string>("app:audit") === AUDIT; // true, from any module
 * ```
 */
export function createKey<T = unknown>(name: string): YerdKey<T> {
  const existing = KEY_REGISTRY.get(name);
  if (existing) return existing as YerdKey<T>;
  const key = new YerdKey<T>(name);
  KEY_REGISTRY.set(name, key);
  return key;
}

/**
 * A private key: typed like any other, but a fresh symbol per call and never
 * registered. For per-accessor storage where identity must not be shared,
 * such as a cache a decorator keeps on each instance.
 *
 * ```ts
 * const runs = localKey<number>("runs"); // a fresh symbol: nothing else can collide with it
 * runs.set(job, (runs.from(job) ?? 0) + 1);
 * ```
 */
export function localKey<T = unknown>(name: string): YerdKey<T> {
  return new YerdKey<T>(name);
}

/**
 * Every key made with createKey(), by name, yerd's own included. For tooling
 * and debugging: list everything decorators have attached to a class.
 *
 * ```ts
 * const meta = metadataOf(Todos);
 * for (const [name, key] of registeredKeys()) {
 *   if (key.hasOwn(meta)) console.log(name, key.from(meta));
 * }
 * ```
 */
export function registeredKeys(): ReadonlyMap<string, YerdKey> {
  return KEY_REGISTRY;
}

/**
 * Find a value stored under a local key, by name. Local keys can't be rebuilt
 * from outside the closure that made them, but their description is stable,
 * which is enough to find them (loom's findLocalStore). Looks at own
 * properties only. Mostly for tests and debugging.
 *
 * ```ts
 * const seen = localKey<number>("seen");
 * seen.set(job, 3);
 * findLocalStore<number>(job, "seen"); // 3, without access to `seen`
 * ```
 */
export function findLocalStore<T = unknown>(target: object, name: string): T | undefined {
  const wanted = `yerd:${name}`;
  for (const symbol of Object.getOwnPropertySymbols(target)) {
    if (symbol.description === wanted) return (target as Record<symbol, unknown>)[symbol] as T;
  }
  return undefined;
}

/**
 * The metadata object tsc/esbuild attached to a decorated class (an empty
 * object when there is none). Where you read keys back after the decorators
 * have run.
 *
 * ```ts
 * @audit("billing") class Invoices {}
 * AUDIT.from(metadataOf(Invoices)); // "billing"
 * ```
 */
export function metadataOf(ctor: Function): DecoratorMetadataObject {
  return ((ctor as unknown as Record<symbol, unknown>)[Symbol.metadata!] as DecoratorMetadataObject | undefined) ?? {};
}
