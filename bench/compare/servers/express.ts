// Express 5: express.json() for bodies, a hand-written check, route middleware for /secure, React SSR.
import express, { type NextFunction, type Request, type Response } from "express";
import { renderPage } from "./react-page.js";
import { BEARER, HOST, PORT, checkEcho, userReply } from "./shared.js";

const app = express();
app.use(express.json());

app.get("/json", (_req, res) => {
  res.json({ hello: "world" });
});

app.get("/users/:id", (req, res) => {
  res.json(userReply(req.params.id, typeof req.query.fields === "string" ? req.query.fields : undefined));
});

app.post("/echo", (req, res) => {
  const issue = checkEcho(req.body);
  if (issue) {
    res.status(400).json({ error: issue });
    return;
  }
  res.json({ ok: true, name: req.body.name, age: req.body.age });
});

function auth(req: Request, res: Response, next: NextFunction) {
  if (req.headers.authorization !== BEARER) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

app.get("/secure", auth, (_req, res) => {
  res.json({ ok: true, user: "bench" });
});

app.get("/page", (_req, res) => {
  res.type("html").send(renderPage());
});

app.listen(PORT, HOST, () => console.log("ready"));
