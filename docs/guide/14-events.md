# Events

Placing an order announces `OrderPlaced`, and the receipt goes out from a service the checkout has never heard of.

## Why events

A checkout that sends the receipt, updates the warehouse and the dashboard itself waits on all of them, and changes every time a reaction is added. Instead it emits one event, and a service per reaction listens.

| You want | Use |
| --- | --- |
| "This happened; whoever cares can react" | an event: `emit()` and [`@on`](api:yerd.on) |
| An answer from another service (a price, a quote) | a call: `call()` and [`@handles`](api:yerd.handles) |
| Open browser tabs to update | a [channel](07-streaming-and-live.md#channels) (an `@on` handler can publish to one) |

Inject [`Events`](api:yerd.Events) anywhere. It works in one process with no setup, and across instances with a [transport](#several-instances-and-other-apps).

## An event is a class

```ts
// src/orders.ts
/**
 * Announced after checkout. Handlers run after the response, so it carries
 * what they need (no "current user" by then). Plain data: events travel as JSON.
 */
@named("order.placed")
export class OrderPlaced {
  constructor(
    readonly orderId: number,
    readonly email: string,
    readonly total: number,
  ) {}
}
```

- [`@named`](api:yerd.named) gives a stable name for the wire and logs; the class name is the fallback, which minifiers may change. Two classes with one name throw when the second loads.
- Keep fields plain data: events are [copied through JSON](#events-travel-as-json).
- Include everything a handler needs: the email to send to, not "the current user".

## Recipe: background work after checkout

The checkout emits once the order is placed; `Receipts` reacts.

```tsx
// src/routes/checkout.tsx
@route("/checkout", { group: Account, meta: { title: "Check out" } })
export class CheckoutPage {
  @inject(Events) accessor events!: Events;
  // ...

  @action async place(_: {}, form: ActionForm) {
    // ...details = form.parse(CheckoutForm)
    const order = await this.orders.place(this.me, details, this.cart.lines);
    // Inside a request, the event goes out once this action has returned; a throw drops it.
    this.events.emit(new OrderPlaced(order.id, order.email, order.total));
    this.cart.empty();
    return redirect(`/orders/${order.id}`);
  }
}
```

```ts
// src/receipts.ts
@service
export class Receipts {
  @logger accessor log!: Logger;

  @on(OrderPlaced) send(event: OrderPlaced) {
    // A real shop hands this to a mail service; this one writes it to the log.
    this.log.info("receipt sent", { order: event.orderId, to: event.email, total: formatPrice(event.total) });
  }
}
```

```ts
// src/app.ts
// Nothing injects the receipt handler, so nothing else would import it.
import "./receipts.js";
```

```answer
POST /checkout
_yx=(the form's token)&name=Ada+Lovelace&email=ada%40example.com&address=12+St+James%27s+Square%2C+London
>>>
303 See Other
location: /orders/1001
```

```text
14:54:58.784  INFO receipt sent order=1001 to=ada@example.com total=$24.00 (Receipts)
14:54:58.784  INFO request{method=POST path=/checkout} status=303 1.58ms
```

The customer is redirected without waiting on the receipt. A second reaction (a warehouse, a sales dashboard) is another service with an `@on(OrderPlaced)`; checkout doesn't change.

## When an event goes out

| Where you call it | When handlers get it |
| --- | --- |
| `emit()` inside a request (handler, action, guard, or a service they call) | once the handler has returned without throwing; dropped if it throws |
| `emit()` outside a request (`@every`, an `@on` handler, a hosted service, a script) | at once |
| `emitNow()` anywhere | at once; returns a promise that settles once the event is handed to the transport |

So an action can emit before its last risky step: if that step throws, nobody hears about an order that never happened.

> [!NOTE]
> If the handler throws, its events are dropped even when [`@catches`](api:yerd.catches) or `app.onError` turns the error into a page. A handler that *returns* an error response (`res(..., { status: 422 })`) still sends them.

## Reacting with @on

[`@on(EventClass, options)`](api:yerd.on) marks a singleton service's method as a handler.

- **Background.** Whoever emitted never waits on it. A throw is logged at `error` (target `yerd::events`) with the handler's name.
- **Own DI scope** per delivery, like a request, but with no current request: no `currentContext()`, `@session` or `auth.current()`.
- **Singletons only.** On a scoped or transient service it's a boot error.
- **Unordered.** If B must run after A, have A emit a second event.

| Option | Default | Does |
| --- | --- | --- |
| `retries` | `0` | run it again this many times when it throws |
| `backoff` | `"1s"` | the wait before the first retry, doubling after each (`"500ms"`, `"2s"`, or ms) |
| `every` | `false` | deliver to every instance instead of one (see [below](#several-instances-and-other-apps)) |

```ts
// The stock service is flaky: try again after 2s, 4s and 8s before giving up.
@on(OrderPlaced, { retries: 3, backoff: "2s" }) async reserve(event: OrderPlaced) {
  await this.warehouse.reserve(event.orderId);
}
```

Each retry logs a warning, the last failure an error; shutdown cancels pending retries. A retry runs from the top, so make handlers safe to repeat.

### Register your handlers

A `@service` registers when its module is imported, and a service with only `@on` handlers is never injected. Import it from your app (as the shop's `app.ts` does) or keep handlers in a folder `discover()` loads. With `yerd({ services: [...] })`, list them there. In development, an event that reaches no handler warns once:

```text
WARN nothing handles order.placed: is the module with its @on handlers imported? A @service registers when its module loads (yerd::events)
```

### Events travel as JSON

Each handler gets its own copy via `JSON.stringify`/`JSON.parse`, even in memory.

- The copy is an instance of the event's class, built without running the constructor: getters and methods work, and constructor-set fields keep their values.
- A `Date` arrives as a string, `Map`/`Set` as `{}`, and functions and `undefined` fields disappear. Rebuild them in a static `fromJSON`:

```ts
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

> [!TAKE]
> Events are copied even when nothing leaves the process. Handlers can't change each other's objects, and what works in development works over a broker. You give up passing live objects (a connection, a callback): pass ids and look them up.

> [!WARNING]
> An event JSON can't serialize (a `BigInt`, a circular reference) is refused at `emit()` with a TypeError naming it.

## Calls: asking for an answer

A call extends [`Call<Result>`](api:yerd.Call); exactly one [`@handles`](api:yerd.handles) method answers it, and [`events.call()`](api:yerd.Events.call) resolves to the typed answer.

### Recipe: a typed shipping quote

The cart could ask for a shipping price without knowing who works it out (the shop doesn't ship yet).

```ts
// src/shipping.ts
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
@inject(Events) accessor events!: Events;

async shipping(country: string) {
  const cents = await this.events.call(new QuoteShipping(1200, country), { timeout: "3s" }); // a number
  return <Region id="shipping">Shipping to {country}: <Price cents={cents} /></Region>;
}

// posted by a <select name="country" data-yx-submit> in a form
@action async ship(_: {}, form: ActionForm) {
  const country = form.string("country");
  try {
    return await this.shipping(country);
  } catch (error) {
    if (!(error instanceof YerdError)) throw error;
    // The handler's 422 arrives as a YerdError; as an issue for "country" it lands in that field's box.
    throw new YerdError(error.status, error.message, { details: { issues: [{ path: "country", message: error.message }] } });
  }
}
```

- **Errors cross over.** A `YerdError` from the handler reaches the caller as yerd's class for its status (a `Conflict` for a 409), with its message, code and details. Other failures arrive as a plain `Error` with the handler's message (and are logged there).
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
import { createApp } from "../src/app.js";
import { OrderPlaced } from "../src/orders.js";

const app = createApp();
await app.scope(() => {
  resolve(Events).emit(new OrderPlaced(1001, "ada@example.com", 2400));
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
  @service
  export class PriceCache {
    #prices = new Map<number, number>();

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

// src/app.ts
createApp().services((s) => s.value(EventTransport, brokerTransport(broker)));
```

- Name every event and call that leaves the process with `@named`, using the same names in every app on the broker.
- Delivery guarantees are your broker's; with at-least-once, handlers must be safe to repeat.
- [`MemoryTransport`](api:yerd.MemoryTransport) is the default. Two apps sharing one instance behave like two instances on a broker, handy in tests.

### Channels ride along

With an `EventTransport` and no `ChannelBackend` registered, [Channels](07-streaming-and-live.md#channels) (and cues) run over the transport via [`channelBackendFrom`](api:yerd.channelBackendFrom): the shop's channel `stock:7` is topic `channel:stock:7`, and each subscriber is its own group, so every open product page hears every message.

That suits brokers where groups are cheap and vanish with their last member (NATS queue groups, pub/sub fan-out). Where groups are durable (Redis Streams), register a [`ChannelBackend`](api:yerd.ChannelBackend) over plain pub/sub instead; it always wins.

## Testing events

[`events.waitFor(EventClass, { where, timeout })`](api:yerd.Events.waitFor) resolves with the next matching event. Call it *before* the thing that emits. From the shop's suite:

```ts
// test/unit/shop-example.test.tsx
it("places the order, announces it, takes the stock and empties the cart", async () => {
  const client = await shopperWithNotebook(); // signed in, one Field notebook in the cart
  const placed = app.container.get(Events).waitFor(OrderPlaced, { where: (e) => e.email === "ada@example.com", timeout: "2s" });

  const res = await client.action("/checkout", { name: "Ada Lovelace", email: "ada@example.com", address: "12 St James's Square, London" });
  // ...
  const event = await placed;
  expect(event.total).toBe(2400);
  // ...
});
```

- An `@on` method is an ordinary method: call it directly with `await app.scope(() => resolve(Receipts).send(event))`, registering fakes through `app.services()`.
- Two apps on one `MemoryTransport` check that a handler runs once across instances.
- The [testing guide](12-testing.md) covers servers, sessions and fakes.
