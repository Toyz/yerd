// Compares yerd with other Node frameworks under autocannon.
//
//   npm install && npm run build        (build yerd first: `npm run build` at the repo root)
//   node run.mjs [--frameworks yerd,fastify] [--scenarios json,ssr] [--duration 10]
//                [--warmup 3] [--runs 3] [--connections 100] [--workers 4] [--write]
//                [--server-cpus 8,9 --client-cpus 10-15]   (Linux: pin with taskset)
//
// Each server runs in its own child process (NODE_ENV=production), is checked for correct
// responses, then measured: one warmup, then `runs` measured runs per scenario; the run with
// the median req/s is reported. A full run (no filters, default settings) writes results.json
// and refreshes the table in README.md; partial runs only print, unless --write is given.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { Worker } from "node:worker_threads";

const here = dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";
const TOKEN = "Bearer bench-secret-token";

const DEFAULTS = { duration: 10, warmup: 3, runs: 3, connections: 100, pipelining: 1, workers: 4 };

const { values: args } = parseArgs({
  options: {
    frameworks: { type: "string" },
    scenarios: { type: "string" },
    duration: { type: "string" },
    warmup: { type: "string" },
    runs: { type: "string" },
    connections: { type: "string" },
    workers: { type: "string" },
    "server-cpus": { type: "string" },
    "client-cpus": { type: "string" },
    write: { type: "boolean", default: false },
  },
});

const settings = {
  duration: Number(args.duration ?? DEFAULTS.duration),
  warmup: Number(args.warmup ?? DEFAULTS.warmup),
  runs: Number(args.runs ?? DEFAULTS.runs),
  connections: Number(args.connections ?? DEFAULTS.connections),
  pipelining: DEFAULTS.pipelining,
  workers: Number(args.workers ?? DEFAULTS.workers),
};

// Optional CPU pinning (Linux, taskset): keeps the server and the client on fixed cores, so
// results don't swing with where the scheduler happens to put them (e.g. which CCD on a
// two-die Ryzen). The client pins the whole harness process; worker threads inherit it.
const serverCpus = args["server-cpus"];
const clientCpus = args["client-cpus"];
// The server would inherit the client's pinning, so both or neither.
if (Boolean(serverCpus) !== Boolean(clientCpus)) throw new Error("pass --server-cpus and --client-cpus together");
if (clientCpus) execFileSync("taskset", ["-a", "-pc", clientCpus, String(process.pid)], { stdio: "ignore" });

// ---------------------------------------------------------------- frameworks

function pkgVersion(name) {
  const path = name === "@toyz/yerd" ? join(here, "../../package.json") : join(here, "node_modules", name, "package.json");
  return JSON.parse(readFileSync(path, "utf8")).version;
}

const FRAMEWORKS = [
  { id: "yerd", name: "yerd", pkg: "@toyz/yerd", url: "https://github.com/Toyz/yerd", entry: "dist/yerd.js" },
  { id: "express", name: "Express", pkg: "express", url: "https://expressjs.com", entry: "dist/express.js" },
  { id: "fastify", name: "Fastify", pkg: "fastify", url: "https://fastify.dev", entry: "dist/fastify.js" },
  { id: "hono", name: "Hono", pkg: "hono", url: "https://hono.dev", entry: "dist/hono.js" },
  { id: "koa", name: "Koa", pkg: "koa", url: "https://koajs.com", entry: "dist/koa.js" },
  { id: "nest", name: "NestJS (Fastify)", pkg: "@nestjs/core", url: "https://nestjs.com", entry: "dist/nest.js" },
  { id: "node", name: "node:http (baseline)", url: "https://nodejs.org/api/http.html", entry: "dist/node.js" },
].map((f, i) => ({ ...f, port: 3101 + i, version: f.pkg ? pkgVersion(f.pkg) : process.versions.node }));

// ---------------------------------------------------------------- scenarios

// ~1 KB JSON body for POST /echo. Only name and age are validated; the rest is payload.
const ECHO_BODY = JSON.stringify({
  name: "Ada Lovelace",
  age: 36,
  email: "ada@example.com",
  bio: "Mathematician and writer, chiefly known for her work on Charles Babbage's proposed mechanical general-purpose computer, the Analytical Engine. ".repeat(5),
  tags: ["math", "computing", "engines", "notes", "poetry", "science"],
  address: { street: "12 St James's Square", city: "London", country: "UK" },
});

