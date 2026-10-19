/**
 * Serves the built runtime fixture for the e2e suite (run after `vite build`):
 *
 * - the main instance, on FIXTURE_PORT (3210), for every runtime spec;
 * - a spare instance, on FIXTURE_SPARE_PORT (3211), which the recovery spec
 *   restarts with a new secret, stops and starts, through
 * - a control server on FIXTURE_CONTROL_PORT (3212): POST /restart, /stop and
 *   /start act on the spare; GET /ready answers once both instances are up
 *   (Playwright's webServer waits on it).
 *
 * The control server is test infrastructure, not part of the app: the app
 * itself has no way to change its secret. Each instance is the real built
 * server (dist/server/server.js) in its own process, so a restart is a real
 * restart.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("./dist/server/server.js", import.meta.url));
const MAIN_PORT = Number(process.env.FIXTURE_PORT ?? 3210);
const SPARE_PORT = Number(process.env.FIXTURE_SPARE_PORT ?? 3211);
const CONTROL_PORT = Number(process.env.FIXTURE_CONTROL_PORT ?? 3212);

const newSecret = (): string => randomBytes(32).toString("base64url");

/** Resolves once something answers HTTP on the port (any status). */
async function listening(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1000) });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`nothing listening on ${port} after ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

interface Instance {
  port: number;
  secret: string;
  child: ChildProcess | undefined;
}

async function start(instance: Instance): Promise<void> {
  if (instance.child) return;
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(instance.port), YERD_SECRET: instance.secret, YERD_LOG: process.env.YERD_LOG ?? "warn" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  instance.child = child;
  child.once("exit", () => {
    if (instance.child === child) instance.child = undefined;
  });
  await listening(instance.port);
}

async function stop(instance: Instance): Promise<void> {
  const child = instance.child;
  if (!child) return;
  instance.child = undefined;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  // Open event streams can hold a graceful shutdown up; a test restart doesn't need one.
  const force = setTimeout(() => child.kill("SIGKILL"), 2000);
  await exited;
  clearTimeout(force);
}

const main: Instance = { port: MAIN_PORT, secret: newSecret(), child: undefined };
const spare: Instance = { port: SPARE_PORT, secret: newSecret(), child: undefined };

await Promise.all([start(main), start(spare)]);

const control = createServer((req, res) => {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const run = async (): Promise<void> => {
    if (req.method === "GET" && path === "/ready") return reply(200, { main: MAIN_PORT, spare: SPARE_PORT });
    if (req.method !== "POST") return reply(405, { error: "POST /restart, /stop or /start" });
    if (path === "/restart") {
      // A new secret, as after a deploy without YERD_SECRET: every open page's tokens are stale.
      await stop(spare);
      spare.secret = newSecret();
      await start(spare);
    } else if (path === "/stop") await stop(spare);
    else if (path === "/start") await start(spare);
    else return reply(404, { error: `no ${path}` });
    reply(200, { running: spare.child !== undefined });
  };
  run().catch((error: unknown) => reply(500, { error: String(error) }));
});
control.listen(CONTROL_PORT, () => console.log(`fixture: main on ${MAIN_PORT}, spare on ${SPARE_PORT}, control on ${CONTROL_PORT}`));

async function shutdown(): Promise<void> {
  control.close();
  await Promise.all([stop(main), stop(spare)]);
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
