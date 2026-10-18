// Fastify 5: JSON schema validation for the body, an onRequest hook for /secure, React SSR.
import Fastify from "fastify";
import { renderPage } from "./react-page.js";
import { BEARER, HOST, PORT, userReply, type Echo } from "./shared.js";

const app = Fastify({ logger: false });

app.get("/json", async () => ({ hello: "world" }));

app.get<{ Params: { id: string }; Querystring: { fields?: string } }>("/users/:id", async (req) =>
  userReply(req.params.id, req.query.fields),
);

app.post<{ Body: Echo }>(
  "/echo",
  {
    schema: {
      body: {
        type: "object",
        required: ["name", "age"],
        properties: {
          name: { type: "string", minLength: 1 },
          age: { type: "number" },
        },
      },
    },
  },
  async (req) => ({ ok: true, name: req.body.name, age: req.body.age }),
);

app.get(
  "/secure",
  {
    onRequest: async (req, reply) => {
      if (req.headers.authorization !== BEARER) return reply.code(401).send({ error: "Unauthorized" });
    },
  },
  async () => ({ ok: true, user: "bench" }),
);

app.get("/page", async (_req, reply) => {
  reply.type("text/html; charset=utf-8");
  return renderPage();
});

await app.listen({ port: PORT, host: HOST });
console.log("ready");
