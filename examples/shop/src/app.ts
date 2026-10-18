import { yerd, type YerdOptions } from "@toyz/yerd";
import { ErrorPage, RootLayout } from "./layouts.js";
import { auth } from "./users.js";
// Nothing injects the receipt handler, so nothing else would import it.
import "./receipts.js";

/** The app, without routes: main.ts discovers them, tests import the ones they need. */
export function createApp(options?: YerdOptions) {
  return yerd(options)
    .layout(RootLayout)
    .errorPage(ErrorPage)
    .sessions()
    .use(auth);
}
