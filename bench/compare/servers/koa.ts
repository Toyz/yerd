// Koa 3 with @koa/router and @koa/bodyparser: a hand-written check, router middleware for /secure, React SSR.
import { bodyParser } from "@koa/bodyparser";
import Router from "@koa/router";
import Koa, { type Context, type Next } from "koa";
import { renderPage } from "./react-page.js";
import { BEARER, HOST, PORT, checkEcho, userReply } from "./shared.js";

const app = new Koa();
const router = new Router();

router.get("/json", (ctx) => {
  ctx.body = { hello: "world" };
});

router.get("/users/:id", (ctx) => {
  ctx.body = userReply(ctx.params.id!, typeof ctx.query.fields === "string" ? ctx.query.fields : undefined);
});

router.post("/echo", (ctx) => {
  const input = ctx.request.body as { name: string; age: number };
  const issue = checkEcho(input);
  if (issue) {
    ctx.status = 400;
    ctx.body = { error: issue };
    return;
  }
  ctx.body = { ok: true, name: input.name, age: input.age };
});

async function auth(ctx: Context, next: Next) {
  if (ctx.get("authorization") !== BEARER) {
    ctx.status = 401;
    ctx.body = { error: "Unauthorized" };
    return;
  }
  await next();
}

router.get("/secure", auth, (ctx) => {
  ctx.body = { ok: true, user: "bench" };
});

router.get("/page", (ctx) => {
  ctx.type = "html";
  ctx.body = renderPage();
});

app.use(bodyParser());
app.use(router.routes());
app.use(router.allowedMethods());

app.listen(PORT, HOST, () => console.log("ready"));
