/**
 * Benchmark bars: one scenario, every framework, sorted by requests per
 * second. Plain HTML and CSS (no chart library): each row is the name, a bar
 * from a shared zero baseline, the number at its tip, the share of the
 * fastest framework, and the latencies. yerd's bar wears the hat color and
 * every other framework the same neutral, so color says "this is yerd" and
 * nothing about rank. The node:http baseline isn't a framework (the harness
 * shows it as a ceiling), so its bar is hatched and it's left out of "% of
 * fastest", the same way the harness's own tables do it.
 */

import { css } from "@toyz/loom";
import type { BenchResult, Benchmarks } from "./data";

/** The harness's plain node:http server: a ceiling, not a competitor. */
export const BASELINE = "node";

export const benchStyles = css`
  .bars { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  .bar-row {
    --bar: light-dark(#a4937a, #75695a);
    display: grid;
    grid-template-columns: 10.5rem minmax(0, 1fr) 5.2rem 3.4rem 10.5rem;
    align-items: center;
    column-gap: 14px;
    padding: 6px 8px;
    border-radius: 5px;
  }
  .bar-row:hover { background: var(--bg-hover); }
  .fw { font-weight: 700; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fw small { font-weight: 400; color: var(--text-faint); font-size: 0.78rem; margin-left: 5px; }
  .track { height: 14px; display: block; }
  .fill { display: block; height: 100%; background: var(--bar); border-radius: 0 4px 4px 0; min-width: 2px; }
  .bar-row.mine { --bar: var(--brand); }
  .bar-row.mine .fw { color: var(--accent); }
  .bar-row.baseline .fill {
    background: repeating-linear-gradient(135deg, var(--bar) 0 2px, transparent 2px 6px);
    box-shadow: inset 0 0 0 1px var(--bar);
  }
  .bar-row.baseline .fw { font-weight: 400; color: var(--text-dim); }
  .val { text-align: right; font-variant-numeric: tabular-nums; color: var(--text); font-weight: 700; white-space: nowrap; }
  .rel { text-align: right; font-variant-numeric: tabular-nums; color: var(--text-dim); font-size: 0.86rem; white-space: nowrap; }
  .lat { font-size: 0.82rem; color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .per { display: none; font-weight: 400; color: var(--text-faint); font-size: 0.75rem; }
  .errors { display: block; color: var(--warn); font-size: 0.78rem; font-weight: 700; }
  .unit { font-size: 0.8rem; color: var(--text-faint); display: grid; grid-template-columns: 10.5rem minmax(0, 1fr) 5.2rem 3.4rem 10.5rem; column-gap: 14px; padding: 0 8px 4px; }
  .unit span:nth-child(3), .unit span:nth-child(4) { text-align: right; }

  @media (max-width: 760px) {
    .bar-row {
      grid-template-columns: minmax(0, 1fr) auto auto;
      grid-template-areas: "fw val rel" "track track track" "lat lat lat";
      row-gap: 4px;
      padding: 8px 4px;
    }
    .fw { grid-area: fw; }
    .val { grid-area: val; }
    .rel { grid-area: rel; min-width: 3rem; }
    .track { grid-area: track; height: 12px; }
    .lat { grid-area: lat; }
    .unit { display: none; }
    .per { display: inline; }
  }
`;

const number = new Intl.NumberFormat("en-US");
const ms = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function formatNumber(n: number): string {
  return number.format(n);
}

export function sortedResults(results: BenchResult[]): BenchResult[] {
  return [...results].sort((a, b) => b.reqPerSec - a.reqPerSec);
}

/** The fastest real framework in a scenario (the baseline doesn't count). */
export function fastestFramework(results: BenchResult[]): BenchResult | undefined {
  return sortedResults(results).find((r) => r.framework !== BASELINE);
}

/**
 * Bars for one scenario, scaled to its fastest result. `only` limits the
 * rows (the home page's teaser); the scale and the percentages still come
 * from every result, so a short chart never looks better than the full one.
 */
export function BenchBars({
  data,
  scenario,
  mine = "yerd",
  only,
}: {
  data: Benchmarks;
  scenario: Benchmarks["scenarios"][number];
  mine?: string;
  only?: string[];
}) {
  const all = sortedResults(scenario.results);
  const rows = only ? all.filter((r) => only.includes(r.framework)) : all;
  const max = Math.max(...all.map((r) => r.reqPerSec), 1);
  const best = fastestFramework(all)?.reqPerSec ?? max;
  const named = new Map(data.frameworks.map((f) => [f.id, f]));
  return (
    <div>
      <div class="unit" aria-hidden="true">
        <span></span>
        <span></span>
        <span>req/s</span>
        <span>of best</span>
        <span>latency</span>
      </div>
      <ol class="bars" aria-label={`${scenario.title}: requests per second, highest first`}>
        {rows.map((r) => {
          const fw = named.get(r.framework);
          const baseline = r.framework === BASELINE;
          const share = Math.round((r.reqPerSec / best) * 100);
          return (
            <li class={`bar-row ${r.framework === mine ? "mine" : ""} ${baseline ? "baseline" : ""}`} loom-key={r.framework}>
              <span class="fw" title={fw ? `${fw.name} ${fw.version}` : r.framework}>
                {fw?.name ?? r.framework}
                {fw?.version && !baseline ? <small>{fw.version}</small> : null}
              </span>
              <span class="track" aria-hidden="true">
                <span class="fill" style={`width: ${((r.reqPerSec / max) * 100).toFixed(2)}%`}></span>
              </span>
              <span class="val" aria-label={`${number.format(Math.round(r.reqPerSec))} requests per second`}>
                {number.format(Math.round(r.reqPerSec))}
                <small class="per"> req/s</small>
              </span>
              <span class="rel" title={baseline ? "The baseline isn't compared" : "Share of the fastest framework's requests per second"}>
                {baseline ? "" : `${share}%`}
              </span>
              <span class="lat">
                p50 {ms.format(r.latencyP50)} ms, p99 {ms.format(r.latencyP99)} ms
                {r.errors > 0 ? <span class="errors">{number.format(r.errors)} errors</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
