import { expect, test, type Page } from "@playwright/test";
import { markPage, stillSamePage } from "./helpers.js";

/** The render number the panel shows, which goes up each time the server renders it. */
async function renderNumber(page: Page): Promise<number> {
  return Number((await page.locator("#renders").textContent())?.match(/\d+/)?.[0]);
}

/** Re-fetch the page and morph its Regions in, from the runtime's own API, without moving focus. */
async function refreshFromScript(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { yerd: { page: { refresh(): Promise<void> } } }).yerd.page.refresh());
}

test.beforeEach(async ({ page }) => {
  await page.goto("/morph");
});

test("a morph keeps the focused field's typed value and caret", async ({ page }) => {
  const typed = page.getByLabel("Typed");
  await typed.fill("my own words");
  await typed.evaluate((el: HTMLInputElement) => el.setSelectionRange(3, 6));
  await expect(typed).toBeFocused();
  const before = await renderNumber(page);
  await markPage(page);

  await refreshFromScript(page);

  await expect(page.locator("#renders")).not.toHaveText(`Render ${before}`);
  await expect(typed).toBeFocused();
  await expect(typed).toHaveValue("my own words");
  expect(await typed.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([3, 6]);
  await stillSamePage(page);
});

test("a morph keeps text typed into unfocused fields, an open <details> and a data-yx-keep subtree", async ({ page }) => {
  await page.getByLabel("Typed").fill("typed, then left");
  await page.getByLabel("Notes").fill("notes of my own");
  await page.locator("#more summary").click();
  await expect(page.locator("#more")).toHaveAttribute("open", "");
  await page.locator("#kept").evaluate((el) => (el.textContent = "Changed in the browser"));
  const before = await renderNumber(page);

  // The button takes the focus: nothing in the panel is focused when the response lands.
  await page.getByRole("button", { name: "Refresh the panel" }).click();

  await expect(page.locator("#renders")).toHaveText(`Render ${before + 1}`);
  await expect(page.getByLabel("Typed")).toHaveValue("typed, then left");
  await expect(page.getByLabel("Notes")).toHaveValue("notes of my own");
  await expect(page.locator("#more")).toHaveAttribute("open", "");
  await expect(page.getByText("Hidden until opened.")).toBeVisible();
  await expect(page.locator("#kept")).toHaveText("Changed in the browser");
});

test("a field the visitor never touched takes the server's new value", async ({ page }) => {
  const mirror = page.getByLabel("Mirror");
  const before = await renderNumber(page);
  await expect(mirror).toHaveValue(`server ${before}`);

  await page.getByRole("button", { name: "Refresh the panel" }).click();

  await expect(page.locator("#renders")).toHaveText(`Render ${before + 1}`);
  await expect(mirror).toHaveValue(`server ${before + 1}`);
});

test("morphed elements are patched in place, not replaced", async ({ page }) => {
  // Tag the live DOM nodes; a replaced node would lose the tag.
  await page.evaluate(() => {
    for (const id of ["typed", "notes", "more", "renders"]) (document.getElementById(id) as HTMLElement & { __tag?: string }).__tag = id;
  });
  const before = await renderNumber(page);
  await page.getByRole("button", { name: "Refresh the panel" }).click();
  await expect(page.locator("#renders")).toHaveText(`Render ${before + 1}`);
  const tags = await page.evaluate(() =>
    ["typed", "notes", "more", "renders"].map((id) => (document.getElementById(id) as HTMLElement & { __tag?: string }).__tag),
  );
  expect(tags).toEqual(["typed", "notes", "more", "renders"]);
});
