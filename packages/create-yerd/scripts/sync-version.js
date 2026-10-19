// @ts-check
// Sets create-yerd's version to yerd's. The root package.json runs it from its
// `version` script, so `npm version patch` bumps both in one commit.
import { readFileSync, writeFileSync } from "node:fs";

const rootFile = new URL("../../../package.json", import.meta.url);
const ownFile = new URL("../package.json", import.meta.url);

const { version } = JSON.parse(readFileSync(rootFile, "utf8"));
const text = readFileSync(ownFile, "utf8");
const next = text.replace(/("version":\s*)"[^"]*"/, `$1${JSON.stringify(version)}`);
if (next !== text) writeFileSync(ownFile, next);
console.log(`create-yerd ${version}`);
