// Usage: node bench/run.mjs [seconds]  (build first: npx tsc -p tsconfig.bench.json)
// Starts the baseline and the bench app in their own processes, hits each
// scenario with autocannon, prints a table (requests/s, p50/p99 latency).
import { spawn } from "node:child_process";
import autocannon from "autocannon";

const seconds = Number(process.argv[2] ?? 5);
const connections = 50;

function start(cmd, args, port) {
  const child = spawn(cmd, args, { env: { PORT: String(port), NODE_ENV: "production", YERD_LOG: "warn", ...process.env }, stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.resume(); return new Promise((resolve) => child.stdout.once("data", () => resolve(child)));
}

function hit(url) {
  return new Promise((resolve, reject) =>
    autocannon({ url, connections, duration: seconds, pipelining: 1 }, (err, result) => (err ? reject(err) : resolve(result))),
  );
}

const baseline = await start("node", ["bench/baseline.mjs"], 4101);
const app = await start("node", ["dist/bench/app.js"], 4100);

const scenarios = [
  ["baseline /plain", "http://127.0.0.1:4101/plain"],
  ["baseline /json", "http://127.0.0.1:4101/json"],
  ["yerd /plain", "http://127.0.0.1:4100/plain"],
  ["yerd /json", "http://127.0.0.1:4100/json"],
  ["yerd /rows/7 (DI + params)", "http://127.0.0.1:4100/rows/7?format=json"],
  ["yerd /page (layout + 100 rows)", "http://127.0.0.1:4100/page"],
  ["yerd /page-async", "http://127.0.0.1:4100/page-async"],
];

const rows = [];
for (const [name, url] of scenarios) {
  await hit(url); // warm up (JIT)
  const r = await hit(url);
  rows.push({ scenario: name, "req/s": Math.round(r.requests.average), "p50 ms": r.latency.p50, "p99 ms": r.latency.p99, errors: r.errors + r.non2xx });
}
console.table(rows);
baseline.kill();
app.kill();
