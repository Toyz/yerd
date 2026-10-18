# Request data

Reading and validating params, query strings, headers, cookies, bodies, forms and uploads.

## Accessors

Request data arrives on decorated `accessor` fields; each decorator says where the value comes from.

```tsx
import { between, cookie, get, header, query, route, toInt, trim } from "@toyz/yerd";

@route("/search")
export class Search {
  @query("q", { transform: trim, required: true }) accessor q!: string;
  @query("page", { transform: toInt, validate: between(1, 100) }) accessor page = 1;
  @header("accept-language") accessor lang: string | undefined;
  @cookie("theme") accessor theme = "light";

  @get results() {
    return { q: this.q, page: this.page, lang: this.lang, theme: this.theme };
  }
}
```

A missing value falls back to the field's initializer (`page = 1`), or is a 400 with `required: true`.

| Decorator | Reads | Field type |
| --- | --- | --- |
| [`@param(name, opts)`](api:yerd.param) | A path parameter | `string` |
| [`@params`](api:yerd.params) | All path parameters | `Record<string, string>` |
| [`@query(name, opts)`](api:yerd.query) | First value of a query parameter | `string \| undefined` |
| [`@header(name, opts)`](api:yerd.header) | A header (repeats joined with `", "`) | `string \| undefined` |
| [`@cookie(name, opts)`](api:yerd.cookie) | A request cookie | `string \| undefined` |
| [`@body(Dto or opts)`](api:yerd.body) | The parsed body | `Promise<...>` |
| [`@field(name, opts)`](api:yerd.field) | One form field | `Promise<string \| undefined>` |
| [`@file(name, opts)`](api:yerd.file) | The first uploaded file under a name | `Promise<File \| undefined>` |
| [`@files(name, opts)`](api:yerd.files) | Every file under a name | `Promise<File[]>` |
| [`@signal`](api:yerd.signal) | Aborts when the client disconnects | `AbortSignal` |
| [`@session`](api:yerd.session) | The session (needs `app.sessions()`) | `Session` |
| [`@request`](api:yerd.request) | The raw Node `IncomingMessage` | `IncomingMessage` |

- Types shown are before transforms; a transform changes the field type to what it returns.
- Values belong to the current request, whatever the route's lifetime. Each is resolved once per request, and assigning to the field throws.

## Transforms and validators

Every name-based accessor takes the same options.

| Option | Type | Applies to | What it does |
| --- | --- | --- | --- |
| `transform` | function or array | all | Converts the raw string. An array runs left to right. Skipped when the value is missing. |
| `validate` | function or array | all | Checks the transformed value. Runs in order. |
| `required` | `boolean` | all but `@param` | Missing means 400 instead of the initializer. |

```tsx
import { get, lower, oneOf, param, query, route, toBool, toInt, trim } from "@toyz/yerd";

@route("/users/:id")
export class UserPage {
  @param("id", { transform: toInt, validate: (n: number) => n > 0 || "ids start at 1" }) accessor id!: number;
  @query("verbose", { transform: toBool }) accessor verbose = false;
  @query("sort", { transform: [trim, lower, oneOf("new", "top")] }) accessor sort: "new" | "top" = "new";

  @get show() {
    return { id: this.id, verbose: this.verbose, sort: this.sort };
  }
}
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

Declare a class with [`is.*`](api:yerd.is) decorated fields and pass it to `@body`; you get a validated instance of that class.

```tsx
import { between, body, is, length, lower, matches, post, route, trim } from "@toyz/yerd";

class Address {
  @is.string({ transform: trim, validate: length(1) }) city!: string;
  @is.string({ optional: true }) zip?: string;
}

class Signup {
  @is.string({ transform: [trim, lower], validate: matches(/@/, "That is not an email") }) email!: string;
  @is.int({ validate: between(13, 120) }) age!: number;
  @is.oneOf(["free", "pro"]) plan: "free" | "pro" = "free";
  @is.boolean({ optional: true }) newsletter?: boolean;
  @is.object(Address, { optional: true }) address?: Address;
  @is.array(is.string({ transform: trim }), { optional: true, max: 5 }) tags?: string[];
}

@route("/signup")
export class SignupApi {
  @body(Signup) accessor signup!: Promise<Signup>;

