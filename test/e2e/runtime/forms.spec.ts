import { expect, test, type Request } from "@playwright/test";
import { actionName, holdRequests, isAction, notice } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await page.goto("/forms");
});

test("data-yx-confirm on a form: dismissing sends nothing, accepting sends it", async ({ page }) => {
  const sends: Request[] = [];
  page.on("request", (request) => {
    if (actionName(request) === "confirmed") sends.push(request);
  });
  const button = page.getByRole("button", { name: "Send with confirmation" });

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toBe("Really send it?");
    void dialog.dismiss();
  });
  await button.click();
  await expect(page.locator("#confirmed")).toHaveText("Confirmed sends: 0");
  expect(sends).toHaveLength(0);

  page.once("dialog", (dialog) => void dialog.accept());
  await button.click();
  await expect(page.locator("#confirmed")).toHaveText("Confirmed sends: 1");
  expect(sends).toHaveLength(1);
});

test("data-yx-confirm on an element action asks too", async ({ page }) => {
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("button", { name: "Ping with confirmation" }).click();
  await expect(page.locator("#pinged")).toBeEmpty();

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toBe("Ping the server?");
    void dialog.accept();
  });
  await page.getByRole("button", { name: "Ping with confirmation" }).click();
  await expect(page.locator("#pinged")).toHaveText("Pings: 1");
});

test("data-yx-reset clears the form after it succeeds", async ({ page }) => {
  const tag = page.getByLabel("Tag");
  await tag.fill("urgent");
  await page.getByRole("button", { name: "Add tag" }).click();
  await expect(page.locator("#tags li")).toHaveText(["urgent"]);
  await expect(tag).toHaveValue("");
});

test("data-yx-submit submits its form when the checkbox changes", async ({ page }) => {
  await page.getByLabel("Notify me").check();
  await expect(page.locator("#notify-state")).toHaveText("Notifications on");
  await page.getByLabel("Notify me").uncheck();
  await expect(page.locator("#notify-state")).toHaveText("Notifications off");
});

test("validation errors go to their fields' boxes, the rest to the form's, and clear on the next submit", async ({ page }) => {
  await page.getByLabel("Name").fill("A");
  await page.getByLabel("Email").fill("not an email");
  await page.getByLabel("Second seat").fill("12");
  await page.getByRole("button", { name: "Save profile" }).click();

  const form = page.locator("#profile");
  // Name has its own box.
  await expect(form.locator('[data-yx-error="name"]')).toHaveText(/2 to 20 characters/);
  // seats[1] is an item of seats: its message goes to the seats box.
  await expect(form.locator('[data-yx-error="seats"]')).toHaveText(/1 to 9/);
  // Email has no box: its message lands in the form's, labelled with the field's label.
  await expect(form.getByRole("alert")).toHaveText(/^Email: /);
  await expect(page.getByLabel("Name")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("First seat")).toHaveAttribute("aria-invalid", "true");
  // The first invalid field takes the focus.
  await expect(page.getByLabel("Name")).toBeFocused();

  await page.getByLabel("Name").fill("Ada");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Second seat").fill("3");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.locator("#profile-saved")).toHaveText("Saved Ada, ada@example.com, seats 1 and 3");
  await expect(form.locator('[data-yx-error="name"]')).toBeEmpty();
  await expect(form.locator('[data-yx-error="seats"]')).toBeEmpty();
  await expect(form.getByRole("alert")).toBeEmpty();
  await expect(page.getByLabel("Name")).not.toHaveAttribute("aria-invalid");
  await expect(page.getByLabel("Email")).not.toHaveAttribute("aria-invalid");
});

test("a thrown error's message goes into the form's error box", async ({ page }) => {
  const form = page.locator("form", { has: page.getByRole("button", { name: "Cause a conflict" }) });
  await page.getByRole("button", { name: "Cause a conflict" }).click();
  await expect(form.getByRole("alert")).toHaveText("That clashes with something.");
  await expect(notice(page)).toHaveCount(0);
});

test("with no error box, the message shows as a notice, which a yx:notice listener can take over", async ({ page }) => {
  await page.getByRole("button", { name: "Fail without a box" }).click();
  await expect(notice(page)).toHaveText("Nowhere to put this message.");
  await expect(notice(page)).toHaveAttribute("role", "status");

  // An app's own handler: preventDefault() keeps the built-in notice away.
  await page.evaluate(() => {
    document.getElementById("yx-notice")?.remove();
    document.addEventListener("yx:notice", (event) => {
      event.preventDefault();
      document.body.dataset.toast = (event as CustomEvent<{ message: string }>).detail.message;
    });
  });
  await page.getByRole("button", { name: "Fail without a box" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-toast", "Nowhere to put this message.");
  await expect(notice(page)).toHaveCount(0);
});

test("a form in flight is busy, with its buttons disabled until the answer lands", async ({ page }) => {
  const slow = await holdRequests(page, "**/forms", (request) => actionName(request) === "slow");
  const form = page.locator("form", { has: page.getByRole("button", { name: "Save slowly" }) });
  const sent = page.waitForRequest((request) => isAction(request) && actionName(request) === "slow");
  await page.getByRole("button", { name: "Save slowly" }).click();
  await sent;
  await expect(form).toHaveAttribute("aria-busy", "true");
  await expect(form.getByRole("button", { name: "Save slowly" })).toBeDisabled();
  await expect(form.getByRole("button", { name: "Another button" })).toBeDisabled();

  await slow.release();
  await expect(page.locator("#slow-done")).toHaveText("Saved slowly");
  await expect(form).not.toHaveAttribute("aria-busy");
  await expect(form.getByRole("button", { name: "Save slowly" })).toBeEnabled();
  await expect(form.getByRole("button", { name: "Another button" })).toBeEnabled();
});

test("a form inside a <details> closes it once it succeeds", async ({ page }) => {
  await expect(page.locator("#editor")).toHaveAttribute("open", "");
  await page.getByLabel("Title").fill("A new title");
  await page.getByRole("button", { name: "Rename" }).click();
  await expect(page.locator("#title-shown")).toHaveText("A new title");
  await expect(page.locator("#editor")).not.toHaveAttribute("open");
});
