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
| `heartbeat` | `0` (off) | writes an empty line every N ms while the source is quiet, so proxies keep the connection open; or `{ every, send }` for a line of your own ([custom heartbeats](#custom-heartbeats)) |
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
| `heartbeat` | `15000` | sends a `: ping` comment every N ms while quiet; or `{ every, send }` for an event of your own ([custom heartbeats](#custom-heartbeats)) |
| `retry` | none | sends a reconnect delay hint (ms) once at the start |
| `errorEvent` | `true` | if the source throws, sends `event: error` with the message before closing |

`event()` also takes `retry` and `comment`. To refresh a page's Regions on every message, point `data-yx-live` at an SSE route (see [interactivity](06-interactivity.md#live-refresh)).

### Custom heartbeats

A heartbeat keeps a quiet connection from being dropped by proxies and load balancers. The plain beat (a blank NDJSON line, an SSE comment) is invisible to clients. When the client should see it (to show "live", to detect a stalled connection, to carry a server time), give the heartbeat a body: `{ every, send }`.

`send` is written like any item of the stream. For SSE, `event()` makes a named event the client can listen for, and a plain value is a message. For NDJSON it's a JSON line.

```tsx
import { event, get, ndjson, route, sse } from "@toyz/yerd";

@route("/live")
export class Live {
  // The same body every time.
  @get @sse({ heartbeat: { every: 20_000, send: event({ event: "ping" }) } }) feed() { ... }

  // A function makes each beat: it's told which beat it is, how long the stream
  // has been quiet, and how long it's been open.
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

- The function may return `undefined` for the plain beat that time.
- `idleMs` restarts with every item, so it's the time since the last real update; `openMs` is since the stream started.
- A heartbeat only goes out while the source is quiet: a busy stream doesn't need one, so it gets none.
- A bad interval (negative, `NaN`) is refused when the stream is created, not after its headers have gone out.

### Errors mid-stream

Once a stream has started, its status is already sent, so a thrown error becomes the last line or event instead. A [YerdError](api:yerd.YerdError)'s message is shown as is; anything else is logged and sent as `Internal Server Error`, so internals don't leak.

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
> The default backend is in-memory, so messages reach subscribers in the same process only, synchronously and by reference: every subscriber gets the very object you published (events, by contrast, are copied per handler), so don't mutate a message after publishing it. For several instances, either register an [EventTransport](14-events.md#several-instances-and-other-apps), and channels [ride on it](14-events.md#channels-ride-along) with no second adapter, or implement [ChannelBackend](api:yerd.ChannelBackend) (Redis, NATS, Postgres `LISTEN`) and register it: `app.services((s) => s.value(ChannelBackend, myBackend))`. A registered `ChannelBackend` wins over the transport. See [services](08-services.md).

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

## Server-synced animation

Two pieces make every open page animate together: `sync` keeps looping CSS animations on the same beat everywhere, and [Cues](api:yerd.Cues) plays one-off moments (an airhorn, a countdown, confetti) on every page at the same instant.

Both run on the server's clock. The client runtime asks `/_yerd/clock` for the time a few times, keeps the quickest answer, and works out how far its own clock is from the server's. It measures once per page, when the first `sync` or `cue` element shows up, then again every few minutes and whenever the tab comes back into view. On a normal connection pages agree to within a few milliseconds.

### sync: one beat everywhere

Put `sync` on an element and its infinite CSS animations, and those of everything inside it, are lined up as if they all started at the same moment. Two windows side by side show the same frame.

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

- `animation-delay` still works, as an offset from the shared beat, so a row can be staggered.
- Only infinite animations are moved. One-off animations play as they would without `sync`; for those, use a cue.
- Elements added later, a class change that starts a new animation, and a re-measured clock are all handled.

### Cues: one moment, every screen

Inject `Cues` and `play()` a cue by name. Elements with `cue="name"` play it.

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

1. Gets `data-yx-cued="<name>"`. The attribute is taken off and put back, so a CSS animation keyed off it starts over each time.
2. Plays, if it's an `<audio>` or `<video>`, from where everyone else is.
3. Dispatches a `yx:cue` event that bubbles, with `{ name, room, data, at, late }`. Call `preventDefault()` on it to play the cue your own way, and steps 1 and 2 are skipped.

`cue` takes several names, space-separated or as an array: `cue={["airhorn", "drop"]}`.

| `play()` option | What it does |
| --- | --- |
| `room` | Which pages hear it. Pages listen to the rooms their `cueRoom` props name (`"main"` when there's none), or to what their `cueFrom` route serves. See [public and private rooms](#public-and-private-rooms). Default `"main"`. |
| `in` | How far ahead to schedule it, in ms or as a duration (`"3s"`). The lead gives the message time to reach every page, so they start together. Default 250. |
| `lasts` | How long it runs, in ms or as a duration (`"2s"`). A page that connects while it's running starts it partway. `data-yx-cued` comes off when it ends. |
| `cooldown` | Ignore plays of the same cue for this long, in ms or as a duration (`"1.5s"`). A button the whole room mashes plays once per window. `play()` returns undefined for an ignored play. |
| `key` | What `cooldown` counts by, instead of the name. For example `` `airhorn:${user.id}` `` gives each person their own cooldown. |
| `data` | Anything JSON can carry. Listeners get it as `detail.data`. |

Sequences are several cues on one timeline:

```ts
@action async drop() {
  const counting = await this.cues.play("countdown", { lasts: 2500, cooldown: 7000 });
  if (counting) await this.cues.play("drop", { in: 2750, lasts: 4000 });
}
```

### Late, slow and hidden pages

A cue says when it plays on the server's clock, so it doesn't matter when the message arrives:

- **Early:** the page waits for the moment.
- **Late:** a slow link, a tab that was in the background, or a page opened while a cue with `lasts` was running. The page plays the cue at once, `late` ms in. CSS animations are moved forward by that much, and audio and video seek to it.
- **Past the end of `lasts`:** the cue is skipped.
- **Seen twice:** a reconnect replays the cues that are still running, and each cue plays only once.

### Sound

Browsers block audio until the visitor has interacted with the page. An `<audio cue>` on a page nobody has clicked stays quiet; the animation still plays. For sound made in code (Web Audio), listen for `yx:cue` and start your `AudioContext` on the first click. The kitchen sink's `horn` attribute does this.

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

The same clock is available to your own client code: `yerd.clock.now()` is the server's time, and `yerd.clock.sync()` measures it and resolves with `{ now, offset, rtt }`.

### Public and private rooms

Rooms work like [channels](#channels). The built-in stream that `cue` elements listen on, `/_yerd/cues`, only serves the rooms you make public, and it refuses the rest with a 403. Out of the box only `"main"` is public:

```ts
yerd({ cues: { public: ["main", "rave"] } });                 // these rooms
yerd({ cues: { public: (room) => room.startsWith("lobby:") } }); // rooms that pass a test
yerd({ cues: { public: true } });                            // every room
yerd({ cues: { public: false } });                           // no built-in stream at all
```

Any other room is private: serve it from a stream route of your own, behind whatever guards it needs, and point the elements at that route with `cueFrom`. `cues.listen(rooms, signal)` is the stream; return it from an `@sse` method.

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

- Every cue a `cueFrom` route sends is for its elements. If the route serves several rooms, `cueRoom` on an element narrows it to one.
- A page can mix both: elements without `cueFrom` share one public stream, and each `cueFrom` URL gets its own.
- If a page asks `/_yerd/cues` for a private room, the server logs a warning naming the room, once.
- A room name is 1 to 128 characters with no control characters.

The kitchen sink has both: the rave's room is public, and the back office's order bell is a private `"staff"` room streamed from `/admin/cues`, behind the staff guard.

### Instances and counts

- **Instances:** cues go out through [Channels](api:yerd.Channels). With a shared [ChannelBackend](api:yerd.ChannelBackend), or an [EventTransport](14-events.md#channels-ride-along) that channels ride on, pages on every instance hear every cue. `cooldown` is counted per process.
- **Counts:** `cues.watching(room)` is how many pages are listening through this process right now. The kitchen sink shows it as "tabs raving".
- **Testing:** `cues.listen(rooms, signal)` is the same feed the runtime reads, so a test can play a cue and check that it arrived.

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
2. Aborts every `@sse` and `@ndjson` stream, and the runtime's cue streams, so their generators finish.
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
