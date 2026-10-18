import { attribute } from "@toyz/yerd";

declare module "@toyz/yerd" {
  interface CustomAttributes {
    /** An ISO timestamp, shown as "3 minutes ago" and kept fresh in the browser. */
    "relative-time"?: string;
  }
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** "just now", "3 minutes ago", "yesterday": the server's text for a timestamp. */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  if (Math.abs(seconds) < 45) return "just now";
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(Math.round(seconds / 60), "minute");
}

/**
 * `relative-time={iso}`: the server half writes the machine-readable time and
 * a full date on hover; the client half re-renders the text every 15 seconds,
 * so "just now" turns into "5 minutes ago" without a reload.
 *
 * The client half is shipped as source text, so it can't call timeAgo() above
 * (or use UNITS): it carries its own copy of the same rules.
 */
export const relativeTime = attribute<string>("relative-time", {
  render: (iso) => ({
    "relative-time": iso,
    datetime: iso,
    title: new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" }),
  }),
  client(el, value) {
    const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
      ["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60],
    ];
    const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
    let iso = value;
    const render = () => {
      const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
      let text = "just now";
      if (Math.abs(seconds) >= 45) {
        const [unit, size] = units.find(([, size]) => Math.abs(seconds) >= size) ?? ["minute", 60];
        text = format.format(Math.round(seconds / size), unit);
      }
      if (el.textContent !== text) el.textContent = text;
    };
    render();
    const timer = setInterval(render, 15_000);
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

/** A timestamp as relative text: `<Ago iso={todo.createdAt} />`. */
export function Ago({ iso }: { iso: string }) {
  return <time relative-time={iso}>{timeAgo(iso)}</time>;
}
