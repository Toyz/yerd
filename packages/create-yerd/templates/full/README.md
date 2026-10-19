# {{name}}

A small [yerd](https://toyz.github.io/yerd/) shop: a catalog, product pages,
a cart in the session, sign-in, a validated checkout form and a JSON API.

```sh
{{run_dev}}      # dev server with reloads, on http://localhost:5173
{{run_test}}     # vitest, in-process: no port, no browser
{{run_check}}    # type-check (Vite doesn't)
{{run_build}}    # production build: dist/client and dist/server/server.js
{{run_start}}    # node dist/server/server.js, on PORT or 3000
```

Sign in with `ada` / `analytical-engine`. Copy `.env.example` to `.env` and
set `YERD_SECRET` before you deploy: it signs forms and seals the session
cookie that holds the cart.

The Playwright test needs a browser once: `{{exec}} playwright install chromium`,
then `{{run_e2e}}`. It builds the app and runs it on port 4173.

| Route | What |
| --- | --- |
| `GET /` | the catalog; `?q=` searches |
| `GET /products/:id` | a product, a 404 for an unknown id; add to cart is an action |
| `GET /cart` | the cart, in the session; remove is an action |
| `GET /login`, `POST /logout` | sign in keeps a guest's cart |
| `GET /checkout` | signed in only; a validated form that places the order |
| `GET /orders/:id` | the receipt, only for its owner |
| `GET /api/products`, `/api/products/:id` | JSON, no session |
| `GET /api/health` | 204, for load balancers |

| File | What |
| --- | --- |
| `src/app.ts` | `createApp()`: layout, error page, sessions, auth; shared with the tests |
| `src/catalog.ts` | `Catalog` service, `ProductNotFound` |
| `src/cart.ts` | the `Cart` session shape, `priceCart()` |
| `src/orders.ts` | `CheckoutForm` DTO, `Orders` service |
| `src/users.ts` | `Users`, the demo account, `createAuth(...)` |
| `src/layouts.tsx` | `RootLayout` with the cart badge, `Narrow`, `ErrorPage` |
| `src/components.tsx` | `Price`, `ProductCard`, `Field` |
| `src/routes/` | products, cart, checkout and orders, sign-in, the API |
| `test/shop.test.ts` | every flow, with `app.request()` and `app.client()` |
| `e2e/shop.spec.ts` | the cart in a real browser |

The [guides](https://toyz.github.io/yerd/#/guide/your-first-app) build a
bigger version of this shop step by step.
