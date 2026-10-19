import { expect, test, type Page } from "@playwright/test";
import { markPage, nextApplied, stillSamePage } from "./helpers.js";

type ProbeLog = { mounts: string[]; cleanups: string[] };
const probe = (page: Page) => page.evaluate(() => (window as unknown as { __probe?: ProbeLog }).__probe ?? { mounts: [], cleanups: [] });
const mounts = async (page: Page) => (await probe(page)).mounts;

/** Requests for one of the fixture's client modules, by its file name's start. */
function moduleRequests(page: Page, name: string): string[] {
  const seen: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.includes(name)) seen.push(request.url());
  });
  return seen;
}

test.describe("islands", () => {
  test("load and idle islands mount on their own; their children show until then", async ({ page }) => {
    await page.goto("/islands");
    await expect(page.locator("#island-load")).toHaveText("Mounted load");
    await expect(page.locator("#island-idle")).toHaveText("Mounted idle");
    await expect(page.locator("#island-load")).not.toHaveAttribute("data-yx-loading");
    // The others are still showing what the server rendered.
    await expect(page.locator("#island-interaction")).toHaveText("Point at me");
    await expect(page.locator("#island-visible")).toHaveText("Waiting to be seen");
    await expect(page.locator("#island-media")).toHaveText("Waiting for a wide screen");
  });

  test("an interaction island mounts on the first hover or focus", async ({ page }) => {
    await page.goto("/islands");
    await expect(page.locator("#island-load")).toHaveText("Mounted load");
    await expect(page.locator("#island-interaction")).toHaveText("Point at me");
    await page.locator("#island-interaction").focus();
    await expect(page.locator("#island-interaction")).toHaveText("Mounted interaction");
  });

  test("a visible island mounts when it scrolls into view", async ({ page }) => {
    await page.goto("/islands");
    await expect(page.locator("#island-load")).toHaveText("Mounted load");
    expect(await mounts(page)).not.toContain("visible");
    await page.locator("#island-visible").scrollIntoViewIfNeeded();
    await expect(page.locator("#island-visible")).toHaveText("Mounted visible");
  });

  test("a media island mounts once its query matches", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/islands");
    await expect(page.locator("#island-load")).toHaveText("Mounted load");
    await expect(page.locator("#island-media")).toHaveText("Waiting for a wide screen");
    await page.setViewportSize({ width: 1500, height: 720 });
    await expect(page.locator("#island-media")).toHaveText("Mounted media");
  });

  test("a morph keeps a mounted island while its props stay the same, and remounts it, cleanup first, when they change", async ({ page }) => {
    await page.goto("/islands");
    const boxed = page.locator("#island-boxed");
    await expect(boxed).toHaveText("Mounted boxed 1");

    const applied = await nextApplied(page);
    await page.getByRole("button", { name: "Same props" }).click();
    await applied();
    // The Region was morphed, but the island in it wasn't touched.
    expect((await mounts(page)).filter((m) => m.startsWith("boxed"))).toEqual(["boxed 1"]);
    expect((await probe(page)).cleanups).toEqual([]);
    await expect(boxed).toHaveText("Mounted boxed 1");

    await page.getByRole("button", { name: "New props" }).click();
    await expect(boxed).toHaveText("Mounted boxed 2");
    const log = await probe(page);
    expect(log.cleanups).toEqual(["boxed 1"]);
    expect(log.mounts.filter((m) => m.startsWith("boxed"))).toEqual(["boxed 1", "boxed 2"]);
  });

  test("leaving the page by a boosted link runs every mounted island's cleanup", async ({ page }) => {
    await page.goto("/islands");
    await expect(page.locator("#island-load")).toHaveText("Mounted load");
    await expect(page.locator("#island-idle")).toHaveText("Mounted idle");
    await expect(page.locator("#island-boxed")).toHaveText("Mounted boxed 1");
    await markPage(page);
    await page.getByRole("navigation", { name: "Fixture pages" }).getByRole("link", { name: "Home" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("yerd runtime fixture");
    await expect.poll(async () => (await probe(page)).cleanups.sort()).toEqual(["boxed 1", "idle", "load"]);
    await stillSamePage(page);
  });
});

test.describe("lazy elements and module-backed attributes", () => {
  test("a lazy custom element's module loads when the tag scrolls into view, and it upgrades", async ({ page }) => {
    const fetched = moduleRequests(page, "fx-greeting");
    await page.goto("/lazy");
    const greeting = page.locator("#greeting");
    await expect(greeting).toHaveText("Greeting loads when it scrolls into view");
    expect(fetched).toHaveLength(0);

    await greeting.scrollIntoViewIfNeeded();
    await expect(greeting).toHaveText("Hello, Ada");
    expect(fetched.length).toBeGreaterThan(0);
    expect(await page.evaluate(() => customElements.get("fx-greeting") !== undefined)).toBe(true);
  });

  test("once upgraded, a morph only changes the element's attributes and leaves its children to it", async ({ page }) => {
    await page.goto("/lazy");
    await page.locator("#greeting").scrollIntoViewIfNeeded();
    await expect(page.locator("#greeting")).toHaveText("Hello, Ada");

    await page.getByRole("button", { name: "Swap the name" }).click();
    await expect(page.locator("#greeting")).toHaveAttribute("name", "Grace");
    // The element re-rendered itself from the new attribute; the server's placeholder didn't come back.
    await expect(page.locator("#greeting")).toHaveText("Hello, Grace");
  });

  test("an attribute's module loads on the first interaction, then connects, updates and disconnects every element", async ({ page }) => {
    const fetched = moduleRequests(page, "fx-badge");
    await page.goto("/lazy");
    const one = page.locator("#badge-one");
    const two = page.locator("#badge-two");
    await expect(one).not.toHaveAttribute("data-badge");
    expect(fetched).toHaveLength(0);

    await one.hover();
    // Both elements connect once the first one's trigger brought the module in.
    await expect(one).toHaveAttribute("data-badge", "New");
    await expect(two).toHaveAttribute("data-badge", "New");
    expect(fetched.length).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Update the badges" }).click();
    await expect(one).toHaveAttribute("data-badge", "Updated");
    await expect(two).toHaveAttribute("data-badge", "Updated");

    await page.getByRole("button", { name: "Remove the badges" }).click();
    await expect(page.getByText("No badges")).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __badgeDisconnects?: number }).__badgeDisconnects)).toBe(2);
  });
});
