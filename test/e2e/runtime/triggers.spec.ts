import { expect, test, type Request } from "@playwright/test";
import { actionName, holdRequests, isAction, pauseClock } from "./helpers.js";

/** The value an element action sent for its first hole (el.value, here). */
const holeValue = (request: Request) => new URLSearchParams(request.postData() ?? "").get("_yxh0");

test("click: each click posts the action and the response replaces its Region", async ({ page }) => {
  await page.goto("/triggers");
  await page.getByRole("button", { name: "Clicked 0 times" }).click();
  await page.getByRole("button", { name: "Clicked 1 times" }).click();
  await expect(page.getByRole("button", { name: "Clicked 2 times" })).toBeVisible();
});

test("keydown:Enter: other keys type as usual, Enter fires the action", async ({ page }) => {
  await page.goto("/triggers");
  const posts: Request[] = [];
  page.on("request", (request) => {
    if (isAction(request) && actionName(request) === "note") posts.push(request);
  });
  const note = page.getByLabel("Note");
  await note.pressSequentially("buy milk");
  await expect(note).toHaveValue("buy milk");
  expect(posts).toHaveLength(0);

  await note.press("Enter");
  await expect(page.locator("#notes li")).toHaveText(["buy milk"]);
  await note.fill("call home");
  await note.press("Enter");
  await expect(page.locator("#notes li")).toHaveText(["buy milk", "call home"]);
  expect(posts).toHaveLength(2);
});

test("input with a debounce: a burst of typing sends one request, after it stops", async ({ page }) => {
  // A paused clock: the keystrokes land inside the 300ms debounce however slow the machine is.
  await pauseClock(page);
  await page.goto("/triggers");
  const searches: Request[] = [];
  page.on("request", (request) => {
    if (isAction(request) && actionName(request) === "search") searches.push(request);
  });
  await page.getByLabel("Search fruit").pressSequentially("blu");
  await page.clock.runFor(299);
  expect(searches).toHaveLength(0);
  await page.clock.runFor(1);
  await expect(page.locator("#results li")).toHaveText(["blueberry"]);
  expect(searches.map(holeValue)).toEqual(["blu"]);
});

test("typeahead: a slow response for an older query never replaces a newer one", async ({ page }) => {
  await page.goto("/triggers");
  const search = page.getByLabel("Search fruit");
  // Hold the response for "a" until the one for "ap" has landed.
  const slow = await holdRequests(page, "**/triggers", (request) => actionName(request) === "search" && holeValue(request) === "a");
  const firstSent = page.waitForRequest((request) => actionName(request) === "search" && holeValue(request) === "a");
  await search.fill("a");
  await firstSent;

  await search.fill("ap");
  await expect(page.locator("#results")).toHaveAttribute("data-q", "ap");
  await expect(page.locator("#results li")).toHaveText(["apple", "apricot"]);

  // The runtime abandoned the "a" request when "ap" went out; letting it through changes nothing.
  await slow.release();
  expect(slow.held).toHaveLength(1);
  await expect(page.locator("#results")).toHaveAttribute("data-q", "ap");
  await expect(page.locator("#results li")).toHaveText(["apple", "apricot"]);
});

test("change: a select posts its action with its own value as a field", async ({ page }) => {
  await page.goto("/triggers");
  await page.getByLabel("Size").selectOption("l");
  await expect(page.locator("#picked")).toHaveText("Picked l");
  await page.getByLabel("Size").selectOption("m");
  await expect(page.locator("#picked")).toHaveText("Picked m");
});

test("nested actions: the innermost one wins, and only it is posted", async ({ page }) => {
  await page.goto("/triggers");
  const posts: Request[] = [];
  page.on("request", (request) => {
    if (isAction(request) && actionName(request) === "nested") posts.push(request);
  });
  await page.getByRole("button", { name: "Inner button" }).click();
  await expect(page.locator("#nested")).toHaveText("Fired by the button");
  expect(posts).toHaveLength(1);

  await page.getByText("A card that has its own action.").click();
  await expect(page.locator("#nested")).toHaveText("Fired by the card");
});

test("load: a Region fills itself in after the page loads, once", async ({ page }) => {
  const loaded = page.waitForResponse((response) => actionName(response.request()) === "panel");
  await page.goto("/triggers");
  await loaded;
  await expect(page.locator("#panel")).toHaveText("The panel loaded");
});

test("visible: the action fires when its element scrolls into view, not before", async ({ page }) => {
  await page.goto("/triggers");
  // The load trigger's request shows the page's triggers are wired.
  await expect(page.locator("#panel")).toHaveText("The panel loaded");
  await expect(page.locator("#seen")).toHaveText("Not seen yet");

  await page.locator("#seen").scrollIntoViewIfNeeded();
  await expect(page.locator("#seen")).toHaveText("Seen");
});

test("every: a poll fires on its timer and stops when a response drops its trigger", async ({ page }) => {
  // A paused clock: the 300ms timer fires when the test says so, not on the wall clock.
  await pauseClock(page);
  await page.goto("/triggers");
  const ticks: Request[] = [];
  page.on("request", (request) => {
    if (isAction(request) && actionName(request) === "tick") ticks.push(request);
  });
  const ticker = page.locator("#ticks");
  await expect(ticker).toHaveText("Ticks 0");
  for (const n of [1, 2]) {
    await page.clock.runFor(300);
    await expect(ticker).toHaveText(`Ticks ${n}`);
  }
  await page.clock.runFor(300);
  await expect(ticker).toHaveText("Ticks 3, done");
  await expect(ticker).not.toHaveAttribute("data-yx-trigger");

  // Plenty of timer periods later, nothing more was sent.
  const sent = ticks.length;
  await page.clock.runFor(3000);
  await expect(ticker).toHaveText("Ticks 3, done");
  expect(ticks.length).toBe(sent);
});
