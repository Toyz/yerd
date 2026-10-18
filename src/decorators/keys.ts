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
 */
export class YerdKey<T = unknown> {
  readonly key: symbol;

  constructor(readonly name: string) {
    this.key = Symbol(`yerd:${name}`);
  }

  /** Read the value on `target`, walking the prototype chain. */
  from(target: object): T | undefined {
    return (target as Record<symbol, unknown>)[this.key] as T | undefined;
  }

  /**
   * Write the value on `target` as an own property. A plain assignment: symbol
   * keys are already invisible to for-in, Object.keys and JSON, and
   * defineProperty is markedly slower on the per-request path.
   */
  set(target: object, value: T): void {
    (target as Record<symbol, unknown>)[this.key] = value;
  }

  has(target: object): boolean {
    return this.key in target;
  }

  /** True when `target` carries the value as its own property, not inherited. */
  hasOwn(target: object): boolean {
    return Object.prototype.hasOwnProperty.call(target, this.key);
  }

  /** Array value guaranteed to be own to `target`; copy-on-inherit. */
  ownArray<E>(target: object): E[] {
    if (this.hasOwn(target)) return this.from(target) as E[];
    const inherited = this.from(target) as E[] | undefined;
    const own = inherited ? inherited.slice() : [];
    this.set(target, own as T);
    return own;
  }

  /** Map value guaranteed to be own to `target`; copy-on-inherit. */
  ownMap<K, V>(target: object): Map<K, V> {
    if (this.hasOwn(target)) return this.from(target) as Map<K, V>;
    const inherited = this.from(target) as Map<K, V> | undefined;
    const own = new Map<K, V>(inherited);
    this.set(target, own as T);
    return own;
  }

  get description(): string | undefined {
    return this.key.description;
  }

  toString(): string {
    return this.key.toString();
  }
}

const KEY_REGISTRY = new Map<string, YerdKey>();

/**
 * A shared, named key. Asking twice for the same name returns the same key, and
 * every one is listed in the registry, so tooling (`yerd routes`, an inspector)
 * can enumerate what decorators have attached to a class.
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
 * registered. For per-accessor storage where identity must not be shared.
 */
export function localKey<T = unknown>(name: string): YerdKey<T> {
  return new YerdKey<T>(name);
}

/** Every registered key, by name. */
export function registeredKeys(): ReadonlyMap<string, YerdKey> {
  return KEY_REGISTRY;
}

/**
 * Find a value stored under a local key, by name. Local keys can't be rebuilt
 * from outside the closure that made them, but their description is stable,
 * which is enough to find them (loom's findLocalStore).
 */
export function findLocalStore<T = unknown>(target: object, name: string): T | undefined {
  const wanted = `yerd:${name}`;
  for (const symbol of Object.getOwnPropertySymbols(target)) {
    if (symbol.description === wanted) return (target as Record<symbol, unknown>)[symbol] as T;
  }
  return undefined;
}

/** The metadata object tsc/esbuild attached to a decorated class. */
export function metadataOf(ctor: Function): DecoratorMetadataObject {
  return ((ctor as unknown as Record<symbol, unknown>)[Symbol.metadata!] as DecoratorMetadataObject | undefined) ?? {};
}
