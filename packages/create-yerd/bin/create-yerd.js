#!/usr/bin/env node
import { main } from "../src/cli.js";

try {
  process.exitCode = await main({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
} catch (error) {
  // Anything unexpected (a folder it can't write to...): the message, not a stack trace.
  process.stderr.write(`error ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
