/**
 * Cues: server-timed moments every connected page plays together.
 *
 * The server picks a moment on its own clock and tells every page in the
 * room; each page has measured how far its clock is from the server's (the
 * runtime asks `/_yerd/clock` a few times and keeps the quickest answer), so
 * they all play it at the same instant, give or take a frame. Someone who
 * arrives late (or whose connection was slow) starts the cue partway, where
 * everyone else is.
 *
 * ```tsx
 * @route("/rave")
 * export class Rave {
 *   @inject(Cues) accessor cues!: Cues;
 *
 *   @action async airhorn() {
 *     await this.cues.play("airhorn", { room: "rave", lasts: 2000, cooldown: 1000 });
 *   }
 *
 *   @get page() {
 *     return (
 *       <main>
 *         <div class={dancer} sync />                          // looping animation, in step on every screen
 *         <img class={shake} src="/gnome.png" cue="airhorn" cueRoom="rave" />
 *         <audio src="/airhorn.mp3" cue="airhorn" cueRoom="rave" />
 *         <button action={this.airhorn}>AIRHORN</button>
 *       </main>
 *     );
 *   }
 * }
 * ```
 *
 * When a cue plays, each element naming it gets `data-yx-cued="<name>"`
 * (taken off and put back, so its CSS animation starts over), an `<audio>` or
 * `<video>` plays from the start, and a `yx:cue` event bubbles from the
 * element with `{ name, room, data, at, late }`; call preventDefault() on it
 * to play the cue your own way.
 *
 * Cues go out through Channels, so with a shared ChannelBackend every
 * instance's pages hear them. Rooms aren't private: any page can listen to
 * any room by name, so don't put secrets in `data`.
 */

import { inject } from "../di/decorators.js";
import { Channels } from "./channels.js";

/** Where the runtime listens for cues. */
export const CUES_PATH = "/_yerd/cues";
/** Where the runtime reads the server's clock. */
export const CLOCK_PATH = "/_yerd/clock";

/** The room a cue goes to when none is given, and the one `cue` elements listen to without `cueRoom`. */
export const DEFAULT_ROOM = "main";

/** Options for Cues.play(). */
export interface CueOptions {
  /**
   * The room: pages listen to the rooms their `cueRoom` elements name
   * (`"main"` without one). Default `"main"`.
   *
   * ```ts
   * await this.cues.play("confetti", { room: `team:${teamId}` });
   * ```
   */
  room?: string;
  /**
   * How far ahead to schedule it, in ms, so the message reaches every page
   * before it's due and they start together. Default 250. 0 plays it now,
   * and pages start it late by however long the message took.
   *
   * ```ts
   * await this.cues.play("countdown", { in: 3000 }); // three seconds from now, everywhere
   * ```
   */
  in?: number;
  /**
   * Anything JSON can carry, handed to `yx:cue` listeners as `detail.data`.
   *
   * ```ts
   * await this.cues.play("emote", { data: { emoji: "gnome", from: user.name } });
   * ```
   */
  data?: unknown;
  /**
   * How long the cue runs, in ms. A page that connects (or reconnects) while
   * it's still running starts it partway; past that, it's skipped. Each
   * element's `data-yx-cued` comes off when it ends. Without it, a cue is
   * only played by pages that hear it before it's due, and `data-yx-cued`
   * stays until the next cue.
   *
   * ```ts
   * await this.cues.play("airhorn", { lasts: 2000 });
   * ```
   */
  lasts?: number;
  /**
   * Ignore plays of the same cue (same room and `key`) for this long after
   * one goes out, in ms: a button everyone mashes plays once per window.
   * play() returns undefined for an ignored one. Counted per process.
   *
   * ```ts
   * await this.cues.play("airhorn", { cooldown: 1500 }); // at most one airhorn per 1.5s
   * ```
   */
  cooldown?: number;
  /**
   * What `cooldown` counts by. Default: the cue's name.
   *
   * ```ts
   * await this.cues.play("airhorn", { cooldown: 5000, key: `airhorn:${user.id}` }); // per person
   * ```
   */
  key?: string;
}

