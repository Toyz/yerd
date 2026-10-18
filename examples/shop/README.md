# shop

Paperyard, a small stationery shop. The core guides build it one piece at a
time, starting with [Your first app](../../docs/guide/13-your-first-app.md);
this is where they end up. Teaching code: small on purpose. The kitchen sink
is where every feature lives.

From the repo root:

```sh
npm run shop         # Vite dev server on http://localhost:3000
npm run shop:build   # production build: examples/shop/dist/{client,server}
npm run shop:start   # node examples/shop/dist/server/server.js
```

Sign in with `ada` / `analytical-engine`.

| Route | What |
|-------|------|
| `GET /` | the catalog; `?q=` searches, `?category=` filters |
| `GET /products/:id` | a product, a 404 for an unknown id; stock updates live |
| `GET /products/:id/stock` | the stock feed the product page listens to (SSE) |
| `GET /cart` | the cart, in the session; quantity and remove are actions |
| `GET /login`, `POST /logout` | sign in keeps a guest's cart |
| `GET /checkout` | signed in only; a validated form that places the order |
| `GET /orders/:id` | the receipt page, only for its owner |
| `GET /api/products`, `/api/products/:id` | JSON, same filters, no session |

Placing an order emits `OrderPlaced`; `Receipts` (`src/receipts.ts`) hears it
after the response and logs a pretend receipt.

| File | What |
|------|------|
| `src/app.ts` | the app: layout, error page, sessions, auth |
| `src/catalog.ts` | `Catalog` service, products, the stock channel |
| `src/cart.ts` | the `Cart` session shape, `priceCart()` |
| `src/orders.ts` | `CheckoutForm` DTO, `Orders` service, `OrderPlaced` |
| `src/receipts.ts` | the `@on(OrderPlaced)` handler |
| `src/users.ts` | `Users`, the demo account, `createAuth(...)` |
| `src/layouts.tsx` | `RootLayout` with the cart badge, `Narrow`, `ErrorPage` |
| `src/components.tsx` | `Price`, `ProductCard`, `Field` |
| `src/routes/` | products, cart, checkout and orders, sign-in, the API |
