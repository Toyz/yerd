# Events

This page covers yerd's event bus: announcing that something happened, reacting to it in the background, asking another service for an answer, and spreading events across instances.

## Why events

A checkout that sends the receipt, takes the stock, updates the sales dashboard and clears the saved cart has to know about all four, and a slow mail server slows down every order. Emit one event instead (`OrderPlaced`) and make each of those a service that listens for it. Checkout stays short, the reactions run after the response has gone out, and adding a fifth reaction doesn't touch checkout at all.

| You want | Use |
| --- | --- |
| "This happened; whoever cares can react" | an event: `emit()` and [`@on`](api:yerd.on) |
| An answer from another service (a price, a quote) | a call: `call()` and [`@handles`](api:yerd.handles) |
| Open browser tabs to update | a [channel](07-streaming-and-live.md#channels) (an `@on` handler can publish to one) |

Every app has a bus: inject [`Events`](api:yerd.Events) anywhere. It works in one process with no setup, and across instances once you register a [transport](#several-instances-and-other-apps).

## An event is a class

```ts
// src/events.ts
import { named } from "@toyz/yerd";

@named("order.placed")
export class OrderPlaced {
  constructor(
    readonly orderId: string,
    readonly userId: string,
    readonly totalCents: number,
  ) {}
}
```

- [`@named`](api:yerd.named) gives the event a stable name for the wire and the logs. Without it the class name is used, which a minifier may change and another app may spell differently. Two classes with the same name throw when the second one loads.
- Keep the fields plain data (strings, numbers, booleans, arrays, plain objects). Events are [copied through JSON](#events-travel-as-json) on their way to each handler.
- Put in everything a handler needs. Handlers run after the request is over, so "the current user" doesn't exist for them: send the user's id.

## Recipe: background work after checkout

The checkout emits; three services react.

```tsx
// src/routes/checkout.tsx
import { Events, HttpError, action, get, inject, redirect, route, session, type Session } from "@toyz/yerd";
import { OrderPlaced } from "../events.js";
import { Orders, Payments } from "../orders.js";

@route("/checkout")
export class Checkout {
  @inject(Events) accessor events!: Events;
  @inject(Orders) accessor orders!: Orders;
  @inject(Payments) accessor payments!: Payments;
  @session accessor session!: Session<{ userId?: string }>;

  @get page() {
    return (
      <form action={this.place}>
        <button>Place order</button>
      </form>
    );
  }

  @action async place() {
    const userId = this.session.userId;
    if (!userId) throw new HttpError(401, "Sign in first");
    const order = this.orders.place(userId);
    this.events.emit(new OrderPlaced(order.id, userId, order.totalCents));
    // If the card is declined, this throws: the request fails and the event is dropped.
    await this.payments.charge(order);
    return redirect(`/orders/${order.id}`);
  }
}
```

```ts
// src/reactions.ts
import { Channels, channel, inject, on, service } from "@toyz/yerd";
import { OrderPlaced } from "./events.js";
import { Mailer, Stock } from "./orders.js";

export const salesChannel = channel<{ totalCents: number }>("sales");

@service
export class Receipts {
  @inject(Mailer) accessor mailer!: Mailer;

  @on(OrderPlaced) async send(event: OrderPlaced) {
    await this.mailer.send(event.userId, `Thanks for order ${event.orderId}`);
  }
}

@service
export class Warehouse {
  @inject(Stock) accessor stock!: Stock;

  // The stock service is flaky: try again after 2s, 4s and 8s before giving up.
  @on(OrderPlaced, { retries: 3, backoff: "2s" }) async reserve(event: OrderPlaced) {
    await this.stock.reserve(event.orderId);
  }
}

@service
export class SalesTicker {
  @inject(Channels) accessor channels!: Channels;

  // Every open dashboard refreshes (see data-yx-live).
  @on(OrderPlaced) async tick(event: OrderPlaced) {
    await this.channels.publish(salesChannel, { totalCents: event.totalCents });
  }
}
```

```ts
// src/main.ts
/// <reference types="vite/client" />
import { yerd } from "@toyz/yerd";
import "./reactions.js"; // nothing injects these services, so nothing else would import them

export default yerd()
  .sessions()
  .discover(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }));
```

The user gets the redirect as soon as the order is saved and charged. The receipt, the stock and the ticker happen after, each on its own, and a failure in one doesn't stop the others.

## When an event goes out

| Where you call it | When handlers get it |
| --- | --- |
| `emit()` inside a request (handler, action, guard, or a service they call) | once the handler has returned without throwing; dropped if it throws |
| `emit()` outside a request (`@every`, an `@on` handler, a hosted service, a script) | at once |
| `emitNow()` anywhere | at once; returns a promise that settles once the event is handed to the transport |

Waiting for the request is what makes the checkout above safe: emit, then do the risky part. If the charge throws, nobody hears about an order that never happened.

> [!NOTE]
> "Succeeded" means the handler returned. If it throws, the events are dropped even when a [`@catches`](api:yerd.catches) method or `app.onError` turns the error into a friendly page. A handler that *returns* an error response (`res(..., { status: 422 })`) still sends its events.

## Reacting with @on

[`@on(EventClass, options)`](api:yerd.on) marks a method of a singleton service as a handler.

- **In the background.** It runs after the response, so the user never waits for it and never sees it fail. A throw is logged at `error` (target `yerd::events`) with the handler's name.
- **In its own DI scope.** Each delivery gets a fresh scope, like a request: scoped services are new and disposed afterwards. There's no current request, so `currentContext()`, `@session` and `auth.current()` aren't available.
- **Singletons only.** `@on` on a scoped or transient service is a boot error, like `@every`.
- **Unordered.** Several handlers of one event each get it, in no promised order. If B must run after A, have A emit a second event.

| Option | Default | Does |
| --- | --- | --- |
| `retries` | `0` | run it again this many times when it throws |
| `backoff` | `"1s"` | the wait before the first retry, doubling after each (`"500ms"`, `"2s"`, or ms) |
| `every` | `false` | deliver to every instance instead of one (see [below](#several-instances-and-other-apps)) |

Retries log a warning each time and an error after the last one. Shutdown cancels retries that are still waiting. A retried handler runs again from the top, so make it safe to repeat: check "already reserved?" before reserving.

### Register your handlers

A `@service` registers when its module is imported. A service that only has `@on` handlers is never injected anywhere, so nothing imports it unless you do: import it from your entry (as `main.ts` does above), or keep handler services in a folder that `discover()` loads. In development, yerd warns the first time an event reaches no handler at all:

```text
WARN nothing handles order.placed: is the module with its @on handlers imported? A @service registers when its module loads (yerd::events)
```

If you pass `yerd({ services: [...] })`, list the handler services there too.

### Events travel as JSON

Every handler gets its own copy, made with `JSON.stringify` and `JSON.parse`, even in memory. So a handler can't change an object another handler (or the emitter) is still using, and you see the same copy in development that a real transport would deliver in production.

The copy is an instance of the event's class, built without running the constructor: getters and methods work, and fields set at construction (`readonly id = randomUUID()`) arrive with the values they had. What JSON can't carry changes on the way: a `Date` arrives as a string, a `Map` or `Set` as `{}`, functions and `undefined` fields disappear. Give the class a static `fromJSON` to rebuild those:

```ts
import { named } from "@toyz/yerd";

@named("invoice.due")
export class InvoiceDue {
  constructor(
    readonly invoiceId: string,
    readonly due: Date,
  ) {}

  /** Called with the JSON copy instead of the default rebuild. */
  static fromJSON(data: { invoiceId: string; due: string }): InvoiceDue {
    return new InvoiceDue(data.invoiceId, new Date(data.due));
  }
}
```

> [!WARNING]
> An event JSON can't serialize at all (a `BigInt`, a circular reference) is refused right at `emit()` with a TypeError naming the event, so the mistake shows up where you made it. Keep events to plain data.

## Calls: asking for an answer

A call is an event that wants a reply. It extends [`Call<Result>`](api:yerd.Call), exactly one [`@handles`](api:yerd.handles) method answers it, and [`events.call()`](api:yerd.Events.call) resolves to the answer, typed by `Result`.

### Recipe: a typed shipping quote

The cart asks for a shipping price without knowing who works it out.

```ts
// src/shipping.ts
import { Call, HttpError, handles, named, service } from "@toyz/yerd";

@named("shipping.quote")
export class QuoteShipping extends Call<number> {
  constructor(
    readonly grams: number,
    readonly country: string,
  ) {
    super();
  }
}

const BASE: Record<string, number> = { US: 499, PT: 899, JP: 1199 };

@service
export class Shipping {
  @handles(QuoteShipping) quote(q: QuoteShipping): number {
    const base = BASE[q.country];
    if (base === undefined) throw new HttpError(422, `We don't ship to ${q.country} yet`);
    return base + Math.ceil(q.grams / 1000) * 150;
  }
}
```

```tsx
// src/routes/cart.tsx
import { ActionForm, Events, HttpError, Region, action, get, inject, route } from "@toyz/yerd";
import { QuoteShipping } from "../shipping.js";

@route("/cart")
export class CartPage {
  @inject(Events) accessor events!: Events;

  @get async page() {
    return <main>{await this.estimate("US")}</main>;
  }

  async estimate(country: string) {
    const cents = await this.events.call(new QuoteShipping(1200, country), { timeout: "3s" }); // number
    return (
      <Region id="shipping">
        <form action={this.ship}>
          <select name="country" data-yx-submit>
            <option value="US" selected={country === "US"}>United States</option>
            <option value="PT" selected={country === "PT"}>Portugal</option>
            <option value="AQ" selected={country === "AQ"}>Antarctica</option>
          </select>
          <span data-yx-error="country"></span>
        </form>
        <p>Shipping: ${(cents / 100).toFixed(2)}</p>
      </Region>
    );
  }

  @action async ship(_: {}, form: ActionForm) {
    const country = form.string("country");
    try {
      return await this.estimate(country);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      // The handler's 422 arrives as an HttpError; as an issue for "country" it lands in that field's box.
      throw new HttpError(error.status, error.message, { details: { issues: [{ path: "country", message: error.message }] } });
    }
  }
}
```

What to know about calls:

- **Errors cross over.** An `HttpError` thrown by the handler reaches the caller as an `HttpError` with the same status and message, so a 422 from `Shipping` can be a 422 from your route. Any other failure arrives as a plain `Error` with the handler's message (and is logged on the handler's side).
- **One answer.** Two `@handles` for the same call class is a boot error. `@handles` belongs on a singleton service, like `@on`.
- **Nobody home.** In memory, a call nothing answers fails at once: `Nothing answers shipping.quote`. Over a transport that can't count its listeners, it waits for `timeout` (default `"10s"`) and then fails.
- **Not deferred.** Unlike `emit()`, a call goes out immediately, even inside a request: you're waiting for it. If the request fails later, the call already happened.
- **JSON both ways.** The call is copied like an event, and so is the answer: return plain data (a `Date` comes back as a string). A call JSON can't serialize is refused the same way, `events.call()` rejecting with the TypeError before anything is sent.
- **Its own scope.** The handler runs in a fresh DI scope with no current request, like an `@on` handler.

`ResultOf<C>` is the answer type of a call class, for helpers that wrap `events.call()`.

## Jobs, scripts and the app's life

`@on` and `@handles` methods are subscribed when the app starts (`listen()`, or `app.start()` for worker processes), or on the bus's first use if that comes sooner: a script in `app.scope()` or a test calling `app.request()` reaches the handlers without starting anything else.

- An `@every` job or a hosted service can emit; outside a request, the event goes at once.
- On shutdown the bus stops taking new deliveries and waits for running handlers, up to `shutdownTimeout`. Calls still waiting for an answer fail with "the app is shutting down".

A script can emit from [`app.scope()`](08-services.md#scripts-appscope) without starting the app (no `@onBoot`, no `@every` jobs); the handlers still hear it. Stop the app afterwards so it waits for them:

```ts
// scripts/resend-receipt.ts
import { Events, resolve } from "@toyz/yerd";
import { app } from "../src/app.js";
import { OrderPlaced } from "../src/events.js";

await app.scope(() => {
  resolve(Events).emit(new OrderPlaced("o-1001", "ada", 4200));
});
await app.stop(); // waits for the handlers still running
```

## Several instances and other apps

By default events stay in the process. To spread them across instances, or to other apps, register an [EventTransport](api:yerd.EventTransport):

```ts
interface EventTransport {
  publish(topic: string, message: unknown): number | void | Promise<number | void>;
  subscribe(topic: string, group: string, deliver: (message: unknown) => void | Promise<void>): () => void;
}
```

The model is consumer groups: a message goes to every group subscribed to its topic, once per group, to one member of that group. That's a Redis Streams consumer group, a NATS queue group, or a queue per group in RabbitMQ or SQS.

- **Each `@on` handler is a group**, named after it (`Receipts.send`). With five instances, an order still sends one receipt: one of the five `Receipts.send` members gets it.
- **`{ every: true }`** makes a group per instance instead, so every instance runs the handler. Use it for state that lives in each process:

  ```ts
  import { named, on, service } from "@toyz/yerd";

  @named("product.changed")
  export class ProductChanged {
    constructor(readonly productId: string) {}
  }

  @service
  export class PriceCache {
    #prices = new Map<string, number>();

    // Every instance drops its own copy; one-of-five wouldn't be enough.
    @on(ProductChanged, { every: true }) forget(event: ProductChanged) {
      this.#prices.delete(event.productId);
    }
  }
  ```

- **Topics** are `event:<name>` for events, `call:<name>` for calls, and `reply:<instance id>` for answers coming back to the instance that asked. [Channels](07-streaming-and-live.md#channels) use `channel:<name>`, see below.
- **Return a count from `publish`** (how many groups it reached) when the broker can tell you. Then a call nobody answers fails at once instead of timing out.

A transport over a message broker is a few lines. Here `Broker` stands for your client library:

```ts
// src/transport.ts
import { EventTransport, yerd } from "@toyz/yerd";

interface Broker {
  publish(subject: string, data: string): Promise<void>;
  subscribe(subject: string, queue: string, onMessage: (data: string) => void): { unsubscribe(): void };
}

export function brokerTransport(broker: Broker): EventTransport {
  return {
    async publish(topic, message) {
      // Returns nothing: this broker can't say how many groups got it.
      await broker.publish(topic, JSON.stringify(message));
    },
    subscribe(topic, group, deliver) {
      const subscription = broker.subscribe(topic, group, (data) => void deliver(JSON.parse(data)));
      return () => subscription.unsubscribe();
    },
  };
}

export function withBroker(broker: Broker) {
  return yerd().services((s) => s.value(EventTransport, brokerTransport(broker)));
}
```

Name every event and call that leaves the process with `@named`, and use the same names in every app that shares the broker. What a delivery guarantees (at most once, at least once) is up to your broker; with at-least-once delivery, the same event can arrive twice, so handlers should be safe to repeat.

[`MemoryTransport`](api:yerd.MemoryTransport) is the in-process default. Two apps given the same `MemoryTransport` instance behave like two instances sharing a broker, which is handy in tests.

### Channels ride along

Live features ([Channels](07-streaming-and-live.md#channels), and the cues built on them) need messages across instances too. When an `EventTransport` is registered and no `ChannelBackend` is, `Channels` runs over the transport through [`channelBackendFrom`](api:yerd.channelBackendFrom): channel `room:42` is topic `channel:room:42`, and every subscriber joins a group of its own, so each one hears every message. One adapter covers both.

A group per subscriber suits brokers where groups are cheap and vanish with their last member (NATS queue groups, pub/sub fan-out). Where a group is durable (a Redis Streams consumer group outlives its consumers), register a [`ChannelBackend`](api:yerd.ChannelBackend) over plain pub/sub instead; a registered `ChannelBackend` always wins.

## Testing events

[`events.waitFor(EventClass, { where, timeout })`](api:yerd.Events.waitFor) resolves with the next matching event this instance sees. Call it *before* the thing that emits, so the event can't slip past:

```ts
import { afterAll, expect, it } from "vitest";
import { Events, yerd } from "@toyz/yerd";
import { OrderPlaced } from "../src/events.js";
import { Checkout } from "../src/routes/checkout.js";
import { Receipts } from "../src/reactions.js";

const app = yerd({ routes: [Checkout], services: [Receipts], handleSignals: false }).sessions();
afterAll(() => app.stop());

it("announces the order", async () => {
  await app.boot();
  const placed = app.container.get(Events).waitFor(OrderPlaced, { where: (e) => e.userId === "ada", timeout: "2s" });
  const client = app.client();
  // ...sign in as ada first, e.g. client.action("/login", { name: "ada", password: "..." })
  await client.action("/checkout");
  const event = await placed;
  expect(event.totalCents).toBeGreaterThan(0);
});
```

An `@on` method is an ordinary method, so you can also call it directly, no bus involved: `await app.scope(() => resolve(Receipts).send(event))`, with fakes registered through `app.services()` for what it injects. Two apps given one `MemoryTransport` check that a handler runs once across instances. The [testing guide](12-testing.md) covers servers, sessions and fakes.
