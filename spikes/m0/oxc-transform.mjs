import { transformWithOxc } from "vite";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const file = process.argv[2], out = process.argv[3];
const src = readFileSync(file, "utf8");
for (const opts of [
  { label: "default", o: { jsx: { runtime: "automatic", importSource: "@toyz/yerd" } } },
  { label: "target es2022", o: { target: "es2022", jsx: { runtime: "automatic", importSource: "@toyz/yerd" } } },
]) {
  try {
    const r = await transformWithOxc(src, file, opts.o);
    const has = { decoratorsLeft: /^\s*@\w/m.test(r.code), accessorLeft: /\baccessor\s+\w/.test(r.code) };
    console.log(opts.label, "ok", JSON.stringify(has), "warnings:", (r.warnings||[]).length);
    mkdirSync(out, { recursive: true });
    writeFileSync(`${out}/${opts.label.replace(/\s/g,"-")}.js`, r.code);
  } catch (e) { console.log(opts.label, "FAILED:", e.message.split("\n")[0]); }
}
