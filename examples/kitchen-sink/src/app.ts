import { randomUUID } from "node:crypto";
import { MemoryStore, yerd } from "@toyz/yerd";
import { ErrorPage, RootLayout } from "./layouts.js";
import { ShopConfig, readOnlyMode, timing } from "./shop.js";
// Services that only react to events (@on) are never injected anywhere, so nothing else imports
// them; a @service is registered when its module loads, so load it here.
import "./reactions.js";
import { auth } from "./users.js";
import { BootInfo, Disposals, Visit, bootInfo } from "./lifetimes.js";

/** The app, without routes: main.ts (Vite) and server.ts (plain node) add them their own way. */
export function createApp() {
  return (
    // Photo uploads (up to four 2 MB files per product) need more than the default 1 MiB body.
    yerd({ bodyLimit: 10 * 1024 * 1024 })
      .layout(RootLayout)
      .errorPage(ErrorPage)
      // Sessions in this process (carts can outgrow a cookie), with ids in a format of our choosing.
      .sessions({ store: new MemoryStore({ maxSize: 10_000 }), generateId: () => `sess_${randomUUID()}` })
      .use(timing)
      .use(auth)
      // In front of every route, before group and route guards.
      .guard(readOnlyMode)
      // Config is a plain object, not a class: registered in code under its token.
      .services((s) =>
        s.value(ShopConfig, {
          name: "Yerd Bazaar",
          apiKey: process.env.BAZAAR_API_KEY ?? "let-me-in",
          readOnly: process.env.BAZAAR_READ_ONLY === "1",
          freeShippingCents: 5000,
        })
          // Factories, for what a decorated class can't be: a token's value made on first use, and a
          // per-request class built with a constructor argument (see the /lifetimes page).
          .singleton(BootInfo, bootInfo)
          .scoped(Visit, (c) => new Visit(c.get(Disposals))),
      )
      // Request lines and spans at info everywhere; in development also Orders at debug.
      // YERD_LOG and YERD_LOG_FORMAT still win, so a deploy can change this without a rebuild.
      .logging({ filter: process.env.NODE_ENV === "production" ? "info" : "info,Orders=debug" })
  );
}
