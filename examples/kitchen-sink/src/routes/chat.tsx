import { ActionForm, Channels, Region, action, get, guards, inject, route, signal, sse } from "@toyz/yerd";
import { Ago } from "../attributes.js";
import { Chat, chatChannel, ChatLine, type ChatMessage } from "../chat.js";
import { auth, type User } from "../users.js";
import { Shop } from "./shop.js";

/** Live updates for the chat page: one plain SSE message per new chat line, and every open tab refreshes. */
@route("/chat/events")
export class ChatEvents {
  @inject(Channels) accessor channels!: Channels;
  @signal accessor stop!: AbortSignal;

  @get @sse feed() {
    return this.channels.subscribe(chatChannel, this.stop);
  }
}

function Message({ message, mute }: { message: ChatMessage; mute?: ChatPage["mute"] }) {
  return (
    <li key={message.id} class={["message", { staff: message.staff }]}>
      <span class="author">@{message.author}</span>
      {message.staff ? <span class="tag">staff</span> : null}
      <Ago iso={message.at} />
      <p>{message.text}</p>
      {/* An action on a plain button (default trigger: click). Staff only, and guarded on the server too. */}
      {mute && !message.staff ? (
        <button class="btn btn-ghost btn-small" action={() => mute({ userId: message.userId, name: message.author })} data-yx-confirm={`Mute @${message.author} for 5 minutes?`}>
          Mute
        </button>
      ) : null}
    </li>
  );
}

@route("/chat", { group: Shop, meta: { title: "Chat", area: "chat" } })
export class ChatPage {
  @inject(Chat) accessor chat!: Chat;
  @auth.maybeUser accessor me: User | undefined;

  get #staff() {
    return this.me?.roles.includes("staff") ?? false;
  }

  @get page() {
    return (
      <>
        <h1 class="page-title">Shop chat</h1>
        <div data-yx-live="/chat/events" hidden></div>
        {this.me ? (
          // Enter sends (the form's keydown:Enter trigger); the Send button is the way in without JavaScript.
          <form class="chat-form" action={this.say} trigger="keydown:Enter" data-yx-reset>
            <label class="visually-hidden" for="chat-text">Message</label>
            <textarea class="input" id="chat-text" name="text" rows={2} maxlength={280} placeholder="Say something nice about a rock. Enter sends." required></textarea>
            <button class="btn">Send</button>
            <p class="form-error" data-yx-error role="alert"></p>
          </form>
        ) : (
          <p class="panel muted">
            <a href="/login?next=/chat">Log in</a> to chat. Reading is free.
          </p>
        )}
        <Region id="messages" as="ol" class="messages" aria-live="polite">
          {this.chat.recent().map((m) => <Message message={m} mute={this.#staff ? this.mute : undefined} />)}
        </Region>
      </>
    );
  }

  /**
   * Behind two method guards: signed in, and not muted (a named guard that
   * lives on the Chat service). The new message is prepended (`<Region prepend>`),
   * so the sender sees it at once; everyone else gets it from the live refresh.
   */
  @action @auth.required @guards("notMuted") async say(_: {}, form: ActionForm) {
    const message = await this.chat.say(this.me!, form.parse(ChatLine).text);
    return (
      <Region id="messages" as="ol" prepend>
        <Message message={message} mute={this.#staff ? this.mute : undefined} />
      </Region>
    );
  }

  /** A role check on a single action: only staff can mute. */
  @action @auth.role("staff") mute({ userId, name }: { userId: string; name: string }) {
    this.chat.mute(userId);
    void this.chat.say(this.me!, `@${name} has been muted for 5 minutes. Think about the rocks.`);
  }
}
