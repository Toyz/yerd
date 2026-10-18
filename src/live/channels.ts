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
 * An app that already registers an EventTransport for several instances
 * gets channels over it too (see channelBackendFrom); or register a backend
 * of your own (Redis, NATS, Postgres LISTEN):
 * `app.services((s) => s.value(ChannelBackend, myBackend))`.
 */

import { randomUUID } from "node:crypto";
import { maybe } from "../di/decorators.js";
import { token } from "../di/container.js";
import { EventTransport } from "../events/events.js";
import { Logger } from "../log/logger.js";

const channelLog = new Logger("yerd::channels");

/**
 * How messages travel between publishers and subscribers. The default is
 * in-process (MemoryBackend), or channelBackendFrom() over the app's
 * EventTransport when it has one; register your own under the
 * ChannelBackend token to fan out across processes (Redis pub/sub, Postgres
 * NOTIFY, NATS).
 * Every subscriber hears every message: this is broadcast, not a work queue.
 *
 * A sketch over Redis pub/sub (two connections: a subscribed one can't publish):
 *
 * ```ts
 * export class RedisBackend implements ChannelBackend {
 *   constructor(private readonly pub: RedisClient, private readonly sub: RedisClient) {}
 *
 *   async publish(channel: string, message: unknown) {
 *     await this.pub.publish(channel, JSON.stringify(message));
 *   }
 *
 *   subscribe(channel: string, listener: (message: unknown) => void) {
 *     const onMessage = (raw: string) => listener(JSON.parse(raw));
 *     void this.sub.subscribe(channel, onMessage);
 *     return () => void this.sub.unsubscribe(channel, onMessage);
 *   }
 * }
 *
 * app.services((s) => s.value(ChannelBackend, new RedisBackend(pub, sub)));
 * ```
 */
export interface ChannelBackend {
  /**
   * Deliver `message` to every current subscriber of `channel`, in this
   * process and others. Channels.publish() awaits it.
   *
   * ```ts
   * async publish(channel: string, message: unknown) {
   *   await this.pub.publish(channel, JSON.stringify(message));
   * }
   * ```
   */
  publish(channel: string, message: unknown): void | Promise<void>;
  /**
   * Start delivering a channel's messages to `listener`; returns a function
   * that stops it. Called once per channel per subscriber, synchronously, so
   * start listening right away rather than after an await.
   *
   * ```ts
   * subscribe(channel: string, listener: (message: unknown) => void) {
   *   const onMessage = (raw: string) => listener(JSON.parse(raw));
   *   void this.sub.subscribe(channel, onMessage);
   *   return () => void this.sub.unsubscribe(channel, onMessage);
   * }
   * ```
   */
  subscribe(channel: string, listener: (message: unknown) => void): () => void;
}

/** DI token for a custom backend: `app.services((s) => s.value(ChannelBackend, myBackend))`. */
export const ChannelBackend = token<ChannelBackend>("ChannelBackend");

/**
 * One process, no setup: what Channels uses when neither a ChannelBackend
 * nor an EventTransport is registered. Messages are delivered synchronously
 * and by reference: every subscriber gets the very object published, unlike
 * events, which are copied per handler. Publish values nobody mutates. In
 * tests it can tell you whether a stream is still subscribed.
 *
 * ```ts
 * const memory = app.container.get(Channels).backend as MemoryBackend;
 * memory.listeners("room:42"); // 1 while a client is connected, 0 after it leaves
 * ```
 */
export class MemoryBackend implements ChannelBackend {
  readonly #listeners = new Map<string, Set<(message: unknown) => void>>();

