import { yerd } from "@toyz/yerd";
import { ErrorPage, RootLayout } from "./layouts.js";
import { auth } from "./users.js";

/** The app, without routes: main.ts (Vite) and server.ts (plain node) add them their own way. */
export function createApp() {
  return yerd().layout(RootLayout).errorPage(ErrorPage).sessions().use(auth);
}
