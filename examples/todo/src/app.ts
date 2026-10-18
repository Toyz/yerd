import { yerd } from "@toyz/yerd";
import { ErrorPage, RootLayout } from "./layouts.js";
import { auth } from "./users.js";

/** The app, without routes: main.ts (Vite) and server.ts (plain node) add them their own way. */
export function createApp() {
  return (
    // The default 1 MiB bodyLimit already covers the import (files up to 64 KiB), so it stays.
    yerd()
      .layout(RootLayout)
      .errorPage(ErrorPage)
      .sessions()
      .use(auth)
      // Request lines at info everywhere; in development also the TodoList spans (@instrument logs at debug).
      // YERD_LOG and YERD_LOG_FORMAT still win, so a deploy can change this without a rebuild.
      .logging({ filter: process.env.NODE_ENV === "production" ? "info" : "info,TodoList=debug" })
  );
}