  /** Call each of the channel's listeners synchronously, in subscription order. */
  publish(channel: string, message: unknown): void {
    for (const listener of [...(this.#listeners.get(channel) ?? [])]) listener(message);
  }

  subscribe(channel: string, listener: (message: unknown) => void): () => void {
    let set = this.#listeners.get(channel);
    if (!set) this.#listeners.set(channel, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      // Only if it's still this channel's set: a stop called twice mustn't drop subscribers who came after.
      if (set.size === 0 && this.#listeners.get(channel) === set) this.#listeners.delete(channel);
    };
  }

  /**
   * Current listener count for a channel.
   *
   * ```ts
   * expect(memory.listeners("room:42")).toBe(0); // the stream cleaned up
   * ```
   */
  listeners(channel: string): number {
    return this.#listeners.get(channel)?.size ?? 0;
  }
}

/**
 * Channels over an EventTransport, so an app spread over several instances
 * writes one adapter (its EventTransport) instead of two. Channels uses it
 * by itself when an EventTransport is registered and no ChannelBackend is.
 * Channel `room:42` is topic `channel:room:42`, and every subscription joins
 * a group of its own, so each one hears every message (broadcast, not a
 * work queue). Messages travel as the transport carries them (as JSON over a
 * real one, and copied by MemoryTransport too), and arrive as asynchronously
 * as it delivers them.
 *
 * A group per subscription suits transports where groups are cheap and go
 * away with their last member (NATS queue groups, pub/sub fan-out). Where a
 * group is durable (Redis Streams consumer groups), register a ChannelBackend
 * over plain pub/sub instead.
 *
 * ```ts
 * // What Channels does when only an EventTransport is registered:
 * app.services((s) => s.value(EventTransport, nats).value(ChannelBackend, channelBackendFrom(nats)));
 * ```
 */
export function channelBackendFrom(transport: EventTransport): ChannelBackend {
  // Groups are unique across instances: this one's UUID, then a counter.
  const instance = randomUUID();
  let seq = 0;
  return {
    async publish(channel: string, message: unknown): Promise<void> {
      await transport.publish(`channel:${channel}`, message);
    },
    subscribe(channel: string, listener: (message: unknown) => void): () => void {
      return transport.subscribe(`channel:${channel}`, `channel:${instance}:${(++seq).toString(36)}`, listener);
    },
  };
}

const REF: unique symbol = Symbol.for("yerd.channel");

/** A channel name that carries its message type. */
export interface ChannelRef<T> {
  /** Brand that marks a channel() result. */
  readonly [REF]: true;
  /**
   * The channel name the backend sees.
   *
   * ```ts
   * room("42").name; // "room:42"
   * ```
   */
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

/** Options for Channels.subscribe(). */
export interface SubscribeOptions {
  /**
   * Messages kept for a slow subscriber before the oldest are dropped. Default 1000.
   *
   * ```ts
   * return this.channels.subscribe(room(this.id), this.stop, { buffer: 100 });
   * ```
   */
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

/**
 * The channel hub. Built in: every app has one in DI. Publish from anywhere,
 * subscribe from an @sse or @ndjson route.
 *
 * ```ts
 * interface ChatMessage { from: string; text: string }
 * export const room = (id: string) => channel<ChatMessage>(`room:${id}`);
 *
 * @service
 * export class Chat {
 *   @inject(Channels) accessor channels!: Channels;
 *   async say(roomId: string, message: ChatMessage) {
 *     await this.channels.publish(room(roomId), message);
 *   }
 * }
 *
 * @route("/rooms/:id/events")
 * export class RoomEvents {
 *   @inject(Channels) accessor channels!: Channels;
 *   @param("id") accessor id!: string;
 *   @signal accessor stop!: AbortSignal;
 *
 *   @get @sse feed() {
 *     return this.channels.subscribe(room(this.id), this.stop);
 *   }
 * }
 * ```
 */
export class Channels {
  /** The backend registered under the ChannelBackend token, if any. */
  @maybe(ChannelBackend) accessor custom: ChannelBackend | undefined;
  /** The app's EventTransport, if one is registered: channels ride on it when there's no custom backend. */
  @maybe(EventTransport) accessor transport: EventTransport | undefined;
  readonly #memory = new MemoryBackend();
  #overTransport: ChannelBackend | undefined;

  /**
   * The backend in use: the custom one, else channelBackendFrom() over a
   * registered EventTransport, else an in-process MemoryBackend.
   *
   * ```ts
   * const memory = app.container.get(Channels).backend as MemoryBackend;
   * ```
   */
  get backend(): ChannelBackend {
    const custom = this.custom;
    if (custom) return custom;
    const transport = this.transport;
    return transport ? (this.#overTransport ??= channelBackendFrom(transport)) : this.#memory;
  }

  /**
   * Send a message to everyone subscribed to the channel. With a ChannelRef
   * the message is type-checked; a plain string name takes anything.
   *
   * ```ts
   * await this.channels.publish(room("42"), { from: "ada", text: "hi" });
   * await this.channels.publish("news", "plain string names work too");
   * ```
   */
  async publish<C extends Target<any>>(target: C, message: MessageOf<C>): Promise<void> {
    await this.backend.publish(nameOf(target), message);
  }

  /**
   * Messages on one or more channels, until `signal` aborts. Subscribed right
   * away, so messages published before the first read are kept. Each
   * subscriber has its own queue, so nothing is lost while a stream route is
   * still writing the previous message; past `buffer`, the oldest are dropped.
   * Return it from an @sse route as is, or loop over it to reshape messages.
   *
   * ```ts
   * @get @sse async *feed() {
   *   const rooms = [room(this.id), room("lobby")];
   *   for await (const message of this.channels.subscribe(rooms, this.stop, { buffer: 100 })) {
   *     yield { ...message, at: Date.now() };
   *   }
   * }
   * ```
   */
  subscribe<C extends Target<any>>(targets: C | readonly C[], signal: AbortSignal, options: SubscribeOptions = {}): AsyncGenerator<MessageOf<C>, undefined, unknown> {
    const list = (Array.isArray(targets) ? targets : [targets]) as readonly C[];
    return new Subscription<MessageOf<C>>(this.backend, list.map(nameOf), signal, options.buffer ?? 1000);
  }
}
