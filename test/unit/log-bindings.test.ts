import { describe, expect, it } from "vitest";
import { ILogger, log, yerd, type LogRecord } from "@toyz/yerd";

// Its own file: logging takes a shortcut while only one app has booted in
// the process, and this checks the step from one app to two.
describe("log bindings", () => {
  it("send each app's records to its own sink, before and after a second app boots", async () => {
    const capture = (filter: string) => {
      const records: LogRecord[] = [];
      const app = yerd({ routes: [], services: [] })
        .logging({ filter })
        .services((s) => s.value(ILogger, { write: (r) => records.push(r) }));
      return { app, records };
    };
    const first = capture("info");
    await first.app.scope(() => log.info("alone"));
    log.info("outside, one app");
    const second = capture("warn");
    await second.app.scope(() => (log.info("quiet"), log.warn("two")));
    await first.app.scope(() => log.info("one again"));
    expect(first.records.map((r) => r.message)).toEqual(["alone", "outside, one app", "one again"]);
    expect(second.records.map((r) => r.message)).toEqual(["two"]);
  });
});
