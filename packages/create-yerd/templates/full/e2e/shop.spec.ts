import { expect, test } from "@playwright/test";

// What only a browser shows: the runtime morphs the answer in, no reload.
// Everything else is covered faster by test/shop.test.ts.
test("adds to the cart without reloading the page", async ({ page }) => {
  await page.goto("/products/2");
  // A marker a reload would wipe.
  await page.evaluate(() => ((window as unknown as { marker: boolean }).marker = true));

  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.locator("#cart-badge .badge")).toHaveText("1");
  await expect(page.locator("#stock")).toHaveText("25 in stock");
  expect(await page.evaluate(() => (window as unknown as { marker?: boolean }).marker)).toBe(true);

  await page.locator("#cart-badge").click();
  await expect(page).toHaveTitle("Your cart · {{name}}");
  await expect(page.getByRole("link", { name: "Pocket notebook" })).toBeVisible();
});
