import type { IslandMount } from "@toyz/yerd/client";

/** The product on the page, as the server passes it. */
export interface RecentProps {
  id: number;
  name: string;
}

const KEY = "paperyard:recent";

/**
 * "Recently viewed", under the product. Kept in this browser's localStorage,
 * not the session: no cookie grows, and the server renders the same page for
 * everyone. Runs in the browser only; the server never imports this file.
 */
const mount: IslandMount<RecentProps> = (el, product) => {
  let seen: RecentProps[] = [];
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    // Storage is input like any other: keep only entries of the right shape.
    if (Array.isArray(stored)) seen = stored.filter((p) => Number.isInteger(p?.id) && typeof p?.name === "string");
  } catch {}
  const others = seen.filter((p) => p.id !== product.id).slice(0, 3);
  try {
    localStorage.setItem(KEY, JSON.stringify([{ id: product.id, name: product.name }, ...others]));
  } catch {} // private mode, storage full: just skip it
  if (others.length === 0) return;

  const heading = document.createElement("h2");
  heading.textContent = "Recently viewed";
  const list = document.createElement("ul");
  for (const p of others) {
    const link = document.createElement("a");
    link.href = `/products/${p.id}`;
    link.textContent = p.name;
    const item = document.createElement("li");
    item.append(link);
    list.append(item);
  }
  el.replaceChildren(heading, list);
};

export default mount;