const json = (res) => res.headers.get("content-type")?.includes("application/json");
const html = (res) => res.headers.get("content-type")?.includes("text/html");

async function expectJson(res, status, expected) {
  const body = await res.text();
  const ok = (Array.isArray(status) ? status.includes(res.status) : res.status === status) && json(res);
  if (!ok) return `status ${res.status}, content-type ${res.headers.get("content-type")}: ${body.slice(0, 200)}`;
  if (expected !== undefined) {
    const parsed = JSON.parse(body);
    if (!isDeepStrictEqual(parsed, expected)) return `body ${body.slice(0, 200)}, expected ${JSON.stringify(expected)}`;
  }
  return undefined;
}

const SCENARIOS = [
  {
    id: "json",
    title: "JSON hello",
    description: 'GET /json returns {"hello":"world"}.',
    request: { path: "/json" },
    async verify(base) {
      return expectJson(await fetch(base + "/json"), 200, { hello: "world" });
    },
  },
  {
    id: "params",
    title: "Route and query params",
    description: "GET /users/42?fields=a,b echoes the id as a number and the fields as a list.",
    request: { path: "/users/42?fields=a,b" },
    async verify(base) {
      return expectJson(await fetch(base + "/users/42?fields=a,b"), 200, { id: 42, fields: ["a", "b"] });
    },
  },
  {
    id: "body",
    title: "Validated JSON body",
    description: "POST /echo with a ~1 KB JSON body; name (string) and age (number) are validated, the reply echoes them.",
    request: { path: "/echo", method: "POST", headers: { "content-type": "application/json" }, body: ECHO_BODY },
    async verify(base) {
      const post = (body) => fetch(base + "/echo", { method: "POST", headers: { "content-type": "application/json" }, body });
      const good = await expectJson(await post(ECHO_BODY), [200, 201], { ok: true, name: "Ada Lovelace", age: 36 });
      if (good) return good;
      const bad = await post(JSON.stringify({ name: "Ada Lovelace", age: "old" }));
      await bad.text();
      if (bad.status !== 400) return `an invalid body got ${bad.status}, expected 400`;
      return undefined;
    },
  },
  {
    id: "ssr",
    title: "Server-rendered page",
    description: "GET /page renders a layout (head, nav, footer) and a list of 100 rows of escaped text.",
    request: { path: "/page" },
    async verify(base, framework) {
      const res = await fetch(base + "/page");
      const body = await res.text();
      if (res.status !== 200 || !html(res)) return `status ${res.status}, content-type ${res.headers.get("content-type")}`;
      if (!/^<!doctype html>/i.test(body)) return "missing doctype";
      const rows = body.match(/<li class="row"/g)?.length ?? 0;
      if (rows !== 100) return `${rows} rows, expected 100`;
      if (body.includes("<b>bold</b>") || !body.includes("&lt;b&gt;bold&lt;/b&gt; &amp;")) return "row text isn't escaped";
      if (!body.includes("<title>Bench page</title>") || !body.includes('<a href="/contact">Contact</a>')) return "layout missing";
      framework.pageBytes = Buffer.byteLength(body);
      return undefined;
    },
  },
  {
    id: "middleware",
    title: "Auth middleware",
    description: "GET /secure behind an auth check on the Authorization header (a guard in yerd and Nest, a hook or middleware elsewhere).",
    request: { path: "/secure", headers: { authorization: TOKEN } },
    async verify(base) {
      const denied = await fetch(base + "/secure");
      await denied.text();
      if (denied.status !== 401) return `no token got ${denied.status}, expected 401`;
      return expectJson(await fetch(base + "/secure", { headers: { authorization: TOKEN } }), 200, { ok: true, user: "bench" });
    },
  },
];

// ---------------------------------------------------------------- filters

function pick(list, filter, kind) {
  if (!filter) return list;
  const ids = filter.split(",").map((s) => s.trim()).filter(Boolean);
  for (const id of ids) if (!list.some((x) => x.id === id)) throw new Error(`unknown ${kind} "${id}"; known: ${list.map((x) => x.id).join(", ")}`);
  return list.filter((x) => ids.includes(x.id));
}

