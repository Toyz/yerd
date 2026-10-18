# Events

The event bus: announce that something happened, react in the background, ask another service for an answer, and spread events across instances.

## Why events

Instead of a checkout that sends the receipt, takes stock and updates the dashboard itself (and waits on a slow mail server), emit one `OrderPlaced` event and let a service for each reaction listen. The reactions run after the response, and a new one doesn't touch checkout.

| You want | Use |
| --- | --- |
| "This happened; whoever cares can react" | an event: `emit()` and [`@on`](api:yerd.on) |
| An answer from another service (a price, a quote) | a call: `call()` and [`@handles`](api:yerd.handles) |
| Open browser tabs to update | a [channel](07-streaming-and-live.md#channels) (an `@on` handler can publish to one) |

Inject [`Events`](api:yerd.Events) anywhere. It works in one process with no setup, and across instances with a [transport](#several-instances-and-other-apps).

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

- [`@named`](api:yerd.named) gives a stable name for the wire and logs; the class name is the fallback, which minifiers may change. Two classes with one name throw when the second loads.
- Keep fields plain data: events are [copied through JSON](#events-travel-as-json).
- Include everything a handler needs. Handlers run after the request, so send the user's id, not "the current user".

## Recipe: background work after checkout

The checkout emits; three services react.

```tsx
// src/routes/checkout.tsx
import { Events, Unauthorized, action, get, inject, redirect, route, session, type Session } from "@toyz/yerd";
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
    if (!userId) throw new Unauthorized("Sign in first");
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

The user is redirected once the order is saved and charged. The three reactions run afterwards, independently: one failing doesn't stop the others.

## When an event goes out

| Where you call it | When handlers get it |
| --- | --- |
| `emit()` inside a request (handler, action, guard, or a service they call) | once the handler has returned without throwing; dropped if it throws |
| `emit()` outside a request (`@every`, an `@on` handler, a hosted service, a script) | at once |
| `emitNow()` anywhere | at once; returns a promise that settles once the event is handed to the transport |

So emit, then do the risky part: if the charge throws, nobody hears about an order that never happened.

> [!NOTE]
> If the handler throws, its events are dropped even when [`@catches`](api:yerd.catches) or `app.onError` turns the error into a page. A handler that *returns* an error response (`res(..., { status: 422 })`) still sends them.

## Reacting with @on

[`@on(EventClass, options)`](api:yerd.on) marks a singleton service's method as a handler.

- **Background.** It runs after the response. A throw is logged at `error` (target `yerd::events`) with the handler's name.
- **Own DI scope** per delivery, like a request, but with no current request: no `currentContext()`, `@session` or `auth.current()`.
- **Singletons only.** On a scoped or transient service it's a boot error.
- **Unordered.** If B must run after A, have A emit a second event.

| Option | Default | Does |
| --- | --- | --- |
| `retries` | `0` | run it again this many times when it throws |
| `backoff` | `"1s"` | the wait before the first retry, doubling after each (`"500ms"`, `"2s"`, or ms) |
| `every` | `false` | deliver to every instance instead of one (see [below](#several-instances-and-other-apps)) |

Each retry logs a warning, the last failure an error; shutdown cancels pending retries. A retry runs from the top, so make handlers safe to repeat.

### Register your handlers

A `@service` registers when its module is imported, and a service with only `@on` handlers is never injected. Import it from your entry (as above) or keep handlers in a folder `discover()` loads. With `yerd({ services: [...] })`, list them there. In development, an event that reaches no handler warns once:

```text
WARN nothing handles order.placed: is the module with its @on handlers imported? A @service registers when its module loads (yerd::events)
```

### Events travel as JSON

Each handler gets its own copy via `JSON.stringify`/`JSON.parse`, even in memory, so handlers can't change each other's objects and development matches a real transport.

- The copy is an instance of the event's class, built without running the constructor: getters and methods work, and constructor-set fields keep their values.
- A `Date` arrives as a string, `Map`/`Set` as `{}`, and functions and `undefined` fields disappear. Rebuild them in a static `fromJSON`:

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
> An event JSON can't serialize (a `BigInt`, a circular reference) is refused at `emit()` with a TypeError naming it.

## Calls: asking for an answer

A call extends [`Call<Result>`](api:yerd.Call); exactly one [`@handles`](api:yerd.handles) method answers it, and [`events.call()`](api:yerd.Events.call) resolves to the typed answer.

### Recipe: a typed shipping quote

The cart asks for a shipping price without knowing who works it out.

```ts
// src/shipping.ts
import { Call, YerdError, handles, named, service } from "@toyz/yerd";

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
    if (base === undefined) throw new YerdError(422, `We don't ship to ${q.country} yet`);
    return base + Math.ceil(q.grams / 1000) * 150;
  }
}
```

```tsx
// src/routes/cart.tsx
import { ActionForm, Events, YerdError, Region, action, get, inject, route } from "@toyz/yerd";
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
      if (!(error instanceof YerdError)) throw error;
      // The handler's 422 arrives as a YerdError; as an issue for "country" it lands in that field's box.
      throw new YerdError(error.status, error.message, { details: { issues: [{ path: "country", message: error.message }] } });
    }
  }
}
```

- **Errors cross over.** An `YerdError` from the handler reaches the caller with the same status and message; other failures arrive as a plain `Error` with the handler's message (and are logged there).
- **One answer.** Two `@handles` for one call class is a boot error; it belongs on a singleton service.
- **Nobody home.** In memory, an unanswered call fails at once (`Nothing answers shipping.quote`). Over a transport that can't count listeners, it fails after `timeout` (default `"10s"`).
- **Not deferred.** A call goes out immediately, even inside a request.
- **JSON both ways.** The answer is copied too, so return plain data. An unserializable call rejects before anything is sent.
- **Own scope**, with no current request, like `@on`.

`ResultOf<C>` is a call class's answer type, for helpers that wrap `events.call()`.

## Jobs, scripts and the app's life

Handlers subscribe when the app starts (`listen()`, or `app.start()` for workers), or on the bus's first use if sooner, so scripts in `app.scope()` and tests calling `app.request()` reach them.

- `@every` jobs and hosted services can emit; outside a request, events go at once.
- On shutdown the bus stops new deliveries and waits for running handlers up to `shutdownTimeout`. Pending calls fail with "the app is shutting down".

A script can emit from [`app.scope()`](08-services.md#scripts-appscope) without starting the app; stop the app afterwards to wait for handlers:

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

Events stay in the process until you register an [EventTransport](api:yerd.EventTransport):

```ts
interface EventTransport {
  publish(topic: string, message: unknown): number | void | Promise<number | void>;
  subscribe(topic: string, group: string, deliver: (message: unknown) => void | Promise<void>): () => void;
}
```

The model is consumer groups: a message goes once to each group subscribed to its topic, to one member (a Redis Streams consumer group, a NATS queue group, a queue per group in RabbitMQ or SQS).

- **Each `@on` handler is a group** named after it (`Receipts.send`), so five instances still send one receipt.
- **`{ every: true }`** makes a group per instance, for state that lives in each process:

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

- **Topics:** `event:<name>`, `call:<name>`, `reply:<instance id>` for answers, and `channel:<name>` for [channels](#channels-ride-along).
- **Return a count from `publish`** (groups reached) if the broker knows it, so unanswered calls fail at once instead of timing out.

A broker transport is a few lines (`Broker` stands for your client library):

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

- Name every event and call that leaves the process with `@named`, using the same names in every app on the broker.
- Delivery guarantees are your broker's; with at-least-once, handlers must be safe to repeat.
- [`MemoryTransport`](api:yerd.MemoryTransport) is the default. Two apps sharing one instance behave like two instances on a broker, handy in tests.

### Channels ride along

With an `EventTransport` and no `ChannelBackend` registered, [Channels](07-streaming-and-live.md#channels) (and cues) run over the transport via [`channelBackendFrom`](api:yerd.channelBackendFrom): channel `room:42` is topic `channel:room:42`, and each subscriber is its own group, so all hear every message.

That suits brokers where groups are cheap and vanish with their last member (NATS queue groups, pub/sub fan-out). Where groups are durable (Redis Streams), register a [`ChannelBackend`](api:yerd.ChannelBackend) over plain pub/sub instead; it always wins.

## Testing events

[`events.waitFor(EventClass, { where, timeout })`](api:yerd.Events.waitFor) resolves with the next matching event. Call it *before* the thing that emits:

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

- An `@on` method is an ordinary method: call it directly with `await app.scope(() => resolve(Receipts).send(event))`, registering fakes through `app.services()`.
- Two apps on one `MemoryTransport` check that a handler runs once across instances.
- The [testing guide](12-testing.md) covers servers, sessions and fakes.
