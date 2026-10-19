import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/regions");
  await expect(page.locator("#feed li")).toHaveText(["Item 10", "Item 11", "Item 12"]);
});

test("an appending Region adds its items to the end, marked as new", async ({ page }) => {
  await page.getByRole("button", { name: "Load older" }).click();
  await expect(page.locator("#feed li")).toHaveText(["Item 10", "Item 11", "Item 12", "Item 13", "Item 14"]);
  await expect(page.locator("#feed li[data-yx-new]")).toHaveText(["Item 13", "Item 14"]);

  // The button came back with the next page's arguments.
  await page.getByRole("button", { name: "Load older" }).click();
  await expect(page.locator("#feed li")).toHaveCount(7);
  await expect(page.locator("#feed li").last()).toHaveText("Item 16");
});

test("a prepending Region puts its items first", async ({ page }) => {
  await page.getByRole("button", { name: "Add newer" }).click();
  await expect(page.locator("#feed li")).toHaveText(["Item 9", "Item 10", "Item 11", "Item 12"]);
  await page.getByRole("button", { name: "Add newer" }).click();
  await expect(page.locator("#feed li")).toHaveText(["Item 8", "Item 9", "Item 10", "Item 11", "Item 12"]);
});

test("an item that's already in the list is updated where it is, not added again", async ({ page }) => {
  const item = page.locator('#feed li[data-key="11"]');
  await item.evaluate((el) => ((el as HTMLElement & { __tag?: boolean }).__tag = true));
  await page.getByRole("button", { name: "Edit item 11" }).click();
  await expect(page.locator("#feed li")).toHaveText(["Item 10", "Item 11 (edited)", "Item 12"]);
  expect(await item.evaluate((el) => (el as HTMLElement & { __tag?: boolean }).__tag)).toBe(true);
});
