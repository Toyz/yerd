// M0 spike runner: import the island in Node, then serve the repo and load the
// same file in headless Chrome through an import map.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const chrome = process.env.CHROME ?? "google-chrome-stable";

const { report: nodeReport } = await import("../../../dist/spikes/m0/island/counter.js");
console.log("node:   ", JSON.stringify(nodeReport));

const types = { ".js": "text/javascript", ".html": "text/html", ".map": "application/json" };
const server = createServer(async (req, res) => {
  const path = normalize(new URL(req.url, "http://x").pathname).replace(/^(\.\.[/\\])+/, "");
  const file = path === "/" ? "spikes/m0/island/page.html" : path.slice(1);
  try {
    const body = await readFile(join(root, file));
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

execFile(
  chrome,
  ["--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=5000", "--dump-dom", url],
  { timeout: 30000 },
  (err, stdout) => {
    server.close();
    if (err) {
      console.log("browser: FAILED", err.message);
      process.exit(1);
    }
    const m = stdout.match(/<pre id="out">([\s\S]*?)<\/pre>/);
    console.log("browser:", m ? m[1].replace(/&quot;/g, '"') : "no output");
  },
);
