/**
 * Channels: named pub/sub for live features.
 *
 * Any @sse or @ndjson route is already a live feed; Channels is the plumbing
 * that decides who hears what. Publish to a channel name you choose (one per
 * user, per room, per document), subscribe from a stream route, and the
 * request's signal cleans the subscription up when the client goes away.
 *
 * ```ts
 * export const todoChannel = (userId: string) => channel<TodoChange>(`todos:${userId}`);
 *
 * // anywhere, e.g. in a service after a write
 * this.channels.publish(todoChannel(owner), { type: "added", todo });
 *
 * // a per-user live feed
 * @route("/todos/events", { guards: [auth.required] })
 * class Events {
 *   @inject(Channels) accessor channels!: Channels;
 *   @auth.user accessor me!: User;
 *   @signal accessor stop!: AbortSignal;
 *   @get @sse events() { return this.channels.subscribe(todoChannel(this.me.id), this.stop); }
 * }
 * ```
 *
 * Messages go through a ChannelBackend: in-memory by default (one process).
 * For several instances, register your own (Redis, NATS, Postgres LISTEN):
 * `app.services((s) => s.value(ChannelBackend, myBackend))`.
 */

import { maybe } from "../di/decorators.js";
import { token } from "../di/container.js";
import { Logger } from "../log/logger.js";

const channelLog = new Logger("yerd::channels");

export interface ChannelBackend {
  publish(channel: string, message: unknown): void | Promise<void>;
  /** Start delivering a channel's messages to `listener`; returns a function that stops it. */
  subscribe(channel: string, listener: (message: unknown) => void): () => void;
}

/** DI token for a custom backend. */
export const ChannelBackend = token<ChannelBackend>("ChannelBackend");

/** One process, no setup. */
export class MemoryBackend implements ChannelBackend {
  readonly #listeners = new Map<string, Set<(message: unknown) => void>>();

  publish(channel: string, message: unknown): void {
    for (const listener of [...(this.#listeners.get(channel) ?? [])]) listener(message);
  }

  subscribe(channel: string, listener: (message: unknown) => void): () => void {
    let set = this.#listeners.get(channel);
    if (!set) this.#listeners.set(channel, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(channel);
    };
  }

  /** Current listener count for a channel. */
  listeners(channel: string): number {
    return this.#listeners.get(channel)?.size ?? 0;
  }
}

const REF: unique symbol = Symbol.for("yerd.channel");

/** A channel name that carries its message type. */
export interface ChannelRef<T> {
  readonly [REF]: true;
  readonly name: string;
  /** Phantom: the message type. */
  readonly __message?: T;
}

/**
 * A typed channel. Families are plain functions:
 *
 * ```ts
 * const room = (roomId: string) => channel<ChatMessage>(`room:${roomId}`);
 * channels.publish(room("42"), { from: "ada", text: "hi" }); // type-checked
 * ```
 */
export function channel<T>(name: string): ChannelRef<T> {
  return { [REF]: true, name };
}

type Target<T> = ChannelRef<T> | string;
type MessageOf<C> = C extends ChannelRef<infer T> ? T : unknown;

function nameOf(target: Target<unknown>): string {
  return typeof target === "string" ? target : target.name;
}

export interface SubscribeOptions {
  /** Messages kept for a slow subscriber before the oldest are dropped. Default 1000. */
  buffer?: number;
}

/**
 * One subscriber's queue. Subscribed as soon as it's created, not on the first
 * next() as an async generator would be, so nothing published between
 * subscribe() and the first read is missed. Closed by return()/throw() (a
 * `for await` that breaks) or by the signal; one that's never read is cleaned
 * up when the signal aborts.
 */
class Subscription<T> implements AsyncGenerator<T, undefined, unknown> {
  readonly #queue: T[] = [];
  readonly #waiting: Array<(result: IteratorResult<T, undefined>) => void> = [];
  readonly #signal: AbortSignal;
  readonly #limit: number;
  #stops: Array<() => void> = [];
  #dropped = 0;
  #closed = false;

  constructor(backend: ChannelBackend, names: readonly string[], signal: AbortSignal, limit: number) {
    this.#signal = signal;
    this.#limit = limit;
    if (signal.aborted) {
      this.#closed = true;
      return;
    }
    const listener = (message: unknown) => this.#push(message as T);
    try {
      for (const name of names) this.#stops.push(backend.subscribe(name, listener));
    } catch (error) {
      // A backend failed partway: don't leave the earlier channels listening.
      this.#close();
      throw error;
    }
    signal.addEventListener("abort", this.#close);
  }

  #push(message: T): void {
    if (this.#closed) return;
    const waiter = this.#waiting.shift();
    if (waiter) return waiter({ value: message, done: false });
    this.#queue.push(message);
    if (this.#queue.length > this.#limit) {
      this.#queue.shift();
      if (this.#dropped++ === 0) channelLog.warn(`a channel subscriber fell ${this.#limit} messages behind; dropping the oldest`);
    }
  }

  readonly #close = (): void => {
    if (this.#closed && this.#stops.length === 0) return;
    this.#closed = true;
    this.#signal.removeEventListener("abort", this.#close);
    const stops = this.#stops;
    this.#stops = [];
    for (const stop of stops) stop();
    this.#queue.length = 0;
    for (const waiter of this.#waiting.splice(0)) waiter({ value: undefined, done: true });
  };

  next(): Promise<IteratorResult<T, undefined>> {
    if (this.#queue.length > 0) return Promise.resolve({ value: this.#queue.shift()!, done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  return(): Promise<IteratorResult<T, undefined>> {
    this.#close();
    return Promise.resolve({ value: undefined, done: true });
  }

  throw(error?: unknown): Promise<IteratorResult<T, undefined>> {
    this.#close();
    return Promise.reject(error);
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#close();
  }
}

/** The channel hub. Built in: every app has one in DI. */
export class Channels {
  @maybe(ChannelBackend) accessor custom: ChannelBackend | undefined;
  readonly #memory = new MemoryBackend();

  get backend(): ChannelBackend {
    return this.custom ?? this.#memory;
  }

  /** Send a message to everyone subscribed to the channel. */
  async publish<C extends Target<any>>(target: C, message: MessageOf<C>): Promise<void> {
    await this.backend.publish(nameOf(target), message);
  }

  /**
   * Messages on one or more channels, until `signal` aborts. Subscribed right
   * away, so messages published before the first read are kept. Each
   * subscriber has its own queue, so nothing is lost while a stream route is
   * still writing the previous message; past `buffer`, the oldest are dropped.
   */
  subscribe<C extends Target<any>>(targets: C | readonly C[], signal: AbortSignal, options: SubscribeOptions = {}): AsyncGenerator<MessageOf<C>, undefined, unknown> {
    const list = (Array.isArray(targets) ? targets : [targets]) as readonly C[];
    return new Subscription<MessageOf<C>>(this.backend, list.map(nameOf), signal, options.buffer ?? 1000);
  }
}
