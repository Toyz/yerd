# Streaming and live

Responses that keep going: streamed bodies, NDJSON and Server-Sent Events, streamed uploads, channels, synced animation, disconnects and shutdown.

## Return an async iterable

Return any async iterable (usually an async generator) and yerd streams each chunk as it's produced.

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

- Strings and bytes go out as they are; anything else is stringified.
- It's sent as `text/plain`, headers with the first chunk. Set your own type with `res(stream, { headers: { "content-type": "text/csv" } })` (see [responses](04-responses.md)).
- For a feed that may sit quiet, use `@ndjson` or `@sse`: they send headers right away.
- HTML pages stream too (see [pages and layouts](05-pages-and-layouts.md#components)).

## NDJSON

[@ndjson](api:yerd.ndjson) on a generator method sends one JSON value per line.

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

Pass options as `@ndjson({ heartbeat: 15_000 })`, or return `ndjson(source, options)` from an ordinary method:

| Option | Default | Does |
|---|---|---|
| `heartbeat` | `0` (off) | writes an empty line every N ms while the source is quiet, so proxies keep the connection open; or `{ every, send }` for a line of your own ([custom heartbeats](#custom-heartbeats)) |
| `errorLine` | `true` | if the source throws mid-stream, writes a last line `{"error": "..."}` before closing |

## Server-Sent Events

[@sse](api:yerd.sse) works the same way over `text/event-stream`, which browsers read with `EventSource`.

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
| `heartbeat` | `15000` | sends a `: ping` comment every N ms while quiet; or `{ every, send }` for an event of your own ([custom heartbeats](#custom-heartbeats)) |
| `retry` | none | sends a reconnect delay hint (ms) once at the start |
| `errorEvent` | `true` | if the source throws, sends `event: error` with the message before closing |

- Plain values become `data:` (non-strings as JSON); [event](api:yerd.event) sends a named event, and also takes `id`, `retry` and `comment`.
- To refresh a page's Regions on every message, point `data-yx-live` at an SSE route (see [interactivity](06-interactivity.md#live-refresh)).

### Custom heartbeats

Give the heartbeat a body with `{ every, send }` when clients should see it (to show "live", detect a stall, or carry a server time); the plain beat is invisible.

```tsx
import { event, get, ndjson, route, sse } from "@toyz/yerd";

@route("/live")
export class Live {
  // The same body every time.
  @get @sse({ heartbeat: { every: 20_000, send: event({ event: "ping" }) } }) feed() { ... }

  // A function makes each beat from its count, idle time and open time.
  @get stats() {
    return ndjson(this.updates(), {
      heartbeat: { every: 10_000, send: ({ count, idleMs }) => ({ type: "keepalive", count, idleMs }) },
    });
  }
}
```

```js
// In the browser: a named heartbeat event, and a timer that notices when beats stop.
const source = new EventSource("/live");
let lastBeat = Date.now();
source.addEventListener("ping", () => (lastBeat = Date.now()));
setInterval(() => document.body.classList.toggle("stalled", Date.now() - lastBeat > 45_000), 5_000);
```

- `send` is written like any stream item: for SSE an `event()` or a plain message, for NDJSON a JSON line.
- The function may return `undefined` for a plain beat.
- `idleMs` is the time since the last real item; `openMs` since the stream started.
- Beats only go out while the source is quiet.
- A bad interval (negative, `NaN`) is refused when the stream is created.

### Errors mid-stream

Once a stream has started its status is sent, so a thrown error becomes the last line or event. An [YerdError](api:yerd.YerdError)'s message is shown as is; anything else is logged and sent as `Internal Server Error`.

## Streamed request bodies

[ndjsonBody](api:yerd.ndjsonBody) reads an NDJSON upload line by line as it arrives, optionally validating each line with a DTO.

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

- Only each line is size-limited, not the whole upload.
- A bad line ends the request with a 400 naming it (`Line 2 is not valid JSON`, or `Line 2 failed validation` plus the issues).
- Without a DTO, lines are `unknown`. The same stream is `currentContext().lines()`.
- A body can be read whole or streamed, not both.

## Channels

[Channels](api:yerd.Channels) is a built-in pub/sub hub: publish to a name from anywhere, subscribe from a stream route. Name channels with [channel](api:yerd.channel)`<T>()` to type-check messages.

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

- `subscribe(targets, signal, { buffer })` takes one channel or an array and ends when `signal` aborts. Nothing published after the call is missed.
- Each subscriber has its own queue; a slow one keeps up to `buffer` messages (1000), then drops the oldest with a warning.
- Plain strings work as names too: `publish("todos", msg)`.
- Channels push to open tabs. For work that should run once per change on the server, use [events](14-events.md).

> [!NOTE]
> The default backend is in-memory: same process only, and every subscriber gets the very object you published, so don't mutate it afterwards. For several instances, register an [EventTransport](14-events.md#several-instances-and-other-apps) (channels [ride on it](14-events.md#channels-ride-along)) or a [ChannelBackend](api:yerd.ChannelBackend) (Redis, NATS, Postgres `LISTEN`) with `app.services((s) => s.value(ChannelBackend, myBackend))`. A `ChannelBackend` wins over the transport.

## Per-user live feeds

Give each user their own channel, publish after every write, and subscribe with the signed-in user's id.

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

To transform messages on the way out, loop in a generator: `for await (const change of this.channels.subscribe(...)) yield { ...change, at: Date.now() };`.

## Server-synced animation

`sync` keeps looping CSS animations on the same beat on every open page; [Cues](api:yerd.Cues) plays one-off moments (an airhorn, confetti) everywhere at the same instant. Both run on the server's clock, and pages agree to within a few milliseconds.

### sync: one beat everywhere

Put `sync` on an element to line up its infinite CSS animations, and those inside it, as if they all started together.

```tsx
import { css, keyframes } from "@toyz/yerd";

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
import { Cues, action, css, get, inject, keyframes, route } from "@toyz/yerd";

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

Browsers block audio until the visitor interacts, so an `<audio cue>` on an untouched page stays quiet (the animation still plays). For Web Audio, start your `AudioContext` on the first click and play on `yx:cue`, as the kitchen sink's `horn` attribute does:

```ts
export const horn = attribute<boolean>("horn", {
  render: (on) => (on ? { horn: "" } : {}),
  client(el) {
    let audio: AudioContext | undefined;
    const unlock = () => void (audio ??= new AudioContext()).resume();
    document.addEventListener("pointerdown", unlock);
    const play = (event: Event) => {
      const { late } = (event as CustomEvent<{ late: number }>).detail;
      if (!audio || audio.state !== "running" || late > 400) return; // half a second late is just noise
      const tone = audio.createOscillator();
      tone.connect(audio.destination);
      tone.start();
      tone.stop(audio.currentTime + 0.5);
    };
    el.addEventListener("yx:cue", play);
    return () => {
      document.removeEventListener("pointerdown", unlock);
      el.removeEventListener("yx:cue", play);
    };
  },
});
```

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

- `Channels.subscribe(name, signal)` already ends the moment the signal aborts.
- Pass it to `fetch`, `node:timers/promises` timers, database cursors and queues.
- Signal-aware APIs throw an `AbortError` when cancelled; catch it as above, or it's logged as a failed stream.

## Graceful shutdown

On `SIGINT`, `SIGTERM`, or `close()` on the [RunningServer](api:yerd.RunningServer), yerd stops accepting connections, aborts every `@sse`, `@ndjson` and cue stream so their generators finish, then waits for in-flight requests up to `shutdownTimeout` (10 s). The full sequence is in [deploying](11-deploying.md#graceful-shutdown).

> [!WARNING]
> Only `@sse` and `@ndjson` streams count as long-lived. A plain async iterable that never ends holds shutdown until the timeout; use `ndjson()`/`sse()` for endless feeds, or end your loop when the signal aborts.
