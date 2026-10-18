import { randomUUID } from "node:crypto";
import { Channels, HttpError, channel, guard, inject, is, length, service, singleton, trim, type YerdContext } from "@toyz/yerd";
import { auth } from "./users.js";

export interface ChatMessage {
  id: string;
  userId: string;
  author: string;
  staff: boolean;
  text: string;
  at: string;
}

/** A ping per new message: the chat page's data-yx-live refreshes on each. */
export const chatChannel = channel<{ id: string }>("chat");

export class ChatLine {
  @is.string({ transform: trim, validate: length(1, 280) }) text!: string;
}

/** The shop's chat room. `@singleton` is the shorthand for `@service({ lifetime: "singleton" })`. */
@singleton
@service
export class Chat {
  @inject(Channels) accessor channels!: Channels;
  #messages: ChatMessage[] = [
    { id: randomUUID(), userId: "seed", author: "ada", staff: true, text: "Welcome to the Bazaar chat. The gnomes are listening.", at: new Date(Date.now() - 600_000).toISOString() },
    { id: randomUUID(), userId: "seed", author: "bo", staff: true, text: "Reminder: the Suspiciously Warm Rock is not a heater.", at: new Date(Date.now() - 300_000).toISOString() },
  ];
  #muted = new Map<string, number>();

  /** Newest first. */
  recent(count = 50): ChatMessage[] {
    return this.#messages.slice(-count).reverse();
  }

  async say(user: { id: string; name: string; roles: readonly string[] }, text: string): Promise<ChatMessage> {
    const message: ChatMessage = { id: randomUUID(), userId: user.id, author: user.name, staff: user.roles.includes("staff"), text, at: new Date().toISOString() };
    this.#messages.push(message);
    if (this.#messages.length > 500) this.#messages.shift();
    await this.channels.publish(chatChannel, { id: message.id });
    return message;
  }

  mute(userId: string, minutes = 5): void {
    this.#muted.set(userId, Date.now() + minutes * 60_000);
  }

  isMuted(userId: string): boolean {
    return (this.#muted.get(userId) ?? 0) > Date.now();
  }

  /**
   * A named guard on a service, so it can use the service's state: routes
   * refer to it by name, `@guards("notMuted")`. An unknown name is a boot error.
   */
  @guard("notMuted") notMuted(_ctx: YerdContext) {
    const me = auth.current();
    return !me || !this.isMuted(me.id) || new HttpError(403, "You're muted for a few minutes. Go look at a rock.");
  }
}
