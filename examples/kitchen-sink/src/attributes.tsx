import { attribute } from "@toyz/yerd";

declare module "@toyz/yerd" {
  interface CustomAttributes {
    /** A price in cents, shown in the visitor's own number format once the page loads. */
    money?: number;
    /** An ISO timestamp, shown as "3 minutes ago" and kept fresh. */
    ago?: string;
    /** An SSE URL: the element shows the latest sale from it. */
    ticker?: string;
  }
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** "$12.99": the server's text for a price. */
export function formatMoney(cents: number): string {
  return usd.format(cents / 100);
}

/**
 * `money={cents}`: the server writes the amount in en-US; the client half
 * re-formats it in the browser's locale (12,99 US$ in Lisbon). The client
 * half is shipped as source text, so it carries its own formatter.
 */
export const money = attribute<number>("money", {
  render: (cents) => ({ money: String(cents) }),
  client(el, value) {
    const render = (cents: string) => {
      const text = new Intl.NumberFormat(navigator.language, { style: "currency", currency: "USD" }).format(Number(cents) / 100);
      if (el.textContent !== text) el.textContent = text;
    };
    render(value);
    return { update: render };
  },
});

/** A price: `<Price cents={1299} />`. */
export function Price({ cents, class: className }: { cents: number; class?: string }) {
  return (
    <span class={["price", className]} money={cents}>
      {formatMoney(cents)}
    </span>
  );
}

/** "just now", "4 minutes ago": the server's text for a timestamp. */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  if (Math.abs(seconds) < 45) return "just now";
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(seconds) < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (Math.abs(seconds) < 86_400) return format.format(Math.round(seconds / 3600), "hour");
  return format.format(Math.round(seconds / 86_400), "day");
}

/** `ago={iso}`: relative text that keeps up with the clock (re-rendered every 20 seconds in the browser). */
export const ago = attribute<string>("ago", {
  render: (iso) => ({ ago: iso, datetime: iso, title: new Date(iso).toUTCString() }),
  client(el, value) {
    let iso = value;
    const render = () => {
      const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
      const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
      const text =
        Math.abs(seconds) < 45 ? "just now"
        : Math.abs(seconds) < 3600 ? format.format(Math.round(seconds / 60), "minute")
        : Math.abs(seconds) < 86_400 ? format.format(Math.round(seconds / 3600), "hour")
        : format.format(Math.round(seconds / 86_400), "day");
      if (el.textContent !== text) el.textContent = text;
    };
    render();
    const timer = setInterval(render, 20_000);
    return {
      update(next) {
        iso = next;
        render();
      },
      disconnect() {
        clearInterval(timer);
      },
    };
  },
});

export function Ago({ iso }: { iso: string }) {
  return <time ago={iso}>{timeAgo(iso)}</time>;
}

/**
 * `ticker="/sales/ticker"`: a client-only attribute (no `render`, so the
 * prop is written as is). Opens an EventSource and shows each named `sale`
 * event. Named events are ignored by data-yx-live, which only refreshes on
 * plain messages, so the two never get in each other's way.
 */
export const ticker = attribute<string>("ticker", {
  client(el, url) {
    const usd = new Intl.NumberFormat(navigator.language, { style: "currency", currency: "USD" });
    const show = (event: MessageEvent) => {
      const sale = JSON.parse(event.data) as { name: string; qty: number; city: string; totalCents: number };
      el.textContent = `Someone in ${sale.city} just bought ${sale.qty > 1 ? `${sale.qty} x ` : ""}${sale.name} for ${usd.format(sale.totalCents / 100)}`;
      el.classList.remove("ticked");
      // Reflow, so the highlight animation restarts for every sale.
      void el.offsetWidth;
      el.classList.add("ticked");
    };
    let source = new EventSource(url);
    source.addEventListener("sale", show);
    return {
      update(next) {
        source.close();
        source = new EventSource(next);
        source.addEventListener("sale", show);
      },
      disconnect() {
        source.close();
      },
    };
  },
});
