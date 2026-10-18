# Streaming and live

This page covers responses that keep going: streamed bodies, NDJSON and Server-Sent Events, streamed uploads, channels for live updates, and what happens when clients leave or the server stops.

## Return an async iterable

A handler can return any async iterable, usually an async generator, and yerd streams each chunk as it's produced. Strings and bytes go out as they are; anything else is turned into a string.

```ts
import { get, route } from "@toyz/yerd";

@route("/export.csv")
export class Export {
  @get async *csv() {
    yield "id,name\n";
    for (let id = 1; id <= 100_000; id++) yield `${id},user ${id}\n`;
  }
}
```

This is sent as `text/plain`, and headers go out with the first chunk. Use `res(stream, { headers: { "content-type": "text/csv" } })` to set your own type (see [responses](04-responses.md)). For a feed that may sit quiet for a while, use `@ndjson` or `@sse` below: they send headers right away.

HTML pages stream too: an async component is awaited in place while everything above it is already on its way (see [pages and layouts](05-pages-and-layouts.md#components)).

## NDJSON

Newline-delimited JSON is one JSON value per line. Put [@ndjson](api:yerd.ndjson) on a generator method and yield objects.

```ts
import { get, ndjson, route } from "@toyz/yerd";

@route("/rows.ndjson")
export class Rows {
  @get @ndjson async *list() {
    for (let id = 1; id <= 3; id++) yield { id };
  }
}
```

```sh
$ curl -N localhost:3000/rows.ndjson
{"id":1}
{"id":2}
{"id":3}
```

Pass options to the decorator, `@ndjson({ heartbeat: 15_000 })`, or call `ndjson(source, options)` to return a stream from an ordinary method:

| Option | Default | Does |
|---|---|---|
| `heartbeat` | `0` (off) | writes an empty line every N ms while the source is quiet, so proxies keep the connection open |
| `errorLine` | `true` | if the source throws mid-stream, writes a last line `{"error": "..."}` before closing |

## Server-Sent Events

[@sse](api:yerd.sse) works the same way and speaks `text/event-stream`, which browsers read with `EventSource`. Plain values become `data:` (non-strings as JSON); [event](api:yerd.event) sends a named event with an id.

```ts
import { event, get, route, sse } from "@toyz/yerd";

@route("/events")
export class Events {
  @get @sse async *feed() {
    yield "hello";                                             // data: hello
    yield { online: 3 };                                       // data: {"online":3}
    yield event({ event: "user", id: "7", data: { name: "ada" } });
  }
}
```

```ts
// in the browser
const source = new EventSource("/events");
source.onmessage = (e) => console.log(e.data);                 // unnamed messages
source.addEventListener("user", (e) => console.log(e.data));   // event: user
```

| Option | Default | Does |
|---|---|---|
| `heartbeat` | `15000` | sends a `: ping` comment every N ms while quiet |
| `retry` | none | sends a reconnect delay hint (ms) once at the start |
| `errorEvent` | `true` | if the source throws, sends `event: error` with the message before closing |

`event()` also takes `retry` and `comment`. To refresh a page's Regions on every message, point `data-yx-live` at an SSE route (see [interactivity](06-interactivity.md#live-refresh)).

### Errors mid-stream

Once a stream has started, its status is already sent, so a thrown error becomes the last line or event instead. An [HttpError](api:yerd.HttpError)'s message is shown as is; anything else is logged and sent as `Internal Server Error`, so internals don't leak.

## Streamed request bodies

[ndjsonBody](api:yerd.ndjsonBody) reads an NDJSON upload line by line as it arrives, optionally validating each line with a DTO. Only each line is size-limited, not the whole upload.

```ts
import { args, is, ndjsonBody, post, route } from "@toyz/yerd";

class Row {
  @is.int() id!: number;
  @is.string() name!: string;
}

@route("/import")
export class Import {
  @post
  @args(ndjsonBody(Row))
  async run(rows: AsyncIterable<Row>) {
    let count = 0;
    for await (const row of rows) count += row.id > 0 ? 1 : 0;
    return { imported: count };
  }
}
```

A bad line ends the request with a 400 that names it: `Line 2 is not valid JSON`, or `Line 2 failed validation` plus the issues as JSON. Without a DTO, you get the parsed values as `unknown`. The same stream is available as `currentContext().lines()`; a body can be read whole or streamed, not both.

## Channels

[Channels](api:yerd.Channels) is a built-in pub/sub hub: publish to a name from anywhere, subscribe from a stream route. Name channels with [channel](api:yerd.channel)`<T>()`, so messages are type-checked.

```ts
import { Channels, channel, get, inject, route, service, signal, sse } from "@toyz/yerd";

interface ChatMessage { from: string; text: string }

// A family of channels: one per room.
export const room = (id: string) => channel<ChatMessage>(`room:${id}`);

@service
export class Chat {
  @inject(Channels) accessor channels!: Channels;

  async say(roomId: string, message: ChatMessage) {
    await this.channels.publish(room(roomId), message); // type-checked
  }
}

@route("/rooms/lobby/events")
export class LobbyEvents {
  @inject(Channels) accessor channels!: Channels;
  @signal accessor stop!: AbortSignal;

  @get @sse feed() {
    return this.channels.subscribe(room("lobby"), this.stop);
  }
}
```

- `subscribe(targets, signal, { buffer })` takes one channel or an array, and ends when `signal` aborts.
- It subscribes immediately, so nothing published between the call and the first read is lost.
- Each subscriber has its own queue. A slow one keeps up to `buffer` messages (1000 by default); past that the oldest are dropped, with a warning.
- Plain strings work as names too: `publish("todos", msg)`.
- Channels push to open browser tabs. For work that should happen once per change on the server (send a mail, update a cache), use [events](14-events.md); an `@on` handler can publish to a channel when it's done.

> [!NOTE]
> The default backend is in-memory, so messages reach subscribers in the same process only. For several instances, implement [ChannelBackend](api:yerd.ChannelBackend) (Redis, NATS, Postgres `LISTEN`) and register it: `app.services((s) => s.value(ChannelBackend, myBackend))`. See [services](08-services.md).

## Per-user live feeds

Give each user their own channel, publish after every write, and subscribe with the signed-in user's id. Nobody hears anyone else's changes.

```tsx
import { Channels, channel, get, inject, route, signal, sse } from "@toyz/yerd";
import { auth, type User } from "./users.js"; // createAuth(...), see 09-sessions-and-auth.md

type TodoChange = { type: "added" | "removed"; id: string };
export const todoChannel = (userId: string) => channel<TodoChange>(`todos:${userId}`);

// after a write, in a service or action:
//   await this.channels.publish(todoChannel(owner.id), { type: "added", id });

@route("/todos/events", { guards: [auth.required] })
export class TodoEvents {
  @inject(Channels) accessor channels!: Channels;
  @auth.user accessor me!: User;
  @signal accessor stop!: AbortSignal;

  @get @sse feed() {
    return this.channels.subscribe(todoChannel(this.me.id), this.stop);
  }
}

// in the app layout: every open tab refreshes its Regions on each change
const liveHook = <div data-yx-live="/todos/events" hidden></div>;
```

You can transform messages on the way out with a generator: `for await (const change of this.channels.subscribe(...)) yield { ...change, at: Date.now() };`.

## Disconnects and the "pass the signal" rule

When a client goes away, the request's signal aborts (inject it with [@signal](api:yerd.signal)) and yerd calls `return()` on your generator, so its `finally` blocks run. Graceful shutdown ends streams the same way.

There's one JavaScript catch: a generator parked at an `await` only stops once that await settles. If it's waiting on something slow, the cleanup waits too. So pass the signal to whatever you wait on:

```ts
import { setInterval } from "node:timers/promises";
import { get, route, signal, sse } from "@toyz/yerd";

@route("/clock")
export class Clock {
  @signal accessor stop!: AbortSignal;

  @get @sse async *ticks() {
    try {
      // The signal ends the wait at once instead of after the next tick.
      for await (const _ of setInterval(1000, undefined, { signal: this.stop })) {
        yield { now: new Date().toISOString() };
      }
    } catch (error) {
      if (!this.stop.aborted) throw error; // a disconnect isn't an error
    } finally {
      console.log("client left");
    }
  }
}
```

- `Channels.subscribe(name, signal)` already does this: it ends cleanly the moment the signal aborts.
- Pass the signal to `fetch(url, { signal })`, `node:timers/promises` timers, database cursors and queues.
- Signal-aware APIs throw an `AbortError` when cancelled. Catch it as above, or yerd logs it as a failed stream.

## Graceful shutdown

On `SIGINT` or `SIGTERM`, or when you call `close()` on the [RunningServer](api:yerd.RunningServer) that `app.listen()` returned, yerd shuts down in order:

1. Stops accepting connections.
2. Aborts every `@sse` and `@ndjson` stream, so their generators finish.
3. Waits for in-flight requests, up to `shutdownTimeout` (10 seconds by default), then cuts what's left.
4. Stops background work and disposes services (see [services](08-services.md)).

```ts
import { yerd } from "@toyz/yerd";

const app = yerd({ shutdownTimeout: 5_000 });
const server = await app.listen(3000);
// later, e.g. in a test:
await server.close();
```

> [!WARNING]
> Only `@sse` and `@ndjson` streams count as long-lived. A plain async iterable that never ends keeps shutdown waiting until the timeout. Use `ndjson()`/`sse()` for endless feeds, or end your loop when the signal aborts.

Pass `handleSignals: false` to `yerd()` or `listen()` when you want to handle signals yourself. Deployment details are in [deploying](11-deploying.md).
