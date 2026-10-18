# Request data

The shop reads what visitors send: a search, a category, a product id, the checkout form.

## Accessors

The API's search reads two query parameters. Request data arrives on decorated `accessor` fields; each decorator says where the value comes from.

```tsx
// src/routes/api.ts
@route("/api/products", { session: false })
export class ProductsApi {
  @inject(Catalog) accessor catalog!: Catalog;
  @query("q", { transform: trim }) accessor q = "";
  @query("category", { transform: oneOf(...CATEGORIES) }) accessor category: Category | undefined;

  @get list() {
    // An array becomes JSON.
    return this.catalog.search({ q: this.q, category: this.category });
  }
}
```

```answer
GET /api/products?q=%20%20lamp%20
200 OK
content-type: application/json; charset=utf-8

[{"id":4,"name":"Desk lamp","category":"desk","price":6500,"stock":3,"description":"Warm light, one arm, no app."}]
---
GET /api/products?category=hats
400 Bad Request
content-type: application/json; charset=utf-8

{"error":"Expected one of pens, notebooks, desk, got \"hats\"","code":"validation_failed","issues":[{"path":"category","message":"Expected one of pens, notebooks, desk, got \"hats\""}]}
```

- A missing value falls back to the field's initializer (`q = ""`), or `undefined`. With `required: true` it's a 400 instead.
- The transform runs first: `trim` turns `"  lamp "` into `"lamp"`, and `oneOf` refuses anything but a category, before the handler runs.
- Values belong to the current request, whatever the route's lifetime. Each is resolved once per request, and assigning to the field throws.

> [!TAKE]
> Request data is declared on the class, not dug out of a `req` object. The declaration is the parsing, the validation and the type, every handler and action on the route shares it, and a typo is a compile error. The cost is the `accessor` keyword on every field, which TC39 decorators need to see reads.

| Decorator | Reads | Field type |
| --- | --- | --- |
| [`@param(name, opts)`](api:yerd.param) | a path parameter | `string` |
| [`@params`](api:yerd.params) | all path parameters | `Record<string, string>` |
| [`@query(name, opts)`](api:yerd.query) | first value of a query parameter | `string \| undefined` |
| [`@header(name, opts)`](api:yerd.header) | a header (repeats joined with `", "`) | `string \| undefined` |
| [`@cookie(name, opts)`](api:yerd.cookie) | a request cookie | `string \| undefined` |
| [`@body(Dto or opts)`](api:yerd.body) | the parsed body | `Promise<...>` |
| [`@field(name, opts)`](api:yerd.field) | one form field | `Promise<string \| undefined>` |
| [`@file(name, opts)`](api:yerd.file) | the first uploaded file under a name | `Promise<File \| undefined>` |
| [`@files(name, opts)`](api:yerd.files) | every file under a name | `Promise<File[]>` |
| [`@signal`](api:yerd.signal) | aborts when the client disconnects | `AbortSignal` |
| [`@session`](api:yerd.session) | the session (needs `app.sessions()`) | `Session` |
| [`@request`](api:yerd.request) | the raw Node `IncomingMessage` | `IncomingMessage` |

Types shown are before transforms; a transform changes the field type to what it returns.

## Transforms and validators

Every name-based accessor takes the same options. The product page's id is a number, or the request is refused:

```tsx
// src/routes/products.tsx
@param("id", { transform: toInt }) accessor id!: number;
```

| Option | Type | Applies to | What it does |
| --- | --- | --- | --- |
| `transform` | function or array | all | Converts the raw string. An array runs left to right. Skipped when the value is missing. |
| `validate` | function or array | all | Checks the transformed value. Runs in order. |
| `required` | `boolean` | all but `@param` | Missing means 400 instead of the initializer. |

```tsx
import { between, lower, oneOf, query, toBool, toInt, trim } from "@toyz/yerd";

@query("page", { transform: toInt, validate: between(1, 100) }) accessor page = 1;
@query("verbose", { transform: toBool }) accessor verbose = false;
@query("sort", { transform: [trim, lower, oneOf("new", "top")] }) accessor sort: "new" | "top" = "new";
@param("id", { transform: toInt, validate: (n: number) => n > 0 || "ids start at 1" }) accessor id!: number;
```

- The pipeline is type-checked: `[toInt, trim]` doesn't compile, nor does a `toInt` transform on a string field.

> [!WARNING]
> Annotate inline validators' parameter: `(n: number) => ...`, not `(n) => ...`. Strict mode rejects the implicit `any`.

Built-in transforms (throw a 400 on bad input):

