import { expect, test, type Browser, type Page } from "@playwright/test";
import { uniqueId } from "./helpers.js";

type Clocked = { yerd: { clock: { now(): number; sync(): Promise<{ offset: number; rtt: number }> } } };

/** Two separate visitors on the cues page, listening to a room of this test's own. */
async function twoPages(browser: Browser, baseURL: string | undefined, room: string): Promise<[Page, Page]> {
  const pages = await Promise.all([0, 1].map(async () => (await browser.newContext({ baseURL })).newPage()));
  await Promise.all(pages.map((page) => page.goto(`/cues?room=${room}`)));
  return pages as [Page, Page];
}

/** Where a page's synced animation is in its cycle, against the server's clock (0 = on the beat). */
function phase(page: Page): Promise<number> {
  return page.evaluate(() => {
    const animation = document.getElementById("spinner")!.getAnimations()[0]!;
    // sync lines animations up over two iterations (1s each), from the server's time zero.
    const period = 2000;
    const off = (((Number(animation.currentTime) - (window as unknown as Clocked).yerd.clock.now()) % period) + period) % period;
    return Math.min(off, period - off);
  });
}

test("sync: two pages run the same animation frame, on the server's clock", async ({ browser, baseURL }) => {
  const [one, two] = await twoPages(browser, baseURL, uniqueId("fx-sync"));
  // Same machine: the measured offset is about nothing, over a quick round trip.
  const clock = await one.evaluate(() => (window as unknown as Clocked).yerd.clock.sync());
  expect(Math.abs(clock.offset)).toBeLessThan(250);
  await expect.poll(() => phase(one)).toBeLessThan(50);
  await expect.poll(() => phase(two)).toBeLessThan(50);
  await Promise.all([one.context().close(), two.context().close()]);
});

test("cue: a cue played by one page plays on every page in the room at the same moment", async ({ browser, baseURL, request }) => {
  const room = uniqueId("fx-cue");
  const [one, two] = await twoPages(browser, baseURL, room);
  // A third visitor, in another room.
  const elsewhere = uniqueId("fx-other");
  const outsider = await (await browser.newContext({ baseURL })).newPage();
  await outsider.goto(`/cues?room=${elsewhere}`);
  const watching = async (name: string) => ((await (await request.get(`/cues/watching?room=${name}`)).json()) as { watching: number }).watching;
  // Every page's stream connected before anything is played.
  await expect.poll(() => watching(room)).toBe(2);
  await expect.poll(() => watching(elsewhere)).toBe(1);

  const heard = (page: Page) =>
    page.evaluate(
      () =>
        new Promise<{ name: string; at: number; late: number; drift: number; data: unknown }>((resolve) => {
          document.addEventListener(
            "yx:cue",
            (event) => {
              const { name, at, late, data } = (event as CustomEvent<{ name: string; at: number; late: number; data: unknown }>).detail;
              resolve({ name, at, late, data, drift: (window as unknown as Clocked).yerd.clock.now() - at });
            },
            { once: true },
          );
        }),
    );
  const waiting = Promise.all([heard(one), heard(two)]);
  await one.getByRole("button", { name: "Ping every page" }).click();
  const [a, b] = await waiting;
  expect(a.at).toBe(b.at);
  for (const got of [a, b]) {
    expect(got).toMatchObject({ name: "ping", late: 0, data: { from: "fixture" } });
    expect(Math.abs(got.drift)).toBeLessThan(150);
  }
  await expect(two.locator("#beacon")).toHaveAttribute("data-yx-cued", "ping");
  // The other room's page heard nothing.
  await expect(outsider.locator("#beacon")).not.toHaveAttribute("data-yx-cued");
  // It comes off when the cue's 1.5s are up.
  await expect(two.locator("#beacon")).not.toHaveAttribute("data-yx-cued", { timeout: 4000 });
  await Promise.all([one.context().close(), two.context().close(), outsider.context().close()]);
});
