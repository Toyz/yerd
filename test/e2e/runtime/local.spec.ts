import { expect, test } from "@playwright/test";
import { holdRequests } from "./helpers.js";

/** The local chunk's URL: the core imports it (and <Scripts /> preloads it) when the page has a <Local>. */
const LOCAL_CHUNK = /\/_yerd\/runtime-local\.js/;

test("handlers update the state, and text, attribute and hidden bindings follow", async ({ page }) => {
  await page.goto("/local");
  await page.getByRole("button", { name: "Add one" }).click();
  await page.getByRole("button", { name: "Add one" }).click();
  await expect(page.locator("#count")).toHaveText("2");

  const toggle = page.getByRole("button", { name: "Toggle the secret" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#secret")).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#secret")).toBeVisible();
});

test("persist: the state survives a reload, and scopes sharing the key stay in step", async ({ page }) => {
  await page.goto("/local");
  await page.evaluate(() => localStorage.removeItem("yerd-local:fx-likes"));
  await page.reload();
  await page.getByRole("button", { name: "Like" }).click();
  await page.getByRole("button", { name: "Like" }).click();
  await expect(page.locator("#likes")).toHaveText("2");
  await expect(page.locator("#likes-mirror")).toHaveText("2");

  await page.reload();
  // The server renders the defaults; the saved state shows once the runtime starts.
  await expect(page.locator("#likes")).toHaveText("2");
  await expect(page.locator("#likes-mirror")).toHaveText("2");
  await page.getByRole("button", { name: "Like" }).click();
  await expect(page.locator("#likes-mirror")).toHaveText("3");
});

test("clicks made before the local chunk has loaded are replayed once it arrives", async ({ page }) => {
  // Keep the chunk from arriving until the clicks are in.
  const chunk = await holdRequests(page, LOCAL_CHUNK);
  // Not "load": WebKit holds the load event for the chunk's modulepreload.
  await page.goto("/local", { waitUntil: "domcontentloaded" });
  await expect.poll(() => chunk.held.length).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Add one" }).click();
  await page.getByRole("button", { name: "Add one" }).click();
  await page.getByRole("button", { name: "Toggle the secret" }).click();
  // Nothing can run them yet: the server's values stand.
  await expect(page.locator("#count")).toHaveText("0");
  await expect(page.locator("#secret")).toBeHidden();

  await chunk.release();
  await expect(page.locator("#count")).toHaveText("2");
  await expect(page.locator("#secret")).toBeVisible();
});

test("a link clicked before the chunk loads runs its handler first, then follows the link", async ({ page }) => {
  const chunk = await holdRequests(page, LOCAL_CHUNK);
  // Not "load": WebKit holds the load event for the chunk's modulepreload.
  await page.goto("/local", { waitUntil: "domcontentloaded" });
  await expect.poll(() => chunk.held.length).toBeGreaterThan(0);
  await page.evaluate(() => sessionStorage.removeItem("yerd-local:fx-visited"));

  await page.getByRole("link", { name: "Onward" }).click();
  // Held: the handler might have cancelled the navigation, so it waits for the chunk.
  await expect(page).toHaveURL(/\/local$/);

  await chunk.release();
  await expect(page).toHaveURL(/\/local\/onward$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Onward");
  // The handler ran before the navigation: its state was saved for this tab.
  expect(await page.evaluate(() => sessionStorage.getItem("yerd-local:fx-visited"))).toBe('{"visited":true}');
});