| Transform | Output |
| --- | --- |
| [`toInt`](api:yerd.toInt) | A safe base-10 integer, spaces trimmed. Not `"1.5"`, `"abc"` or `"0x10"`. |
| [`toNumber`](api:yerd.toNumber) | A decimal number, spaces trimmed (`"3.5"`, `"-.5"`, `"1e3"`). Not blanks, hex, `"Infinity"` or overflow. |
| [`toBool`](api:yerd.toBool) | `"true"`, `"1"`, `"on"`, `""` are true; `"false"`, `"0"`, `"off"` are false. |
| [`trim`](api:yerd.trim) / [`lower`](api:yerd.lower) | The trimmed / lowercased string. |
| [`oneOf("a", "b")`](api:yerd.oneOf) | One of the listed strings; the type is their union. |

Built-in validators (return a message on failure):

| Validator | Accepts |
| --- | --- |
| [`between(min, max)`](api:yerd.between) | Numbers from `min` to `max`, inclusive. |
| [`length(min, max?)`](api:yerd.length) | Strings or arrays with a length in range; `max` defaults to unlimited. |
| [`matches(regex, message?)`](api:yerd.matches) | Strings matching the pattern. |

Your own are plain functions. A transform returns the new value or throws an [`YerdError`](api:yerd.YerdError); a validator returns `true`, `false` (generic 400) or a message string (400 with it).

```ts
import { ValidationFailed, type Transform } from "@toyz/yerd";

export const slug: Transform<string, string> = (raw) => {
  if (!/^[a-z0-9-]+$/.test(raw)) throw new ValidationFailed(`Not a slug: ${raw}`);
  return raw;
};
```

## Bodies and DTO classes

The checkout form has three fields, each with rules. A DTO class declares them with [is.*](api:yerd.is) decorators:

```ts
// src/orders.ts
/** The checkout form. Every field is checked on the server; the browser's checks are a courtesy. */
export class CheckoutForm {
  @is.string({ transform: trim, validate: length(2, 80) }) name!: string;
  @is.email() email!: string;
  @is.string({ transform: trim, validate: length(5, 200) }) address!: string;
}
```

The checkout action parses the posted form into it:

```tsx
// src/routes/checkout.tsx
@action async place(_: {}, form: ActionForm) {
  let details: CheckoutForm;
  try {
    details = form.parse(CheckoutForm);
  } catch (error) {
    // ...a plain form post gets its errors back on the page (see the shop)
  }
  const order = await this.orders.place(this.me, details, this.cart.lines);
  // ...
}
```

```answer
POST /checkout
_yx=(the form's token)&name=A&email=nope&address=
>>>
400 Bad Request
content-type: application/json; charset=utf-8

{"error":"Validation failed","code":"validation_failed","issues":[{"path":"name","message":"Must be 2 to 80 characters (got 1)"},{"path":"email","message":"Expected an email address"},{"path":"address","message":"Can't be empty"}]}
```

- Every problem comes back at once, each with its path. The client runtime writes each message into the field's `[data-yx-error="name"]` box ([Interactivity](06-interactivity.md#errors)).
- You get an instance of the class with clean, typed values: `name` trimmed, `email` checked.
- Outside an action, [@body(CheckoutForm)](api:yerd.body) does the same for a plain POST or a JSON body: `@body(CheckoutForm) accessor details!: Promise<CheckoutForm>`.

The rules for DTOs:

- DTO fields are plain fields, not accessors.
- A field without `optional: true` or an initializer is required. Initializers are defaults.
- Undeclared keys are dropped, so a client can't sneak in `isAdmin: true`.
- `is.int`, `is.number` and `is.boolean` accept string forms (`"42"`, `"on"`), so one DTO serves JSON and HTML forms.
- A decorator that doesn't match the field's type is a compile error.

| Decorator | Value |
| --- | --- |
| `is.string()` / `is.int()` / `is.number()` / `is.boolean()` | the primitive |
| `is.oneOf(["a", "b"])` | one of the strings; the field type is their union |
| `is.object(Dto)` | a nested DTO, validated recursively |
| `is.array(is.string(), { min, max })` | an array of items matching another `is.*`; a lone value counts as a list of one |
| `is.file({ types, maxSize })` | one uploaded file |
| `is.files({ types, maxSize, min, max })` | several uploaded files under one name |
| `is.uuid({ version })` | a UUID string, lowercased; `version: 4` (or 7...) for one version |
| `is.email()` | an email address, trimmed. Loose on purpose: sending mail is the real test |
| `is.url({ protocols })` | an absolute URL, normalized. Only http and https unless you list others, so `javascript:` can't get in |
| `is.date()` | an ISO 8601 string or a Date, as a Date. Impossible dates (`2026-02-30`) are rejected, not rolled over |
| `is.custom(fn)` | whatever `fn(value)` returns; throw to reject |

