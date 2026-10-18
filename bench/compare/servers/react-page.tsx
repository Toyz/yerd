/** @jsxImportSource react */
// The /page markup as React components, rendered with react-dom/server's renderToString.
// Express, Fastify, Koa and Nest call renderPage() from their handlers.
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { ROWS, type Row } from "./shared.js";

function Layout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
      </head>
      <body>
        <header>
          <nav>
            <a href="/">Home</a>
            <a href="/about">About</a>
            <a href="/contact">Contact</a>
          </nav>
        </header>
        <main>{children}</main>
        <footer>bench footer</footer>
      </body>
    </html>
  );
}

function Rows({ rows }: { rows: Row[] }) {
  return (
    <>
      <h1>Rows</h1>
      <ul className="rows">
        {rows.map((row) => (
          <li key={row.id} className="row" data-id={row.id}>
            <span className="title">{row.title}</span>
            <a href={`/rows/${row.id}`}>open</a>
          </li>
        ))}
      </ul>
    </>
  );
}

export function renderPage(): string {
  return (
    "<!DOCTYPE html>" +
    renderToString(
      <Layout title="Bench page">
        <Rows rows={ROWS} />
      </Layout>,
    )
  );
}
