import { expect, test } from "@playwright/test";

// examples/hello: the smallest app. Pages, a streamed component, JSON, NDJSON and a DTO.

test("the home page renders in the layout, with its nav", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-type"]).toBe("text/html; charset=utf-8");
  await expect(page).toHaveTitle("yerd");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("yerd");
  await expect(page.getByRole("link", { name: "user 7" })).toHaveAttribute("href", "/users/7");
});

test("a user page streams its async posts in, with params and query parsed", async ({ page }) => {
  await page.goto("/users/7?tab=likes");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ada");
  await expect(page.getByText("tab: likes")).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveText(["on engines", "notes on notes"]);

  await page.getByRole("link", { name: "home" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("an unknown user is a 404, and a bad id fails the transform", async ({ request }) => {
  expect((await request.get("/users/99")).status()).toBe(404);
  expect((await request.get("/users/abc")).status()).toBe(400);
});

test("JSON, text and NDJSON routes", async ({ request }) => {
  const health = await request.get("/api/health");
  expect(health.headers()["content-type"]).toBe("application/json; charset=utf-8");
  expect(await health.json()).toMatchObject({ ok: true });

  expect(await (await request.get("/ping")).text()).toBe("pong");

  const stats = await request.get("/api/stats");
  expect(await stats.json()).toMatchObject({ visits: expect.any(Number), beats: expect.any(Number) });

  const ticks = await request.get("/api/ticks?count=2");
  expect(ticks.headers()["content-type"]).toMatch(/^application\/x-ndjson/);
  const lines = (await ticks.text()).trim().split("\n").map((line) => JSON.parse(line) as { tick: number });
  expect(lines.map((line) => line.tick)).toEqual([1, 2]);
  // @ndjson sends its headers right away and the generator reads ?count once it runs,
  // so a bad count is the stream's last line (errors mid-stream), not a 400.
  const tooMany = await request.get("/api/ticks?count=500");
  expect(tooMany.status()).toBe(200);
  expect((await tooMany.text()).trim()).toBe('{"error":"Must be from 1 to 100 (got 500)"}');
});

test("the signup DTO trims, lowercases and validates", async ({ request }) => {
  const ok = await request.post("/api/signup", { data: { email: " ADA@x.io ", age: 36 } });
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toEqual({ welcome: "ada@x.io", plan: "free" });

  const bad = await request.post("/api/signup", { data: { email: "nope", age: 7 } });
  expect(bad.status()).toBe(400);
  const issues = ((await bad.json()) as { issues: Array<{ path: string }> }).issues.map((issue) => issue.path);
  expect(issues.sort()).toEqual(["age", "email"]);
});