/** A cue as pages receive it. */
export interface Cue {
  /**
   * Unique per play: pages that hear it twice (a reconnect) play it once.
   *
   * ```ts
   * const cue = await this.cues.play("airhorn");
   * cue?.id; // "c1k3j9a-4"
   * ```
   */
  id: string;
  /**
   * The cue's name, matched against `cue` attributes.
   *
   * ```ts
   * cue.name; // "airhorn"
   * ```
   */
  name: string;
  /**
   * The room it went to.
   *
   * ```ts
   * cue.room; // "main"
   * ```
   */
  room: string;
  /**
   * When it plays, in ms on the server's clock (`Date.now()` there).
   *
   * ```ts
   * cue.at - Date.now(); // ~250: the default lead
   * ```
   */
  at: number;
  /**
   * How long it runs, in ms, if play() was told.
   *
   * ```ts
   * cue.lasts; // 2000
   * ```
   */
  lasts?: number;
  /**
   * play()'s `data`.
   *
   * ```ts
   * cue.data; // { emoji: "gnome" }
   * ```
   */
  data?: unknown;
}

const NAME = /^[A-Za-z0-9_:.-]{1,64}$/;
const ROOM_MAX = 128;
/** Cues kept per room for pages that connect late. */
const KEEP = 64;

function checkMs(what: string, value: number | undefined): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    throw new TypeError(`cues.play: ${what} must be a number of ms (0 or more), got ${String(value)}`);
  }
}

/** A room name is fine if it's short and has no control characters. */
export function validRoom(room: unknown): room is string {
  return typeof room === "string" && room.length > 0 && room.length <= ROOM_MAX && !/[\u0000-\u001f\u007f]/.test(room);
}

function channelOf(room: string): string {
  return `yerd:cues:${room}`;
}

let seq = 0;
const PREFIX = Math.floor(Math.random() * 36 ** 6).toString(36);

/**
 * The cue hub. Built in: every app has one in DI. play() from an action, a
 * service or an event handler; pages with `cue` elements listen on their own.
 *
 * ```ts
 * @route("/party")
 * export class Party {
 *   @inject(Cues) accessor cues!: Cues;
 *
 *   @action async drop() {
 *     await this.cues.play("bass-drop", { in: 1000, lasts: 4000, cooldown: 4000 });
 *   }
 * }
 * ```
 */
export class Cues {
  @inject(Channels) accessor channels!: Channels;
  /** room -> recent cues, oldest first. */
  readonly #recent = new Map<string, Cue[]>();
  /** cooldown key -> when it may play again. */
  readonly #cooling = new Map<string, number>();
  /** room -> open cue streams in this process. */
  readonly #watching = new Map<string, number>();

