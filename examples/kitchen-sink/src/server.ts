// Plain-node entry, no Vite: `tsc -p tsconfig.examples.json`, then
// `node dist/examples/kitchen-sink/src/server.js`. The stylesheet and hero
// image are served straight from the source folder, public/ from the site root.
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const source = fileURLToPath(new URL("../../../../examples/kitchen-sink/src/", import.meta.url));
const publicFiles = fileURLToPath(new URL("../../../../examples/kitchen-sink/public/", import.meta.url));

const server = await createApp()
  .discover(new URL("./routes/", import.meta.url))
  .static("/src", source, { extensions: [".css", ".svg"] })
  .static("/", publicFiles)
  .listen(Number(process.env.PORT ?? 3300));

console.log(`yerd bazaar on ${server.url}`);
