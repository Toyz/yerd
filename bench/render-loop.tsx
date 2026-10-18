// Micro benchmark: render the bench page N times. `node --cpu-prof dist/bench/render-loop.js`
import { renderToString, type Child } from "@toyz/yerd";

const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, title: `Row number ${i}`, done: i % 3 === 0 }));
function Row({ row }: { row: (typeof rows)[number] }) {
  return (
    <li class={["row", { done: row.done }]} data-id={row.id}>
      <span class="title">{row.title}</span> <a href={`/rows/${row.id}`}>open</a>
    </li>
  );
}
function Root({ children }: { children: Child }) {
  return <html lang="en"><head><meta charset="utf-8" /><title>bench</title></head><body><main>{children}</main></body></html>;
}
const page = () => <Root><ul class="rows">{rows.map((row) => <Row row={row} />)}</ul></Root>;

const n = Number(process.argv[2] ?? 20000);
for (let i = 0; i < 2000; i++) await renderToString(page(), { document: true });
const t = performance.now();
for (let i = 0; i < n; i++) await renderToString(page(), { document: true });
const ms = performance.now() - t;
console.log(`${n} renders in ${ms.toFixed(0)}ms: ${((ms / n) * 1000).toFixed(1)}µs per page, ${Math.round(n / (ms / 1000))} pages/s`);
