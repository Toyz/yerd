import { expect, test, type Locator } from "@playwright/test";
import { notice, uniqueId } from "./helpers.js";

/**
 * Drop files from "outside the page" on an element: a DataTransfer built in
 * the page, carried by the events a real file drag fires.
 */
async function dropFiles(target: Locator, files: Array<{ name: string; type: string; text: string }>): Promise<void> {
  await target.evaluate((el, files) => {
    const transfer = new DataTransfer();
    for (const { name, type, text } of files) transfer.items.add(new File([text], name, { type }));
    for (const type of ["dragenter", "dragover", "drop"]) {
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }
  }, files);
}

test.beforeEach(async ({ page }) => {
  // A board of this test's own.
  await page.goto(`/dnd?t=${uniqueId("board")}`);
});

test("a card dragged onto another zone moves there", async ({ page }) => {
  const todo = page.getByRole("region", { name: "To do" });
  const done = page.getByRole("region", { name: "Done" });
  await expect(todo.getByRole("listitem")).toHaveText(["Card A", "Card B", "Card C"]);

  await todo.getByText("Card B").dragTo(done);
  await expect(done.getByRole("listitem")).toHaveText(["Card B"]);
  await expect(todo.getByRole("listitem")).toHaveText(["Card A", "Card C"]);

  await done.getByText("Card B").dragTo(todo);
  await expect(done.getByRole("listitem")).toHaveCount(0);
  await expect(todo.getByRole("listitem")).toHaveText(["Card A", "Card B", "Card C"]);
  await expect(page.locator("[data-yx-dragging], [data-yx-over]")).toHaveCount(0);
});

test("files dropped on a drop:files zone are posted at once", async ({ page }) => {
  await dropFiles(page.locator("#file-zone"), [
    { name: "one.txt", type: "text/plain", text: "first file" },
    { name: "two.md", type: "text/markdown", text: "second file" },
  ]);
  await expect(page.locator("#uploaded li")).toHaveText(["one.txt: first file", "two.md: second file"]);
});

test("a drop:files zone turns away files its accept list doesn't take", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
  });
  await dropFiles(page.locator("#file-zone"), [{ name: "photo.png", type: "image/png", text: "not text" }]);
  await expect(notice(page)).toHaveText("Those files can't be dropped here.");
  await expect(page.locator("#uploaded li")).toHaveCount(0);
  expect(posts).toHaveLength(0);
});

test("dropTo stages dropped files in the form's file input, for the form to post", async ({ page }) => {
  await dropFiles(page.locator("#stage"), [
    { name: "a.txt", type: "text/plain", text: "aaa" },
    { name: "b.txt", type: "text/plain", text: "bbbb" },
  ]);
  await expect(page.locator("#stage")).toHaveAttribute("data-yx-files", "2");
  expect(await page.getByLabel("Attachments").evaluate((input: HTMLInputElement) => Array.from(input.files ?? [], (f) => f.name))).toEqual(["a.txt", "b.txt"]);

  await page.getByRole("button", { name: "Post attachments" }).click();
  await expect(page.locator("#posted li")).toHaveText(["a.txt (3 bytes)", "b.txt (4 bytes)"]);
});
