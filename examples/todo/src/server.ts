// Plain-node entry: `npm run todo:raw` (tsc, then node). No Vite, so the
// stylesheet is served straight from the source folder (CSS files only).
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const source = fileURLToPath(new URL("../../../../examples/todo/src/", import.meta.url));

const server = await createApp()
  .discover(new URL("./routes/", import.meta.url))
  .static("/src", source, { extensions: [".css"] })
  .listen(Number(process.env.PORT ?? 3000));

console.log(`yerd todos on ${server.url}`);
