// Bench app: one route per shape of work. Built with tsc (tsconfig.bench.json), run by bench/run.mjs.
import { get, inject, param, query, route, service, toInt, yerd, type Child, type LayoutProps } from "@toyz/yerd";

function Root({ children, meta }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{meta.title ?? "bench"}</title>
      </head>
      <body>
        <header><nav><a href="/">home</a> <a href="/about">about</a></nav></header>
        <main>{children}</main>
      </body>
    </html>
  );
}

const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, title: `Row number ${i}`, done: i % 3 === 0 }));

function Row({ row }: { row: (typeof rows)[number] }) {
  return (
    <li class={["row", { done: row.done }]} data-id={row.id}>
      <span class="title">{row.title}</span> <a href={`/rows/${row.id}`}>open</a>
    </li>
  );
}

async function Slow({ children }: { children: Child }) {
  await Promise.resolve();
  return <section>{children}</section>;
}

@service
class Store {
  find(id: number) {
    return rows[id % rows.length]!;
  }
}

@route("/plain")
export class Plain {
  @get go() {
    return "hello world";
  }
}

@route("/json")
export class Json {
  @get go() {
    return { hello: "world", n: 42, list: [1, 2, 3] };
  }
}

@route("/page", { meta: { title: "page" } })
export class Page {
  @get go() {
    return <ul class="rows">{rows.map((row) => <Row row={row} />)}</ul>;
  }
}

@route("/page-async", { meta: { title: "async" } })
export class PageAsync {
  @get go() {
    return <Slow><ul class="rows">{rows.map((row) => <Row row={row} />)}</ul></Slow>;
  }
}

@route("/rows/:id")
export class RowRoute {
  @inject(Store) accessor store!: Store;
  @param("id", { transform: toInt }) accessor id!: number;
  @query("format") accessor format = "html";
  @get go() {
    return { row: this.store.find(this.id), format: this.format };
  }
}

const server = await yerd({ handleSignals: true })
  .layout(Root)
  .listen(Number(process.env.PORT ?? 4100), "127.0.0.1");
console.log(`bench app on ${server.url}`);