Every one takes `optional`, `transform` and `validate`. Outside a request, [parse(Dto, raw)](api:yerd.parse) validates a value and [dto(Dto)](api:yerd.dto) turns a DTO into a transform.

The format decorators hand you clean, typed values:

```tsx
import { is } from "@toyz/yerd";

class ReturnRequest {
  @is.uuid({ version: 4 }) orderId!: string; // " 3F2504E0-4F89-41D3-9A0C-0305E82C3301 " arrives lowercased and trimmed
  @is.email() email!: string; // trimmed
  @is.date() delivered!: Date; // "2026-10-17" arrives as a Date (midnight UTC)
  @is.url({ optional: true }) photoLink?: string; // http(s) only, normalized: "HTTPS://Example.com" -> "https://example.com/"
}
```

- Failures name the format: `Expected a version 4 UUID`, `Expected an email address`, `Expected an ISO 8601 date`, `Expected a http or https URL`.
- A date with a time but no zone (`2026-10-17T09:30`) is read in the server's time zone; send a `Z` or offset when it matters.

### Your own types

`transform` runs after the type check, each step taking the previous one's output, so the last step sets the field's type. Throw from a step to reject with that message.

```tsx
import { is, trim, uuid } from "@toyz/yerd";

type Uuid = string & { readonly __brand: "Uuid" };

function toUuid(value: string): Uuid {
  if (uuid()(value) !== true) throw new Error("Not a valid id");
  return value.toLowerCase() as Uuid;
}

class Transfer {
  @is.string({ transform: [trim, toUuid] }) account!: Uuid;
  @is.number({ transform: (n: number) => Math.round(n * 100), validate: (cents: number) => cents > 0 || "Must be positive" }) cents!: number;
  @is.custom((v) => {
    if (typeof v !== "string" || !/^[A-Z]{3}$/.test(v)) throw new Error("Expected a currency code");
    return v;
  })
  currency!: string;
}
```

- `validate` runs on the transformed value. Mismatched steps or field types don't compile.
- `is.custom(fn)` takes the raw value, for input that isn't a string, number or boolean.
- For params and queries, [`uuid()`](api:yerd.uuid) and [`email()`](api:yerd.email) are validators: `@param("id", { validate: uuid() })`.

### Partial updates: PATCH

An optional field the client didn't send isn't on the instance at all (not even as `undefined`), so an all-optional DTO is a PATCH body that can't wipe unsent fields.

```tsx
import { NotFound, body, is, param, patch, route, toInt } from "@toyz/yerd";

class TodoChanges {
  @is.string({ optional: true }) title?: string;
  @is.boolean({ optional: true }) done?: boolean;
}

const todos = new Map([[1, { id: 1, title: "milk", done: false }]]);

@route("/api/todos/:id")
export class TodoItem {
  @param("id", { transform: toInt }) accessor id!: number;
  @body(TodoChanges) accessor changes!: Promise<TodoChanges>;

  @patch async update() {
    const todo = todos.get(this.id);
    if (!todo) return new NotFound("No such todo");
    Object.assign(todo, await this.changes); // `{ "done": true }` changes done, keeps title
    return todo;
  }
}
```

A route can declare one `@body` per shape (`TodoChanges` for PATCH, `TodoReplacement` for PUT); only the one a handler awaits is validated.

## The body is a promise

`@body`, `@field`, `@file` and `@files` fields hold promises. Nothing is read until something awaits one, and all reads in a request share one parse.

Without a DTO, `@body()` parses by content type:

| Content type | Value |
| --- | --- |
| `application/json` (or `+json`) | The parsed JSON. |
| `application/x-www-form-urlencoded` | An object of strings; repeated keys become arrays. |
| `multipart/form-data` | The fields, with files next to them as `File` objects. |
| `text/*` | A string. |
| anything else | A `Uint8Array`. |
| no body | `undefined` (or 400 with `required: true`). |

`@field` reads one field from URL-encoded or multipart forms, or a top-level string, number or boolean of a JSON object:

```tsx
import { field, lower, matches, post, route, trim } from "@toyz/yerd";

@route("/subscribe")
export class Subscribe {
  @field("email", { transform: [trim, lower], validate: matches(/@/), required: true }) accessor email!: Promise<string>;
  @field("source") accessor source!: Promise<string | undefined>;

  @post async save() {
    return { email: await this.email, source: (await this.source) ?? "direct" };
  }
}
```