const frameworks = pick(FRAMEWORKS, args.frameworks, "framework");
const scenarios = pick(SCENARIOS, args.scenarios, "scenario");
const fullRun =
  !args.frameworks && !args.scenarios && Object.entries(DEFAULTS).every(([k, v]) => settings[k] === v);
const writeResults = fullRun || args.write;

// ---------------------------------------------------------------- servers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(framework) {
  const command = [process.execPath, join(here, framework.entry)];
  if (serverCpus) command.unshift("taskset", "-c", serverCpus);
  const child = spawn(command[0], command.slice(1), {
    cwd: here,
    env: { ...process.env, PORT: String(framework.port), NODE_ENV: "production", YERD_SECRET: "bench-secret-0123456789abcdef0123456789abcdef" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  let exited = false;
  child.on("exit", () => (exited = true));
  const base = `http://${HOST}:${framework.port}`;
  for (let waited = 0; waited < 20_000; waited += 100) {
    if (exited) throw new Error(`${framework.id} exited during startup:\n${output}`);
    try {
      const res = await fetch(base + "/json");
      await res.text();
      return { child, base, output: () => output };
    } catch {
      await sleep(100);
    }
  }
  child.kill("SIGKILL");
  throw new Error(`${framework.id} didn't answer on ${base} within 20 s:\n${output}`);
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const force = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

// ---------------------------------------------------------------- measuring

// One autocannon thread tops out around 125k req/s on a fast machine, which would cap the fastest
// servers at the client's speed. So the connections are split across `workers` worker threads
// (cannon-worker.mjs), each running its own autocannon; they start together and their results are
// summed. Each worker also records every 2xx response time, because autocannon's histogram rounds
// latencies to whole milliseconds; p50/p99 come from all of them together.
async function cannon(base, request, duration, collect) {
  const n = Math.max(1, Math.min(settings.workers, settings.connections));
  const options = (i) => ({
    url: base + request.path,
    method: request.method ?? "GET",
    headers: request.headers,
    body: request.body,
    connections: Math.floor(settings.connections / n) + (i < settings.connections % n ? 1 : 0),
    pipelining: settings.pipelining,
    duration,
  });
  const workers = Array.from({ length: n }, (_, i) => new Worker(join(here, "cannon-worker.mjs"), { workerData: { options: options(i), collect } }));
  try {
    const next = (worker) =>
      new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
    await Promise.all(workers.map(next)); // all ready
    const done = workers.map(next);
    for (const worker of workers) worker.postMessage("go");
    const parts = await Promise.all(done);
    const failed = parts.find((p) => p.error);
    if (failed) throw new Error(failed.error);
    return parts;
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
}

const round = (n, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

function summarize(parts) {
  const total = parts.reduce((sum, p) => sum + p.latencies.length, 0);
  const all = new Float64Array(total);
  let offset = 0;
  for (const p of parts) {
    all.set(p.latencies, offset);
    offset += p.latencies.length;
  }
  all.sort();
  const at = (p) => all[Math.min(all.length - 1, Math.max(0, Math.ceil((p / 100) * all.length) - 1))];
  return {
    reqPerSec: Math.round(parts.reduce((sum, p) => sum + p.reqPerSec, 0)),
    latencyP50: round(at(50)),
    latencyP99: round(at(99)),
    throughputMBs: round(parts.reduce((sum, p) => sum + p.bytesPerSec, 0) / 1e6),
    errors: parts.reduce((sum, p) => sum + p.errors, 0),
  };
}

async function measure(base, scenario) {
  if (settings.warmup > 0) await cannon(base, scenario.request, settings.warmup, false);
  const runs = [];
  for (let i = 0; i < settings.runs; i++) runs.push(summarize(await cannon(base, scenario.request, settings.duration, true)));
  const sorted = [...runs].sort((a, b) => a.reqPerSec - b.reqPerSec);
  return { median: sorted[Math.floor((sorted.length - 1) / 2)], runs };
}

// ---------------------------------------------------------------- main

const load = () => os.loadavg().map((n) => n.toFixed(2)).join(" ");
const loadAtStart = load();
console.log(
  `autocannon: ${settings.connections} connections, pipelining ${settings.pipelining}, ${settings.warmup}s warmup + ${settings.runs} x ${settings.duration}s` +
    `, client split across ${settings.workers} worker threads; load average ${loadAtStart}`,
);

const results = new Map(scenarios.map((s) => [s.id, []]));
const skipped = [];

for (const framework of frameworks) {
  console.log(`\n${framework.name} ${framework.version}`);
  const server = await start(framework);
  try {
    const ready = [];
    for (const scenario of scenarios) {
      const problem = await scenario.verify(server.base, framework).catch((error) => `request failed: ${error.message}`);
      if (problem) {
        console.log(`  ${scenario.id}: FAILED verification, skipped (${problem})`);
        skipped.push(`${framework.id}/${scenario.id}: ${problem}`);
      } else ready.push(scenario);
    }
    for (const scenario of ready) {
      const { median, runs } = await measure(server.base, scenario);
      results.get(scenario.id).push({ framework: framework.id, ...median });
      console.log(
        `  ${scenario.id.padEnd(10)} ${String(median.reqPerSec).padStart(7)} req/s  p50 ${median.latencyP50} ms  p99 ${median.latencyP99} ms` +
          `  ${median.throughputMBs} MB/s  errors ${median.errors}   (runs: ${runs.map((r) => r.reqPerSec).join(", ")})`,
      );
    }
  } finally {
    await stop(server.child);
  }
}

const loadAtEnd = load();

// Same markup size across frameworks, within a few percent.
const pages = frameworks.filter((f) => f.pageBytes);
if (pages.length > 1) {
  const ref = pages.find((f) => f.id === "yerd") ?? pages[0];
  console.log(`\n/page size: ${pages.map((f) => `${f.id} ${f.pageBytes} B`).join(", ")}`);
  for (const f of pages) {
    const diff = Math.abs(f.pageBytes - ref.pageBytes) / ref.pageBytes;
    if (diff > 0.03) console.log(`  WARNING: ${f.id}'s page is ${(diff * 100).toFixed(1)}% off ${ref.id}'s`);
  }
}

// ---------------------------------------------------------------- report

function tables(markdown) {
  const out = [];
  for (const scenario of scenarios) {
    const rows = [...results.get(scenario.id)].sort((a, b) => b.reqPerSec - a.reqPerSec);
    if (rows.length === 0) continue;
    const best = Math.max(...rows.filter((r) => r.framework !== "node").map((r) => r.reqPerSec), 1);
    const header = ["framework", "req/s", "vs best", "p50 ms", "p99 ms", "MB/s", "errors"];
    const body = rows.map((r) => [
      FRAMEWORKS.find((f) => f.id === r.framework).name,
      r.reqPerSec.toLocaleString("en-US"),
      r.framework === "node" ? "-" : `${Math.round((r.reqPerSec / best) * 100)}%`,
      r.latencyP50.toFixed(2),
      r.latencyP99.toFixed(2),
      r.throughputMBs.toFixed(2),
      String(r.errors),
    ]);
    if (markdown) {
      out.push(`### ${scenario.title} (\`${scenario.id}\`)\n`);
      out.push(`| ${header.join(" | ")} |`, `| --- | ${header.slice(1).map(() => "---:").join(" | ")} |`);
      for (const row of body) out.push(`| ${row.join(" | ")} |`);
      out.push("");
    } else {
      const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
      const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
      out.push(`\n${scenario.title} (${scenario.id})`, line(header), widths.map((w) => "-".repeat(w)).join("  "));
      for (const row of body) out.push(line(row));
    }
  }
  return out.join("\n");
}

console.log(tables(false));
console.log(`\nload average at start ${loadAtStart}, at end ${loadAtEnd}`);
if (skipped.length) console.log(`skipped:\n  ${skipped.join("\n  ")}`);

if (!writeResults) {
  console.log("\n(partial run: results.json not written; pass --write to write it anyway)");
  process.exit(0);
}

const cpus = os.cpus();
const report = {
  generated: new Date().toISOString(),
  machine: {
    cpu: cpus[0]?.model.trim() ?? "unknown",
    cores: cpus.length,
    memory: `${Math.round(os.totalmem() / 2 ** 30)} GB`,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    node: process.version,
  },
  tool: {
    name: "autocannon",
    connections: settings.connections,
    duration: settings.duration,
    pipelining: settings.pipelining,
    runs: settings.runs,
    warmup: settings.warmup,
  },
  frameworks: frameworks.map(({ id, name, version, url }) => ({ id, name, version, url })),
  scenarios: scenarios.map(({ id, title, description }) => ({ id, title, description, results: results.get(id) })),
  notes: [
    "Single process per server, no clustering. Client and server run on the same machine, so absolute numbers are machine-bound; compare ratios.",
    `Each scenario: ${settings.warmup}s warmup, then ${settings.runs} runs of ${settings.duration}s with ${settings.connections} connections in total, pipelining ${settings.pipelining}, keep-alive on. The run with the median req/s is reported. MB/s is decimal (10^6 bytes).`,
    `The client is ${settings.workers} autocannon instances in worker threads sharing the ${settings.connections} connections, started together and summed: a single autocannon thread tops out around 125k req/s on this machine, which capped the fastest servers. p50/p99 are computed from every 2xx response's own time (autocannon's histogram rounds to whole milliseconds).`,
    "Every server runs with NODE_ENV=production and request logging off (yerd: logging({ filter: \"warn\" }); Fastify: logger false; Nest: logger false; the others log nothing by default).",
    "Validation for POST /echo: yerd a DTO class with is.string()/is.number() via @body; Fastify a JSON schema (Ajv); Nest class-validator DTO through the global ValidationPipe; Express, Koa, Hono and the node:http baseline the same small hand-written check. Every server rejects an invalid body with 400 before measuring.",
    "Body parsing: Express express.json(), Koa @koa/bodyparser, Hono c.req.json(), Fastify and Nest Fastify's built-in parser, yerd its built-in body reader.",
    "SSR engine for /page: yerd TSX (its own JSX runtime, layout + route); Hono hono/jsx; Express, Fastify, Koa and Nest React 19 renderToString from react-dom/server. node:http concatenates template strings. Markup sizes are checked to be within 3% of each other.",
    "yerd streams pages (chunked transfer encoding); the React-based servers and Hono send one buffered string with a content-length.",
    "Per request yerd also builds a request context, creates the route class instance through its DI container in a request scope (C#-style scoped lifetime), resolves decorated accessors, and adds an x-content-type-options: nosniff header. Express adds an ETag on res.json/res.send by default; kept, since it is the default.",
    "The auth check compares the Authorization header with a fixed token: a createGuard guard in yerd, a CanActivate guard in Nest, a route onRequest hook in Fastify, route middleware in Express, Koa and Hono.",
    `NestJS ${pkgVersion("@nestjs/core")} uses @nestjs/platform-fastify (Fastify ${pkgVersion("fastify")} as bundled by Nest). Hono runs on @hono/node-server ${pkgVersion("@hono/node-server")}. Koa uses @koa/router ${pkgVersion("@koa/router")} and @koa/bodyparser ${pkgVersion("@koa/bodyparser")}. React ${pkgVersion("react")}.`,
    "node:http (baseline) is not a framework: a hand-rolled router on plain node:http, shown as a ceiling. 'vs best' percentages compare frameworks only.",
    serverCpus
      ? `CPU pinning (taskset): each server on CPUs ${serverCpus}, the client on CPUs ${clientCpus}, so results don't swing with where the scheduler puts them.`
      : "No CPU pinning.",
    `1-minute/5-minute/15-minute load average: ${loadAtStart} at start, ${loadAtEnd} at end.`,
  ],
};

writeFileSync(join(here, "results.json"), JSON.stringify(report, null, 2) + "\n");
console.log("\nwrote results.json");

// Refresh the results table in README.md between its markers.
const readmePath = join(here, "README.md");
try {
  const readme = readFileSync(readmePath, "utf8");
  const start = "<!-- results:start -->";
  const end = "<!-- results:end -->";
  const a = readme.indexOf(start);
  const b = readme.indexOf(end);
  if (a !== -1 && b > a) {
    const header =
      `Generated ${report.generated.slice(0, 10)} on ${report.machine.cpu} (${report.machine.cores} cores, ${report.machine.memory}), ` +
      `${report.machine.os}, Node ${report.machine.node}. Load average ${loadAtStart} at start.\n\n`;
    writeFileSync(readmePath, readme.slice(0, a + start.length) + "\n" + header + tables(true) + "\n" + readme.slice(b));
    console.log("updated README.md");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
