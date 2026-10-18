import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BootError, accepts, createGuard, get, isBot, post, route, varies, yerd, type RunningServer } from "@toyz/yerd";

const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

const beta = createGuard("beta", (ctx) => ctx.cookies.beta === "1");
// Reads a header, so it says so: responses get Vary: x-client.
const fromApp = varies("X-Client", (ctx) => ctx.headers["x-client"] === "app");

@route("/products/:id")
class Product {
  @get page() {
    return <main data-app>interactive</main>;
  }

  @get(isBot) crawlable() {
    return <main>full product page for crawlers</main>;
  }
}

@route("/feed")
class Feed {
  @get(beta) next() {
    return "beta feed";
  }

  @get(fromApp) forApp() {
    return { feed: "for the app" };
  }

  @get classic() {
    return "classic feed";
  }

  @post(async (ctx) => (await ctx.body()).kind === "json") json() {
    return "posted json";
  }

  @post form() {
    return "posted something else";
  }
}

@route("/bots-only")
class BotsOnly {
  @get(isBot) crawlable() {
    return "hello crawler";
  }
}

@route("/negotiated")
class Negotiated {
  @get page() {
    return "html";
  }

  @get @accepts("json") data() {
    return { json: true };
  }

  @get(isBot) @accepts("json") botData() {
    return { bot: true };
  }
}

let server: RunningServer;
beforeAll(async () => {
  server = await yerd({ routes: [Product, Feed, BotsOnly, Negotiated], services: [], handleSignals: false }).listen(0, "127.0.0.1");
});
afterAll(() => server.close());

const get_ = (path: string, headers: Record<string, string> = {}) => fetch(server.url + path, { headers });

describe("@get(when)", () => {
  it("serves crawlers their variant and everyone else the default, with Vary: User-Agent", async () => {
    const bot = await get_("/products/1", { "user-agent": GOOGLEBOT });
    const person = await get_("/products/1", { "user-agent": CHROME });
    expect(await bot.text()).toContain("full product page for crawlers");
    expect(await person.text()).toContain("interactive");
    expect(bot.headers.get("vary")).toBe("user-agent");
    expect(person.headers.get("vary")).toBe("user-agent");
  });

  it("tries variants in order, takes guards and async tests, and falls back to the default", async () => {
    expect(await (await get_("/feed", { cookie: "beta=1" })).text()).toBe("beta feed");
    expect(await (await get_("/feed", { "x-client": "app" })).json()).toEqual({ feed: "for the app" });
    expect(await (await get_("/feed")).text()).toBe("classic feed");
    expect((await get_("/feed", { "x-client": "app" })).headers.get("vary")).toBe("x-client");
    const json = await fetch(server.url + "/feed", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(await json.text()).toBe("posted json");
    const form = await fetch(server.url + "/feed", { method: "POST", body: "a=1", headers: { "content-type": "text/plain" } });
    expect(await form.text()).toBe("posted something else");
  });

  it("is a 404 when only variants exist and none matches", async () => {
    expect(await (await get_("/bots-only", { "user-agent": GOOGLEBOT })).text()).toBe("hello crawler");
    expect((await get_("/bots-only", { "user-agent": CHROME })).status).toBe(404);
  });

  it("combines with @accepts", async () => {
    expect(await (await get_("/negotiated", { "user-agent": GOOGLEBOT, accept: "application/json" })).json()).toEqual({ bot: true });
    expect(await (await get_("/negotiated", { "user-agent": CHROME, accept: "application/json" })).json()).toEqual({ json: true });
    expect(await (await get_("/negotiated", { "user-agent": GOOGLEBOT, accept: "text/html" })).text()).toBe("html");
  });

  it("refuses a path argument with a clear error", () => {
    expect(() => {
      class Wrong {
        // @ts-expect-error a path isn't a request test
        @get("/x") page() {
          return 1;
        }
      }
      void Wrong;
    }).toThrow(/takes a request test/);
  });

  it("still refuses two plain handlers for one verb", async () => {
    @route("/dupe-variants")
    class Dupe {
      @get a() {
        return 1;
      }
      @get b() {
        return 2;
      }
    }
    await expect(yerd({ routes: [Dupe], services: [] }).boot()).rejects.toThrow(BootError);
  });
});

describe("isBot", () => {
  it("knows search engines, previews and headless browsers, not people", () => {
    for (const ua of [GOOGLEBOT, "Mozilla/5.0 (compatible; bingbot/2.0)", "facebookexternalhit/1.1", "Slackbot-LinkExpanding 1.0", "Twitterbot/1.0", "Mozilla/5.0 HeadlessChrome/120", "DuckDuckBot/1.1", "Discordbot/2.0", "GPTBot/1.0"]) {
      expect(isBot(ua), ua).toBe(true);
    }
    for (const ua of [CHROME, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", "", undefined]) {
      expect(isBot(ua), String(ua)).toBe(false);
    }
    expect(isBot.vary).toBe("user-agent");
  });
});