## Method parameters with @args

TC39 has no parameter decorators, so [`@args`](api:yerd.args) lists a method's values; the same factories work, and promises are awaited for you.

```tsx
import { args, body, is, length, param, patch, query, route, toBool, toInt } from "@toyz/yerd";

class Patch {
  @is.string({ optional: true, validate: length(1, 140) }) title?: string;
  @is.boolean({ optional: true }) done?: boolean;
}

@route("/todos/:id")
export class TodoApi {
  @patch
  @args(param("id", { transform: toInt }), query("dry", { transform: toBool }), body(Patch))
  update(id: number, dry: boolean | undefined, changes: Patch) {
    return { id, dry: dry ?? false, changes: { ...changes } };
  }
}
```

- Parameter types are checked: `id: string` here won't compile.
- Use `@args` for values one handler needs, accessors for values the class shares.

## Uploads

`@file` and `@files` read `multipart/form-data` uploads as standard `File` objects.

```tsx
import { file, files, post, route } from "@toyz/yerd";

@route("/avatar")
export class Avatar {
  @file("avatar", { required: true, types: ["image/png", "image/jpeg"], maxSize: 2_000_000 }) accessor avatar!: Promise<File>;
  @files("extras", { types: ["image/*"] }) accessor extras!: Promise<File[]>;

  @post async upload() {
    const avatar = await this.avatar;
    return { name: avatar.name, bytes: avatar.size, extras: (await this.extras).length };
  }
}
```

| Option | Effect |
| --- | --- |
| `required` | 400 when no file was sent. Also narrows `@file`'s type to `Promise<File>`. |
| `maxSize` | Bytes; a bigger file is a 413. |
| `types` | Mime types, `image/*` wildcards allowed; anything else is a 415. |

An empty file input counts as no file. In a DTO, use `is.file` and `is.files` next to ordinary fields:

```tsx
class Profile {
  @is.string() name!: string;
  @is.file({ types: ["image/*"], maxSize: 2_000_000, optional: true }) avatar?: File;
  @is.files({ optional: true, max: 3 }) attachments?: File[];
}
```

> [!WARNING]
> The whole body is capped by the app's `bodyLimit` (1 MiB by default; bigger is a 413 before your code runs). Raise it for uploads: `yerd({ bodyLimit: 10 * 1024 * 1024 })`. `maxSize` can't raise it.

## Signal and session

The stock feed stays open until the visitor leaves. [@signal](api:yerd.signal) aborts when the client goes away or the server shuts down; pass it to anything long or slow.

```tsx
// src/routes/products.tsx
@route("/products/:id/stock", { session: false })
export class StockFeed {
  @inject(Catalog) accessor catalog!: Catalog;
  @inject(Channels) accessor channels!: Channels;
  @param("id", { transform: toInt }) accessor id!: number;
  @signal accessor stop!: AbortSignal;

  @get @sse feed() {
    this.catalog.find(this.id); // a 404 before the stream starts
    return this.channels.subscribe(stockChannel(this.id), this.stop);
  }
}
```

[@session](api:yerd.session) reads the session; given a class, it's a typed view with methods and defaults. The product page's cart is `@session(Cart) accessor cart!: Session<Cart>`. See [sessions and auth](09-sessions-and-auth.md).

## Your own accessors

[createAccessor](api:yerd.createAccessor) turns a function of the request context into a decorator for accessor fields and `@args`; the built-ins are made the same way.

```tsx
import { NotFound, createAccessor, get, route } from "@toyz/yerd";
import { findTenant, type Tenant } from "./tenants.js";

/** The visitor's first choice from Accept-Language, or undefined (then the field's initializer). */
export const language = createAccessor((ctx) => ctx.headers["accept-language"]?.split(/[,;]/)[0]?.trim() || undefined, { name: "language" });

/** The tenant this request is for, from the subdomain (acme.example.com). A 404 if there's none. */
export const tenant = createAccessor(
  async (ctx): Promise<Tenant> => {
    const found = await findTenant(ctx.url.hostname.split(".")[0] ?? "");
    if (!found) throw new NotFound("No such tenant");
    return found;
  },
  { name: "tenant" },
);

/** A numeric path param, checked at boot: the route must have it. */
export const idParam = createAccessor(
  (ctx, name: string) => {
    const id = Number(ctx.params[name]);
    if (!Number.isSafeInteger(id) || id < 1) throw new NotFound();
    return id;
  },
  { name: "idParam", validate: (route, name) => (route.paramNames.includes(name) ? undefined : `${route.pattern} has no :${name}`) },
);

@route("/products/:id")
export class Product {
  @language accessor lang = "en"; // missing header: the initializer
  @tenant accessor tenant!: Promise<Tenant>;
  @idParam("id") accessor id!: number;

  @get async show() {
    const { name } = await this.tenant;
    return { tenant: name, product: this.id, lang: this.lang };
  }
}
```

