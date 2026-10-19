import { expect, test, type APIRequestContext } from "@playwright/test";
import { PORTS, url } from "../ports.js";
import { actionName, markPage, notice } from "./helpers.js";

const SPARE = url(PORTS.fixtureSpare, "/stale");
const STALE = "This page was out of date, so it's been refreshed. Please try again.";
const OFFLINE = "Couldn't reach the server. Please try again in a moment.";

/** Tell serve.ts to restart, stop or start the spare fixture server; resolves once it has. */
async function control(request: APIRequestContext, what: "restart" | "stop" | "start"): Promise<void> {
  const response = await request.post(url(PORTS.fixtureControl, `/${what}`));
  expect(response.ok()).toBe(true);
}

test.describe("a restarted or unreachable server", () => {
  // These share the spare server, and each changes it: one at a time, in order.
  test.describe.configure({ mode: "serial" });

  test.afterEach(async ({ request }) => {
    await control(request, "start");
  });

  test("after a restart with a new secret, a click refreshes the stale page with a notice, and the retry works", async ({ page, request }) => {
    await page.goto(SPARE);
    await page.getByRole("button", { name: "Count up", exact: true }).click();
    await expect(page.locator("#count")).toHaveText("Count 1");

    await control(request, "restart");

    const stale = page.waitForResponse((response) => actionName(response.request()) === "bump");
    await page.getByRole("button", { name: "Count up", exact: true }).click();
    expect((await stale).headers()["yx-stale"]).toBe("1");
    await expect(notice(page)).toHaveText(STALE);
    // The fresh page from the restarted server, with tokens it accepts.
    await expect(page.locator("#count")).toHaveText("Count 0");
    await page.getByRole("button", { name: "Count up", exact: true }).click();
    await expect(page.locator("#count")).toHaveText("Count 1");

    // An element action recovers the same way.
    await control(request, "restart");
    await page.getByRole("button", { name: "Count up from a button" }).click();
    await expect(notice(page)).toHaveText(STALE);
    await page.getByRole("button", { name: "Count up from a button" }).click();
    await expect(page.locator("#count")).toHaveText("Count 1");
  });

  test("while the server is down, a click says it couldn't reach it; once it's back, the same click works", async ({ page, request }) => {
    await page.goto(SPARE);
    await markPage(page);
    await control(request, "stop");

    await page.getByRole("button", { name: "Count up", exact: true }).click();
    await expect(notice(page)).toHaveText(OFFLINE);
    await expect(page.locator("#count")).toHaveText("Count 0");
    // Not busy any more: the form can be sent again.
    await expect(page.getByRole("button", { name: "Count up", exact: true })).toBeEnabled();

    await page.getByRole("button", { name: "Count up from a button" }).click();
    await expect(notice(page)).toHaveText(OFFLINE);

    await control(request, "start");
    await page.getByRole("button", { name: "Count up", exact: true }).click();
    await expect(page.locator("#count")).toHaveText("Count 1");
  });
});

test("a runtime chunk from another deploy reloads the page once, then says so instead of looping", async ({ page, browser, baseURL }) => {
  // A core from before a deploy: it asks for the local chunk under a version
  // the server no longer has, and the server answers with a chunk that only
  // tells the core it's outdated.
  const chunks: string[] = [];
  await page.route("**/_yerd/runtime.js", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/"local":"[^"]+"/, '"local":"from-an-older-deploy"');
    await route.fulfill({ response, body, headers: { ...response.headers(), "cache-control": "no-store" } });
  });
  page.on("request", (request) => {
    if (request.url().includes("runtime-local.js?v=from-an-older-deploy")) chunks.push(request.url());
  });
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents.push(request.url());
  });

  await page.goto("/local");
  // The first outdated chunk reloads the page; on the reload it's outdated again
  // within the minute, so the runtime stays put and says so.
  await expect(notice(page)).toHaveText("This page is out of date. Reload it to keep going.");
  expect(documents).toHaveLength(2);
  expect(chunks).toHaveLength(2);
  expect(await page.evaluate(() => performance.getEntriesByType("navigation")[0]?.toJSON().type)).toBe("reload");

  // A visitor with the current core gets the current chunk, and the page works.
  const fresh = await (await browser.newContext({ baseURL })).newPage();
  await fresh.goto("/local");
  await fresh.getByRole("button", { name: "Add one" }).click();
  await expect(fresh.locator("#count")).toHaveText("1");
  await expect(notice(fresh)).toHaveCount(0);
  await fresh.context().close();
});

test("the server answers a chunk request for an unknown version with the outdated chunk, never cached", async ({ request }) => {
  const response = await request.get("/_yerd/runtime-local.js?v=nope");
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(await response.text()).toContain("hooks.outdated()");
});
