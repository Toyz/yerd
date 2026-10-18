/** @jsxImportSource hono/jsx */
// Hono on @hono/node-server: a hand-written body check, route middleware for /secure, Hono JSX for /page.
import { serve } from "@hono/node-server";
import { Hono, type MiddlewareHandler } from "hono";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import { BEARER, HOST, PORT, ROWS, checkEcho, userReply } from "./shared.js";

function Layout({ title, children }: { title: string; children: Child }) {
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
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
    </>
  );
}

const app = new Hono();

app.get("/json", (c) => c.json({ hello: "world" }));

app.get("/users/:id", (c) => c.json(userReply(c.req.param("id"), c.req.query("fields"))));

app.post("/echo", async (c) => {
  const input = await c.req.json();
  const issue = checkEcho(input);
  if (issue) return c.json({ error: issue }, 400);
  return c.json({ ok: true, name: input.name, age: input.age });
});

const auth: MiddlewareHandler = async (c, next) => {
  if (c.req.header("authorization") !== BEARER) return c.json({ error: "Unauthorized" }, 401);
  await next();
};

app.get("/secure", auth, (c) => c.json({ ok: true, user: "bench" }));

app.get("/page", (c) =>
  c.html(
    <Layout title="Bench page">
      <h1>Rows</h1>
      <ul class="rows">
        {ROWS.map((row) => (
          <li class="row" data-id={row.id}>
            <span class="title">{row.title}</span>
            <a href={`/rows/${row.id}`}>open</a>
          </li>
        ))}
      </ul>
    </Layout>,
  ),
);

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => console.log("ready"));
