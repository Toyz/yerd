import { expect, test } from "@playwright/test";
import { actionName, isBoost, notice } from "./helpers.js";

test("an action that starts the session rebinds the page's other tokens, so the next click works", async ({ page }) => {
  await page.goto("/session");
  const greetToken = () => page.locator('#greet-form input[name="_yx"]').inputValue();
  const before = await greetToken();

  const start = page.waitForResponse((response) => actionName(response.request()) === "start");
  // The quiet re-fetch the runtime makes for fresh tokens.
  const rebind = page.waitForResponse((response) => isBoost(response.request()) && new URL(response.url()).pathname === "/session");
  await page.getByRole("button", { name: "Start a session" }).click();
  expect((await start).headers()["yx-rebind"]).toBe("1");
  await rebind;
  await expect(page.locator("#who")).toHaveText(/^Signed in as visitor \d+$/);
  await expect.poll(greetToken).not.toBe(before);

  await page.getByRole("button", { name: "Greet me", exact: true }).click();
  await expect(page.locator("#greeting")).toHaveText(/^Hello, visitor \d+$/);
  // The element action's token was swapped too.
  await page.locator("#greeting").evaluate((el) => (el.textContent = ""));
  await page.getByRole("button", { name: "Greet me from a button" }).click();
  await expect(page.locator("#greeting")).toHaveText(/^Hello, visitor \d+$/);
  await expect(notice(page)).toHaveCount(0);
});

test("without the rebind, the old token comes back stale: the page is refreshed and the retry works", async ({ page }) => {
  await page.goto("/session");
  // Stop the runtime's quiet re-fetch, so the page keeps its unbound tokens.
  await page.route("**/session", (route) => (isBoost(route.request()) ? route.abort() : route.fallback()));
  await page.getByRole("button", { name: "Start a session" }).click();
  await expect(page.locator("#who")).toHaveText(/^Signed in as visitor \d+$/);
  await page.unroute("**/session");

  const stale = page.waitForResponse((response) => actionName(response.request()) === "greet");
  await page.getByRole("button", { name: "Greet me", exact: true }).click();
  expect((await stale).headers()["yx-stale"]).toBe("1");
  await expect(notice(page)).toHaveText("This page was out of date, so it's been refreshed. Please try again.");
  await expect(page.locator("#greeting")).toBeEmpty();

  await page.getByRole("button", { name: "Greet me", exact: true }).click();
  await expect(page.locator("#greeting")).toHaveText(/^Hello, visitor \d+$/);
});
