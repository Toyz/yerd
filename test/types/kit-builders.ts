// Compile-only: the method and class decorator builders are typed as declared.
import { classFlag, classList, classValue, createMethodDecorator, methodFlag, methodList, methodValue } from "@toyz/yerd";
import type { BareClassValue, BareMethodDecoratorFactory, BareMethodValue, ClassValue, MethodDecoratorFactory, MethodValue } from "@toyz/yerd";

const audit = methodFlag("audit");
const rateLimit = methodValue<number>("rateLimit");
const cache = methodValue("cache", { bare: () => 60 });
const tags = methodList<string>("tags");
const internal = classFlag("internal");
const feature = classValue<string>("feature");
const prerendered = classValue<{ paths?: string[] }>("prerendered", { bare: () => ({}) });
const scopes = classList<string>("scopes");
const timed = createMethodDecorator("timed", { bare: true, wrap: (method, _context, label?: string) => (label ? method : undefined) });
const retry = createMethodDecorator("retry", { apply: (_context, times: number) => void times });

@internal
@feature("beta")
@prerendered
@scopes("read", "write")
export class Fine {
  @audit @rateLimit(10) @cache @tags("a", "b") @timed @retry(3) a() {}
  @cache(300) @timed("label") b() {}
}

@prerendered({ paths: ["/x"] })
export class Called {}

export class Wrong {
  // @ts-expect-error a flag is bare: no call
  @audit() a() {}

  // @ts-expect-error a value without `bare` must be called
  @rateLimit b() {}

  // @ts-expect-error the value's type is checked
  @rateLimit("10") c() {}

  // @ts-expect-error list items are checked
  @tags(1) d() {}

  // @ts-expect-error createMethodDecorator arguments are checked
  @retry("3") e() {}

  // @ts-expect-error without `bare`, createMethodDecorator must be called
  @retry f() {}

  // @ts-expect-error a class decorator doesn't go on a method
  @internal g() {}
}

// @ts-expect-error a method flag doesn't go on a class
@audit
export class NotAMethod {}

// @ts-expect-error a class value without `bare` must be called
@feature
export class Uncalled {}

const readers: [boolean, number | undefined, readonly string[], boolean, string | undefined, readonly string[], boolean] = [
  audit.has(Fine, "a"),
  rateLimit.get(Fine, "a"),
  tags.get(Fine, "a"),
  internal.has(Fine),
  feature.get(Fine),
  scopes.get(Fine),
  timed.has(Fine, "b"),
];
export { readers };
const labels: readonly [label?: string][] = timed.get(Fine, "b");
export { labels };

// The named types describe what the builders return.
const typed: [MethodValue<number>, BareMethodValue<number>, ClassValue<string>, BareClassValue<{ paths?: string[] }>, BareMethodDecoratorFactory<[label?: string]>, MethodDecoratorFactory<[times: number]>] = [
  rateLimit, cache, feature, prerendered, timed, retry,
];
export { typed };
