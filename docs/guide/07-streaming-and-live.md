# Streaming and live

Every open product page shows the stock as it drops: a Server-Sent Events feed per product, fed by a channel.

## Server-Sent Events

The product page listens on a feed with `data-yx-live` ([Interactivity](06-interactivity.md#live-refresh)). The feed is an [@sse](api:yerd.sse) route whose handler returns the product channel's subscription:

```ts
// src/routes/products.tsx
/** The product page's live feed: a message per stock change. No session needed for a stream. */
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

The headers go out at once; a message follows when someone buys a notebook:

```answer
GET /products/7/stock
200 OK
content-type: text/event-stream; charset=utf-8
cache-control: no-cache, no-transform

data: {"id":7,"stock":11}
---
GET /products/99/stock
404 Not Found
content-type: application/json; charset=utf-8

{"error":"No product 99","code":"not_found","id":99}
```

- Plain values become `data:` lines, non-strings as JSON. [event](api:yerd.event)`({ event: "user", id: "7", data })` sends a named event, and also takes `retry` and `comment`.
- Browsers read the stream with `EventSource`; `data-yx-live` does that for you and refreshes the page's Regions on each plain message.
- `@signal` is the request's [AbortSignal](#disconnects-and-the-pass-the-signal-rule): it ends the subscription when the tab closes.
- An error thrown before the handler returns (the 404 here) is an ordinary response.

## Channels

The catalog tells every open product page when stock changes. [Channels](api:yerd.Channels) is a built-in pub/sub hub: publish to a name from anywhere, subscribe from a stream route. [channel](api:yerd.channel)`<T>()` names one and types its messages:

```ts
// src/catalog.ts
/** One channel per product: its page listens for stock changes. */
export const stockChannel = (id: number) => channel<{ id: number; stock: number }>(`stock:${id}`);

@service
export class Catalog {
  @inject(Channels) accessor channels!: Channels;
  // ...

  /** Take sold items off the shelf and tell every open product page. */
  async take(id: number, qty: number): Promise<void> {
    const product = this.find(id);
    product.stock -= qty;
    await this.channels.publish(stockChannel(id), { id, stock: product.stock }); // type-checked
  }
}
```

- `subscribe(targets, signal, { buffer })` takes one channel or an array and ends when `signal` aborts. Nothing published after the call is missed.
- Each subscriber has its own queue; a slow one keeps up to `buffer` messages (1000), then drops the oldest with a warning.
- Plain strings work as names too: `publish("todos", msg)`.
- Channels push to open tabs. For work that should run once per change on the server, use [events](14-events.md).

> [!TAKE]
> The message says "the stock changed"; the page refetches and morphs its Regions. The server renders the new stock the way it rendered the page, so there's no client template to keep in step. You pay one page request per message, so for a firehose, send data and handle it in [client code](17-client-code.md).

> [!NOTE]
> The default backend is in-memory: same process only, and every subscriber gets the very object you published, so don't mutate it afterwards. For several instances, register an [EventTransport](14-events.md#several-instances-and-other-apps) (channels [ride on it](14-events.md#channels-ride-along)) or a [ChannelBackend](api:yerd.ChannelBackend) (Redis, NATS, Postgres `LISTEN`) with `app.services((s) => s.value(ChannelBackend, myBackend))`. A `ChannelBackend` wins over the transport.

## Return an async iterable

A stream is any handler that returns an async iterable, usually an async generator; yerd sends each item as it's produced. The decorator picks the format:

```ts tab="Plain"
@route("/rows")
export class Rows {
  @get async *rows() {
    for (let id = 1; id <= 3; id++) yield `${id}\n`;
  }
}
```

```answer
GET /rows
200 OK
content-type: text/plain; charset=utf-8

1
2
3
```

```ts tab="@ndjson"
@route("/rows")
export class Rows {
  @get @ndjson async *rows() {
    for (let id = 1; id <= 3; id++) yield { id };
  }
}
```

```answer
GET /rows
200 OK
content-type: application/x-ndjson; charset=utf-8
cache-control: no-cache, no-transform

{"id":1}
{"id":2}
{"id":3}
```

```ts tab="@sse"
@route("/rows")
export class Rows {
  @get @sse async *rows() {
    for (let id = 1; id <= 3; id++) yield { id };
  }
}
```

```answer
GET /rows
200 OK
content-type: text/event-stream; charset=utf-8
cache-control: no-cache, no-transform

data: {"id":1}

data: {"id":2}

data: {"id":3}
```

- Plain: strings and bytes go out as they are, anything else stringified, headers with the first chunk. Set your own type with `res(stream, { headers: { "content-type": "text/csv" } })` ([responses](04-responses.md)).
- [@ndjson](api:yerd.ndjson) and `@sse` send headers right away, so use them for a feed that may sit quiet. Return `ndjson(source, options)` or `sse(...)` from an ordinary method for the same thing.
- HTML pages stream too ([pages and layouts](05-pages-and-layouts.md#components)).

| Option | `@ndjson` | `@sse` | Does |
|---|---|---|---|
| `heartbeat` | `0` (off) | `15000` | while the source is quiet, every N ms an empty line / a `: ping` comment, so proxies keep the connection open; or `{ every, send }` ([custom heartbeats](#custom-heartbeats)) |
| `errorLine` / `errorEvent` | `true` | `true` | if the source throws mid-stream, a last `{"error": "..."}` line / `event: error` before closing |
| `retry` | | none | a reconnect delay hint (ms), once at the start |

Pass them as `@ndjson({ heartbeat: 15_000 })` or `@sse({ retry: 2000 })`.

### Custom heartbeats

Give the heartbeat a body with `{ every, send }` when clients should see it (to show "live", detect a stall, or carry a server time); the plain beat is invisible.

```tsx
// The same body every time.
@get @sse({ heartbeat: { every: 20_000, send: event({ event: "ping" }) } }) feed() { ... }

// A function makes each beat from its count, idle time and open time.
@get stats() {
  return ndjson(this.updates(), {
    heartbeat: { every: 10_000, send: ({ count, idleMs }) => ({ type: "keepalive", count, idleMs }) },
  });
}
```

- `send` is written like any stream item: for SSE an `event()` or a plain message, for NDJSON a JSON line. The function may return `undefined` for a plain beat.
- `idleMs` is the time since the last real item; `openMs` since the stream started. Beats only go out while the source is quiet.
- A bad interval (negative, `NaN`) is refused when the stream is created.

### Errors mid-stream

Once a stream has started its status is sent, so a thrown error becomes the last line or event. A [YerdError](api:yerd.YerdError)'s message is shown as is; anything else is logged and sent as `Internal Server Error`.

## Streamed request bodies

[ndjsonBody](api:yerd.ndjsonBody) reads an NDJSON upload line by line as it arrives, optionally validating each line with a DTO.

```ts
import { args, is, ndjsonBody, post, route } from "@toyz/yerd";

class StockRow {
  @is.int() id!: number;
  @is.int() stock!: number;
}

@route("/import")
export class Import {
  @post
  @args(ndjsonBody(StockRow))
  async run(rows: AsyncIterable<StockRow>) {
    let count = 0;
    for await (const row of rows) count += row.stock >= 0 ? 1 : 0;
    return { imported: count };
  }
}
```

- Only each line is size-limited, not the whole upload.
- A bad line ends the request with a 400 naming it (`Line 2 is not valid JSON`, or `Line 2 failed validation` plus the issues).
- Without a DTO, lines are `unknown`. The same stream is `currentContext().lines()`. A body can be read whole or streamed, not both.

## Per-user live feeds

Give each user their own channel, publish after every write, and subscribe with the signed-in user's id.

```tsx
import { Channels, channel, get, inject, route, signal, sse } from "@toyz/yerd";
import { auth, type User } from "./users.js";

export const orderChannel = (userId: string) => channel<{ orderId: number; status: string }>(`orders:${userId}`);

// after a write, in a service or action:
//   await this.channels.publish(orderChannel(order.userId), { orderId: order.id, status: "shipped" });

@route("/orders/events", { guards: [auth.required] })
export class OrderEvents {
  @inject(Channels) accessor channels!: Channels;
  @auth.user accessor me!: User;
  @signal accessor stop!: AbortSignal;

  @get @sse feed() {
    return this.channels.subscribe(orderChannel(this.me.id), this.stop);
  }
}

// in the layout: every open tab refreshes its Regions on each change
<div data-yx-live="/orders/events" hidden></div>
```

To transform messages on the way out, loop in a generator: `for await (const change of this.channels.subscribe(...)) yield { ...change, at: Date.now() };`.

## Server-synced animation

`sync` keeps looping CSS animations on the same beat on every open page; [Cues](api:yerd.Cues) plays one-off moments (an airhorn, confetti) everywhere at the same instant. Both run on the server's clock, and pages agree to within a few milliseconds.

### sync: one beat everywhere

Put `sync` on an element to line up its infinite CSS animations, and those inside it, as if they all started together.

```tsx
const bob = keyframes`50% { transform: translateY(-12px); }`;
const dancer = css`
  animation: ${bob} 700ms ease-in-out infinite;
  &:nth-child(odd) { animation-delay: -350ms; }
`;

<div class="crowd" sync>
  {gnomes.map((g) => <img class={dancer} src={g.photo} alt={g.name} />)}
</div>
```

- `animation-delay` still works, as an offset from the shared beat.
- Only infinite animations move; use a cue for one-off ones.
- Elements added later and class changes that start new animations are handled.

### Cues: one moment, every screen

Inject `Cues` and `play()` a cue by name; elements with `cue="name"` play it.

```tsx
const wobble = keyframes`25% { transform: rotate(-12deg) scale(1.3); } 75% { transform: rotate(10deg); }`;
const gnome = css`&[data-yx-cued] { animation: ${wobble} 600ms ease-out; }`;

@route("/rave")
export class Rave {
  @inject(Cues) accessor cues!: Cues;

  @action async airhorn() {
    await this.cues.play("airhorn", { room: "rave", lasts: 1200, cooldown: 700 });
  }

  @get page() {
    return (
      <main>
        <img class={gnome} src="/gnome.png" alt="" cue="airhorn" cueRoom="rave" />
        <audio src="/airhorn.mp3" cue="airhorn" cueRoom="rave" />
        <button action={this.airhorn}>Airhorn</button>
      </main>
    );
  }
}
```

When a cue plays, each element that names it:

1. Gets `data-yx-cued="<name>"`, removed and re-added so a CSS animation keyed off it restarts.
2. Plays from the shared position, if it's `<audio>` or `<video>`.
3. Dispatches a bubbling `yx:cue` event with `{ name, room, data, at, late }`. `preventDefault()` skips steps 1 and 2.

`cue` takes several names, space-separated or as an array: `cue={["airhorn", "drop"]}`.

| `play()` option | What it does |
| --- | --- |
| `room` | Which pages hear it: those whose `cueRoom` names it (`"main"` when none), or whose `cueFrom` route serves it. See [public and private rooms](#public-and-private-rooms). Default `"main"`. |
| `in` | How far ahead to schedule it, in ms or a duration (`"3s"`), so every page gets the message in time. Default 250. |
| `lasts` | How long it runs (ms or duration). A page connecting meanwhile starts it partway; `data-yx-cued` comes off at the end. |
| `cooldown` | Ignore plays of the same cue for this long (ms or duration); `play()` returns undefined for an ignored play. |
| `key` | What `cooldown` counts by instead of the name, e.g. `` `airhorn:${user.id}` `` for a per-person cooldown. |
| `data` | Anything JSON can carry, as `detail.data`. |

Sequences are several cues on one timeline:

```ts
@action async drop() {
  const counting = await this.cues.play("countdown", { lasts: 2500, cooldown: 7000 });
  if (counting) await this.cues.play("drop", { in: 2750, lasts: 4000 });
}
```

### Late, slow and hidden pages

A cue carries its start time on the server's clock, so arrival time doesn't matter:

- **Early:** the page waits for the moment.
- **Late** (slow link, background tab, opened mid-`lasts`): it plays at once, `late` ms in; CSS animations and media seek forward.
- **Past the end of `lasts`:** skipped.
- **Seen twice** (a reconnect replays running cues): plays once.

### Sound

Browsers block audio until the visitor interacts, so an `<audio cue>` on an untouched page stays quiet (the animation still plays). For Web Audio, start an `AudioContext` on the first click and play on `yx:cue`, skipping cues that arrive too `late`; the kitchen sink's [`horn` attribute](https://github.com/Toyz/yerd/blob/main/examples/kitchen-sink/src/attributes.tsx) does exactly that.

Your own client code can read the same clock: `yerd.clock.now()` is the server's time, and `yerd.clock.sync()` re-measures and resolves with `{ now, offset, rtt }`.

### Public and private rooms

The built-in stream `cue` elements listen on, `/_yerd/cues`, serves only public rooms and refuses the rest with a 403. By default only `"main"` is public:

```ts
yerd({ cues: { public: ["main", "rave"] } });                 // these rooms
yerd({ cues: { public: (room) => room.startsWith("lobby:") } }); // rooms that pass a test
yerd({ cues: { public: true } });                            // every room
yerd({ cues: { public: false } });                           // no built-in stream at all
```

Serve a private room from your own guarded stream route, returning `cues.listen(rooms, signal)` from an `@sse` method, and point elements at it with `cueFrom`:

```tsx
@route("/teams/:id/cues", { guards: [auth.required, onTeam] })
export class TeamCues {
  @inject(Cues) accessor cues!: Cues;
  @param("id") accessor id!: string;
  @signal accessor stop!: AbortSignal;

  @get @sse feed() {
    return this.cues.listen([`team:${this.id}`], this.stop);
  }
}

// on the team's page
<div class={confetti} cue="goal" cueFrom={`/teams/${team.id}/cues`} />

// anywhere
await this.cues.play("goal", { room: `team:${team.id}` });
```

- Every cue a `cueFrom` route sends is for its elements; `cueRoom` narrows a multi-room route to one.
- A page can mix public elements and any number of `cueFrom` URLs.
- Asking `/_yerd/cues` for a private room logs a warning naming it, once.
- A room name is 1 to 128 characters, no control characters.

### Instances and counts

- **Instances:** cues go out through [Channels](api:yerd.Channels), so a shared [ChannelBackend](api:yerd.ChannelBackend) or [EventTransport](14-events.md#channels-ride-along) reaches every instance. `cooldown` is per process.
- **Counts:** `cues.watching(room)` is how many pages listen through this process.
- **Testing:** `cues.listen(rooms, signal)` is the runtime's feed, so a test can play a cue and check it arrived.

## Disconnects and the "pass the signal" rule

When a client leaves (or the server shuts down), the request's [@signal](api:yerd.signal) aborts and yerd calls `return()` on your generator, so its `finally` blocks run. A generator parked at an `await` only stops once that await settles, so pass the signal to whatever you wait on:

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

- `Channels.subscribe(name, signal)` already ends the moment the signal aborts, which is why the shop's feed is one line.
- Pass it to `fetch`, `node:timers/promises` timers, database cursors and queues.
- Signal-aware APIs throw an `AbortError` when cancelled; catch it as above, or it's logged as a failed stream.

## Graceful shutdown

On `SIGINT`, `SIGTERM`, or `close()` on the [RunningServer](api:yerd.RunningServer), yerd stops accepting connections, aborts every `@sse`, `@ndjson` and cue stream so their generators finish, then waits for in-flight requests up to `shutdownTimeout` (10 s). The full sequence is in [deploying](11-deploying.md#graceful-shutdown).

> [!WARNING]
> Only `@sse` and `@ndjson` streams count as long-lived. A plain async iterable that never ends holds shutdown until the timeout; use `ndjson()`/`sse()` for endless feeds, or end your loop when the signal aborts.
