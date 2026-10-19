import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import "../src/routes/home.js";

// The app main.ts serves, with the routes this file imports. No port is opened.
const app = createApp({ handleSignals: false });
beforeAll(() => app.boot());
afterAll(() => app.stop());

const html = { accept: "text/html" };

it("renders the home page inside the layout", async () => {
  const res = await app.request("/", { headers: html });
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("<title>Home · {{name}}</title>");
  expect(body).toContain("Clicked 0 times");
});

it("counts clicks in the visitor's session", async () => {
  const client = app.client();
  await client.action("/", {});
  const res = await client.action("/", {});
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Clicked 2 times");

  // Another visitor has a session of their own.
  expect(await app.client().page("/")).toContain("Clicked 0 times");
});

it("answers an unknown path with the error page", async () => {
  const res = await app.request("/nope", { headers: html });
  expect(res.status).toBe(404);
  expect(await res.text()).toContain("Page not found");
});
