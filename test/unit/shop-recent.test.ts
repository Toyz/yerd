// @vitest-environment happy-dom
// The shop's "Recently viewed" island module, mounted the way the runtime mounts it.
import { beforeEach, expect, it } from "vitest";
import type { YerdClient } from "@toyz/yerd/client";
import mount, { type RecentProps } from "../../examples/shop/src/recent.client.js";

function visit(product: RecentProps): HTMLElement {
  const el = document.createElement("yerd-island");
  void mount(el, product, {} as YerdClient);
  return el;
}

const links = (el: HTMLElement) => [...el.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);

beforeEach(() => localStorage.clear());

it("shows nothing on the first product, then the others, newest first", () => {
  expect(visit({ id: 2, name: "Gel pens, 3 pack" }).childElementCount).toBe(0);
  visit({ id: 5, name: "Brass ruler" });
  const el = visit({ id: 7, name: "Field notebook" });
  expect(el.querySelector("h2")?.textContent).toBe("Recently viewed");
  expect(links(el)).toEqual([
    ["Brass ruler", "/products/5"],
    ["Gel pens, 3 pack", "/products/2"],
  ]);
});

it("keeps three, without the current product, and skips what doesn't fit the shape", () => {
  localStorage.setItem("paperyard:recent", JSON.stringify([{ id: "<x>", name: 1 }, null, { id: 1, name: "Fountain pen" }]));
  for (const [id, name] of [[2, "Gel pens, 3 pack"], [3, "Mechanical pencil"], [4, "Desk lamp"]] as const) visit({ id, name });
  const el = visit({ id: 1, name: "Fountain pen" });
  expect(links(el).map(([name]) => name)).toEqual(["Desk lamp", "Mechanical pencil", "Gel pens, 3 pack"]);
});

it("survives storage that isn't JSON", () => {
  localStorage.setItem("paperyard:recent", "{nope");
  expect(visit({ id: 7, name: "Field notebook" }).childElementCount).toBe(0);
  expect(JSON.parse(localStorage.getItem("paperyard:recent")!)).toEqual([{ id: 7, name: "Field notebook" }]);
});