  /**
   * Send a cue to every page listening to the room, timed to play `in` ms
   * from now on every one of them. Returns what was sent, or undefined if
   * `cooldown` swallowed it.
   *
   * ```ts
   * await this.cues.play("airhorn");
   * await this.cues.play("wave", { room: "stage", in: 1000, lasts: 3000, data: { from: "ada" } });
   * ```
   */
  async play(name: string, options: CueOptions = {}): Promise<Cue | undefined> {
    if (typeof name !== "string" || !NAME.test(name)) {
      throw new TypeError(`cues.play: a cue name is 1-64 letters, digits, _ : . or -, got ${JSON.stringify(name)}`);
    }
    const room = options.room ?? DEFAULT_ROOM;
    if (!validRoom(room)) throw new TypeError(`cues.play: room must be 1-${ROOM_MAX} characters with no control characters, got ${JSON.stringify(room)}`);
    checkMs("in", options.in);
    checkMs("lasts", options.lasts);
    checkMs("cooldown", options.cooldown);
    if (options.key !== undefined && typeof options.key !== "string") throw new TypeError("cues.play: key must be a string");

    const now = Date.now();
    if (options.cooldown) {
      const key = `${room}\n${options.key ?? name}`;
      const until = this.#cooling.get(key);
      if (until !== undefined && now < until) return undefined;
      this.#cooling.set(key, now + options.cooldown);
      if (this.#cooling.size > 1000) for (const [k, t] of this.#cooling) if (t <= now) this.#cooling.delete(k);
    }

    const cue: Cue = { id: `${PREFIX}-${(++seq).toString(36)}`, name, room, at: now + (options.in ?? 250) };
    if (options.lasts !== undefined) cue.lasts = options.lasts;
    if (options.data !== undefined) {
      // Pages get it as JSON: refuse what wouldn't survive the trip now, not in every browser.
      try {
        cue.data = JSON.parse(JSON.stringify(options.data)) as unknown;
      } catch (error) {
        throw new TypeError(`cues.play: data must be JSON-serializable (${(error as Error).message})`);
      }
    }
    this.#remember(cue);
    await this.channels.publish(channelOf(room), cue);
    return cue;
  }

  /**
   * Cues in these rooms a page connecting now should still play: due later,
   * or running (within `lasts`). Oldest first.
   *
   * ```ts
   * this.cues.pending(["main"]); // [{ name: "airhorn", at: ..., lasts: 2000, ... }]
   * ```
   */
  pending(rooms: readonly string[]): Cue[] {
    const now = Date.now();
    const out: Cue[] = [];
    for (const room of new Set(rooms)) {
      const list = this.#recent.get(room);
      if (!list) continue;
      const live = list.filter((cue) => cue.at + (cue.lasts ?? 0) > now);
      if (live.length) this.#recent.set(room, live);
      else this.#recent.delete(room);
      out.push(...live);
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /**
   * Cues for these rooms until `signal` aborts: the pending ones first, then
   * each one as it's played (on any instance, with a shared ChannelBackend).
   * The runtime's `/_yerd/cues` stream is this.
   *
   * ```ts
   * @get @sse feed() { return this.cues.listen(["stage"], this.stop); }
   * ```
   */
  async *listen(rooms: readonly string[], signal: AbortSignal): AsyncGenerator<Cue, void, unknown> {
    const unique = [...new Set(rooms)];
    for (const room of unique) if (!validRoom(room)) throw new TypeError(`cues.listen: bad room ${JSON.stringify(room)}`);
    // Subscribe before reading what's pending, so a cue played in between isn't missed (pages drop repeats by id).
    const live = this.channels.subscribe(unique.map(channelOf), signal, { buffer: KEEP });
    for (const room of unique) this.#watching.set(room, (this.#watching.get(room) ?? 0) + 1);
    const sent = new Set<string>();
    try {
      for (const cue of this.pending(unique)) {
        sent.add(cue.id);
        yield cue;
      }
      for await (const message of live) {
        const cue = message as Cue;
        // Played on another instance: keep it for this instance's late arrivals too.
        this.#remember(cue);
        if (sent.has(cue.id)) continue;
        yield cue;
      }
    } finally {
      await live.return(undefined);
      for (const room of unique) {
        const left = (this.#watching.get(room) ?? 1) - 1;
        if (left > 0) this.#watching.set(room, left);
        else this.#watching.delete(room);
      }
    }
  }

  /**
   * Pages listening to a room through this process right now (one per tab
   * with a `cue` element for it). With several instances, each counts its own.
   *
   * ```tsx
   * <p>{this.cues.watching("rave")} gnomes raving</p>
   * ```
   */
  watching(room: string = DEFAULT_ROOM): number {
    return this.#watching.get(room) ?? 0;
  }

  #remember(cue: Cue): void {
    const list = this.#recent.get(cue.room) ?? [];
    if (list.some((c) => c.id === cue.id)) return;
    list.push(cue);
    if (list.length > KEEP) list.splice(0, list.length - KEEP);
    this.#recent.set(cue.room, list);
  }
}
