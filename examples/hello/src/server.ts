// Raw lite entry: no Vite. `npm run build` (tsc), then `node dist/examples/hello/src/server.js`.
import { yerd } from "@toyz/yerd";
import { RootLayout } from "./layouts.js";

const app = await yerd()
  .layout(RootLayout)
  .discover(new URL("./routes/", import.meta.url))
  .listen(Number(process.env.PORT ?? 3000));

console.log(`yerd listening on ${app.url}`);
