/**
 * Crawler and link-preview detection, by User-Agent. Use it as a request test
 * for a handler variant, so search engines and link unfurlers get a complete,
 * script-free page while people get the interactive one:
 *
 * ```tsx
 * @route("/products/:id")
 * class Product {
 *   @get page() { return <ProductApp />; }                 // people
 *   @get(isBot) crawlable() { return <ProductDetails />; }  // crawlers
 * }
 * ```
 *
 * or inside any handler: `if (isBot(ctx)) ...`. It carries `vary =
 * "user-agent"`, so responses from routes that use it say `Vary: User-Agent`
 * and a shared cache keeps the two versions apart.
 *
 * Heuristic by nature: it matches the crawlers that matter for search and
 * previews (Google, Bing, DuckDuckGo, Yandex, Baidu, Apple, social and chat
 * unfurlers, SEO tools, headless browsers), not every bot that lies about
 * its name.
 */

import { varies } from "../decorators/route.js";
import type { YerdContext } from "./context.js";

const BOTS = new RegExp(
  [
    "bot\\b", "bots\\b", "crawl", "spider", "slurp", "mediapartners", "adsbot", "googleother", "google-inspectiontool",
    "facebookexternalhit", "facebookcatalog", "meta-externalagent", "embedly", "quora link preview", "outbrain",
    "pinterest", "vkshare", "w3c_validator", "whatsapp", "telegram", "discord", "slack", "skypeuripreview",
    "bitlybot", "nuzzel", "redditbot", "applebot", "yandex", "baidu", "duckduck", "bingpreview", "ahrefs",
    "semrush", "mj12", "dotbot", "petalbot", "bytespider", "gptbot", "chatgpt-user", "claudebot", "perplexity",
    "headlesschrome", "lighthouse", "chrome-lighthouse", "pagespeed", "prerender", "phantomjs",
  ].join("|"),
  "i",
);

function userAgentOf(input: YerdContext | string | undefined): string {
  if (input === undefined) return "";
  if (typeof input === "string") return input;
  const header = input.headers["user-agent"];
  return Array.isArray(header) ? header.join(" ") : (header ?? "");
}

const test = (input: YerdContext | string | undefined): boolean => BOTS.test(userAgentOf(input));

/** True when the request (or a User-Agent string) looks like a crawler or a link-preview fetcher. */
export const isBot: ((input: YerdContext | string | undefined) => boolean) & { readonly vary?: string } = Object.assign(
  test,
  { vary: varies("user-agent", test).vary },
);