- The function runs at most once per request per decorator and argument list, on first read.
- Returning `undefined` uses the field's initializer; throwing (a `YerdError`, say) answers the request, like a guard.
- Arguments after `ctx` become the decorator's arguments. `validate` runs at boot for every route that uses it; return a message to stop the boot.
- The field's type is checked against the return type.
- They also work on services (see [request data in a service](08-services.md#request-data-in-a-service)).

For lower-level work, `currentContext()` gives the same context anywhere in a request, and [readBody](api:yerd.readBody) parses a raw `IncomingMessage` like `@body` does.

## Method and class decorators

The same kit makes method and class decorators that store a value you read back later; yerd's own `@get`, `@status`, `@catches`, `@prerender` and `@onBoot` are built this way.

```tsx
import { HttpStatus, classValue, get, methodFlag, methodList, methodValue, post, route } from "@toyz/yerd";

export const internal = methodFlag("internal");                   // @internal
export const summary = methodValue<string>("summary", {           // @summary("...")
  validate: (text) => (text.length <= 80 ? undefined : "keep it under 80 characters"),
});
export const tags = methodList<string>("tags");                   // @tags("a", "b"), stacks
export const feature = classValue<string>("feature");             // @feature("beta") on a class

@feature("beta")
@route("/reports")
export class Reports {
  @get @summary("List reports") @tags("reports") list() { return []; }
  @post @internal @tags("reports", "admin") rebuild() { return HttpStatus.NoContent; }
}
```

Read them by class (or its metadata), at startup or in tooling, or per request in a guard or middleware through `ctx.route.target` (the route class) and `ctx.route.method` (the handler or action serving the request):

```ts
summary.get(Reports, "list");     // "List reports"
tags.get(Reports, "rebuild");     // ["reports", "admin"]
internal.has(Reports, "rebuild"); // true
feature.get(Reports);             // "beta"

const routes = [Home, Reports].filter((cls) => feature.get(cls) !== "beta" || process.env.BETA === "1");
```

```ts
export const limit = methodValue<number>("limit");

export const underLimit = createGuard("underLimit", (ctx) => {
  const max = limit.get(ctx.route.target!, ctx.route.method!);
  return max === undefined || hitsThisMinute(ctx) < max || new TooManyRequests(undefined, { retryAfter: 60 });
});
```

For a decorator that changes what the method does, use [createMethodDecorator](api:yerd.createMethodDecorator) with `wrap`:

```ts
export const timed = createMethodDecorator("timed", {
  bare: true,
  wrap: (method, context) =>
    async function (this: unknown, ...args: unknown[]) {
      const started = performance.now();
      try {
        return await method.apply(this, args);
      } finally {
        log.info(`${String(context.name)} took ${Math.round(performance.now() - started)}ms`);
      }
    },
});
```

- `methodFlag`, `methodValue`, `methodList`; `classFlag`, `classValue`, `classList`. Lists read top to bottom; for values the top one wins.
- `validate` runs when the decorator is called; return a message to refuse the value.
- `bare: () => value` makes a value decorator work uncalled too: `@cache` and `@cache(300)`.
- Only public instance methods are accepted (`anyMember: true` on createMethodDecorator allows static and `#private`, for wrappers).
- A subclass sees its parent's entries and adds its own; the parent's stay as they were.

## When input is bad

yerd answers bad input before (or while) your handler reads it.

| Problem | Response |
| --- | --- |
| A transform or validator rejects a value | 400 with its message, e.g. `Expected an integer, got "abc"` |
| A `required` value is missing | 400, e.g. `Missing required query parameter: q` |
| A DTO doesn't validate | 400 JSON listing every issue |
| Malformed JSON or multipart | 400 |
| Body over `bodyLimit`, or a file over `maxSize` | 413 |
| A file of the wrong type | 415 |
| `@param` names a param the path doesn't have | The app refuses to boot |

A failed DTO reports every problem at once, each with a path: the checkout's [answer above](#bodies-and-dto-classes). Nested fields read `address.city`, list items `tags[1]`.

- Browsers get your [error page](04-responses.md) instead, when the app has one.
- For form messages, catch the [`YerdError`](api:yerd.YerdError) and read `error.details.issues`; the [interactivity guide](06-interactivity.md) shows the pattern.
