# Request data

This page covers reading params, query strings, headers, cookies, bodies, forms and uploads, and validating all of them.

## Accessors

Request data arrives on decorated `accessor` fields. Each decorator says where the value comes from.

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

When a value is missing, the field's initializer is used (`page = 1`, `theme = "light"`). With `required: true`, a missing value is a 400 instead.

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

The types shown are before transforms: a transform changes the field type to whatever it returns.

> [!NOTE]
> These values belong to the current request, not to the instance, so they're correct whatever the route's lifetime. Each one is resolved once per request, and assigning to the field throws.

## Transforms and validators

Every name-based accessor takes the same options object.

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

> [!WARNING]
> Inline validators need their parameter annotated: `(n: number) => ...`, not `(n) => ...`. Without the annotation the parameter is an implicit `any`, which strict mode rejects.

The pipeline is type-checked. `[toInt, trim]` is a compile error because `trim` doesn't take a number, and so is `@query("n", { transform: toInt }) accessor n = "x"`, because a number won't fit a string field.

Built-in transforms (throw a 400 on bad input):

| Transform | Output |
| --- | --- |
| [`toInt`](api:yerd.toInt) | A safe integer. `"12"` yes, `"1.5"` and `"abc"` no. |
| [`toNumber`](api:yerd.toNumber) | Any number. |
| [`toBool`](api:yerd.toBool) | `"true"`, `"1"` or `""` are true; `"false"` or `"0"` are false. |
| [`trim`](api:yerd.trim) / [`lower`](api:yerd.lower) | The trimmed / lowercased string. |
| [`oneOf("a", "b")`](api:yerd.oneOf) | One of the listed strings; the type is their union. |

Built-in validators (return a message on failure):

| Validator | Accepts |
| --- | --- |
| [`between(min, max)`](api:yerd.between) | Numbers from `min` to `max`, inclusive. |
| [`length(min, max?)`](api:yerd.length) | Strings or arrays with a length in range; `max` defaults to unlimited. |
| [`matches(regex, message?)`](api:yerd.matches) | Strings matching the pattern. |

Writing your own is just writing a function. A transform returns the new value and throws an [`HttpError`](api:yerd.HttpError) to reject; a validator returns `true`, `false` (generic 400) or a string (400 with that message).

```ts
import { HttpError, type Transform } from "@toyz/yerd";

export const slug: Transform<string, string> = (raw) => {
  if (!/^[a-z0-9-]+$/.test(raw)) throw new HttpError(400, `Not a slug: ${raw}`);
  return raw;
};
```

## Bodies and DTO classes

Validate a body by declaring a class whose fields use [`is.*`](api:yerd.is) decorators, then pass the class to `@body`. You get a real instance of that class back.

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

DTO fields are plain fields, not accessors. The rules:

- A field without `optional: true` and without an initializer is required. Initializers double as defaults (`plan` above).
- Keys the class doesn't declare are dropped, so a client can't sneak in `isAdmin: true`.
- `is.int`, `is.number` and `is.boolean` also accept their string forms (`"42"`, `"true"`, `"on"`), so the same DTO works for JSON and HTML forms.
- A decorator that doesn't match the field's declared type is a compile error.

The `is.*` decorators:

| Decorator | Value |
| --- | --- |
| `is.string()` / `is.int()` / `is.number()` / `is.boolean()` | The primitive. |
| `is.oneOf(["a", "b"])` | One of the strings; the field type is their union. |
| `is.object(Dto)` | A nested DTO, validated recursively. |
| `is.array(is.string(), { min, max })` | An array of items matching another `is.*`. A lone value counts as a list of one. |
| `is.file({ types, maxSize })` | One uploaded file. |
| `is.files({ types, maxSize, min, max })` | Several uploaded files under one name. |
| `is.custom(fn)` | Whatever `fn(value)` returns; throw to reject. |

Every one takes `optional`, `transform` (same type in and out) and `validate`. Outside a request, [`parse(Dto, raw)`](api:yerd.parse) validates a value and [`dto(Dto)`](api:yerd.dto) gives you a transform for any `transform` option.

## The body is a promise

Reading a body is async, so `@body`, `@field`, `@file` and `@files` fields hold promises. Nothing is read until something awaits the field, and every read in a request shares one parse.

Without a DTO, `@body()` gives you the parsed body by content type:

| Content type | Value |
| --- | --- |
| `application/json` (or `+json`) | The parsed JSON. |
| `application/x-www-form-urlencoded` | An object of strings; repeated keys become arrays. |
| `multipart/form-data` | The fields, with files next to them as `File` objects. |
| `text/*` | A string. |
| anything else | A `Uint8Array`. |
| no body | `undefined` (or 400 with `required: true`). |

For one form field, `@field` is simpler. It reads URL-encoded and multipart forms, and top-level strings, numbers and booleans of a JSON object:

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

TC39 decorators have no parameter decorators, so [`@args`](api:yerd.args) lists the values on the method instead. The same factories work here, and promises are awaited for you.

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

The parameter types are checked against the resolvers: declare `id: string` here and it won't compile. Use `@args` for values only one handler needs, and accessors for values the whole class shares.

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

An empty file input counts as no file. Uploads also work inside a DTO with `is.file` and `is.files`, next to ordinary fields:

```tsx
import { body, is, post, route } from "@toyz/yerd";

class Profile {
  @is.string() name!: string;
  @is.file({ types: ["image/*"], maxSize: 2_000_000, optional: true }) avatar?: File;
  @is.files({ optional: true, max: 3 }) attachments?: File[];
}

@route("/profile")
export class ProfileApi {
  @body(Profile) accessor profile!: Promise<Profile>;

  @post async save() {
    const p = await this.profile;
    return { name: p.name, avatar: p.avatar?.name ?? null, attachments: p.attachments?.length ?? 0 };
  }
}
```

> [!WARNING]
> The whole body is capped by the app's `bodyLimit`, 1 MiB by default, and anything bigger is a 413 before your code runs. Raise it for uploads: `yerd({ bodyLimit: 10 * 1024 * 1024 })`. `maxSize` limits one file; it can't raise the body limit.

## Signal and session

[`@signal`](api:yerd.signal) aborts when the client goes away or the server shuts down. Pass it to anything slow:

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

[`@session`](api:yerd.session) gives you the session once the app calls `.sessions()`. Session keys are typed by declaring them on `SessionData`; the [sessions and auth guide](09-sessions-and-auth.md) has the full story.

```tsx
import { get, route, session, type Session } from "@toyz/yerd";

declare module "@toyz/yerd" {
  interface SessionData { visits?: number }
}

@route("/visits")
export class Visits {
  @session accessor session!: Session;

  @get count() {
    const n = (this.session.get("visits") ?? 0) + 1;
    this.session.set("visits", n);
    return { visits: n };
  }
}
```

## When input is bad

You don't write error handling for bad input: yerd answers before (or while) your handler reads the value.

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
  "issues": [
    { "path": "email", "message": "That is not an email" },
    { "path": "age", "message": "Expected a number from 13 to 120, got 7" },
    { "path": "address.city", "message": "Expected a length of at least 1, got 0" },
    { "path": "tags[1]", "message": "Expected a string" }
  ]
}
```

Browsers get your error page instead when the app has one (see [responses](04-responses.md)). To turn issues into form messages, catch the [`HttpError`](api:yerd.HttpError) and read `error.details.issues`; the [interactivity guide](06-interactivity.md) shows the pattern for forms.