  @post async create() {
    const s = await this.signup;
    return { email: s.email, plan: s.plan };
  }
}
```

- DTO fields are plain fields, not accessors.
- A field without `optional: true` or an initializer is required. Initializers are defaults (`plan`).
- Undeclared keys are dropped, so a client can't sneak in `isAdmin: true`.
- `is.int`, `is.number` and `is.boolean` accept string forms (`"42"`, `"on"`), so one DTO serves JSON and HTML forms.
- A decorator that doesn't match the field's type is a compile error.

| Decorator | Value |
| --- | --- |
| `is.string()` / `is.int()` / `is.number()` / `is.boolean()` | The primitive. |
| `is.oneOf(["a", "b"])` | One of the strings; the field type is their union. |
| `is.object(Dto)` | A nested DTO, validated recursively. |
| `is.array(is.string(), { min, max })` | An array of items matching another `is.*`. A lone value counts as a list of one. |
| `is.file({ types, maxSize })` | One uploaded file. |
| `is.files({ types, maxSize, min, max })` | Several uploaded files under one name. |
| `is.uuid({ version })` | A UUID string, lowercased; `version: 4` (or 7...) for one version. |
| `is.email()` | An email address, trimmed. Loose on purpose: sending mail is the real test. |
| `is.url({ protocols })` | An absolute URL, normalized. Only http and https unless you list others, so `javascript:` can't get in. |
| `is.date()` | An ISO 8601 string or a Date, as a Date. Impossible dates (`2026-02-30`) are rejected, not rolled over. |
| `is.custom(fn)` | Whatever `fn(value)` returns; throw to reject. |

Every one takes `optional`, `transform` and `validate`. Outside a request, [`parse(Dto, raw)`](api:yerd.parse) validates a value and [`dto(Dto)`](api:yerd.dto) turns a DTO into a transform.

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
import { body, is, param, patch, route, toInt } from "@toyz/yerd";

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
    if (!todo) return 404;
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

[`@signal`](api:yerd.signal) aborts when the client goes away or the server shuts down; pass it to anything slow.

```tsx
import { get, route, signal } from "@toyz/yerd";

@route("/slow")
export class Slow {
  @signal accessor stop!: AbortSignal;

  @get async page() {
    const r = await fetch("https://example.com", { signal: this.stop });
    return r.text();
  }
}
```

[`@session`](api:yerd.session) is covered in [sessions and auth](09-sessions-and-auth.md).

## Your own accessors

[createAccessor](api:yerd.createAccessor) turns a function of the request context into a decorator for accessor fields and `@args`; the built-ins are made the same way.

```tsx
import { NotFound, createAccessor, get, route } from "@toyz/yerd";
import { findShop, type Shop } from "./shops.js";

/** The visitor's first choice from Accept-Language, or undefined (then the field's initializer). */
export const language = createAccessor((ctx) => ctx.headers["accept-language"]?.split(/[,;]/)[0]?.trim() || undefined, { name: "language" });

/** The shop this request is for, from the subdomain (acme.example.com). A 404 if there's none. */
export const shop = createAccessor(
  async (ctx): Promise<Shop> => {
    const found = await findShop(ctx.url.hostname.split(".")[0] ?? "");
    if (!found) throw new NotFound("No such shop");
    return found;
  },
  { name: "shop" },
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
  @shop accessor shop!: Promise<Shop>;
  @idParam("id") accessor id!: number;

  @get async show() {
    const { name } = await this.shop;
    return { shop: name, product: this.id, lang: this.lang };
  }
}
```

- The function runs at most once per request per decorator and argument list, on first read.
- Returning `undefined` uses the field's initializer; throwing (a `YerdError`, say) answers the request, like a guard.
- Arguments after `ctx` become the decorator's arguments. `validate` runs at boot for every route that uses it; return a message to stop the boot.
- The field's type is checked against the return type.
- They also work on services (see [request data in a service](08-services.md#request-data-in-a-service)).

For lower-level work, `currentContext()` gives the same context anywhere in a request, and [readBody](api:yerd.readBody) parses a raw `IncomingMessage` like `@body` does.

## When input is bad

yerd answers bad input before (or while) your handler reads it.

| Problem | Response |
| --- | --- |
| A transform or validator rejects a value | 400 with its message, e.g. `Expected an integer, got "abc"` |
| A `required` value is missing | 400, e.g. `Missing required query parameter: q` |
| A DTO doesn't validate | 400 JSON listing every issue (below) |
| Malformed JSON or multipart | 400 |
| Body over `bodyLimit`, or a file over `maxSize` | 413 |
| A file of the wrong type | 415 |
| `@param` names a param the path doesn't have | The app refuses to boot |

A failed DTO reports every problem at once, each with a path:

```json
{
  "error": "Validation failed",
  "code": "validation_failed",
  "issues": [
    { "path": "email", "message": "That is not an email" },
    { "path": "age", "message": "Must be from 13 to 120 (got 7)" },
    { "path": "address.city", "message": "Can't be empty" },
    { "path": "tags[1]", "message": "Expected a string" }
  ]
}
```

- Browsers get your [error page](04-responses.md) instead, when the app has one.
- For form messages, catch the [`YerdError`](api:yerd.YerdError) and read `error.details.issues`; the [interactivity guide](06-interactivity.md) shows the pattern.
