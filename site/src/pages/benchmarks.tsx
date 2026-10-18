/**
 * Benchmarks: what bench/compare/ measured, every scenario and every
 * framework it ran, in the order the harness wrote them. Nothing is hidden or
 * re-picked here; the table at the end has every number the bars show.
 */

import { LoomElement, component, css, mount, reactive, styles } from "@toyz/loom";
import { route } from "@toyz/loom/router";
import { BenchBars, benchStyles, fastestFramework, formatNumber } from "../bench-chart";
import { loadBenchmarks, type BenchState, type Benchmarks } from "../data";
import { Mark } from "../ui";

const HARNESS = "https://github.com/Toyz/yerd/tree/main/bench/compare";

const sheet = css`
  ${benchStyles}
  .page { max-width: 1080px; margin: 0 auto; }
  .lede { margin-bottom: 14px; }
  .run { font-size: 0.92rem; color: var(--text-faint); margin: 0 0 22px; }
  .run a { white-space: nowrap; }

  .sample {
    margin: 0 0 28px; padding: 12px 16px; border-radius: var(--radius);
    background: var(--warn-bg); color: var(--text); font-size: 0.93rem;
    border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent);
  }
  .sample b { color: var(--warn); }

  .jump { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px; }
  .jump button {
    font: inherit; font-size: 0.88rem; cursor: pointer;
    padding: 5px 12px; border-radius: 999px;
    border: 1px solid var(--border-strong); background: var(--bg-raised); color: var(--text-dim);
  }
  .jump button:hover { color: var(--text); border-color: var(--accent-dim); }

  section.scenario { margin-top: 40px; scroll-margin-top: calc(var(--top) + 16px); }
  section.scenario h2 { margin: 0 0 4px; font-size: 1.45rem; }
  section.scenario > p { margin: 0 0 14px; font-size: 0.95rem; max-width: var(--measure); }
  .chart { padding: 10px 6px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
  .legend { display: flex; gap: 18px; font-size: 0.82rem; color: var(--text-faint); margin: 10px 0 0; flex-wrap: wrap; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .key { width: 16px; height: 10px; border-radius: 0 3px 3px 0; display: inline-block; background: light-dark(#a4937a, #6f6352); }
  .key.mine { background: var(--brand); }
  .key.baseline { background: repeating-linear-gradient(135deg, light-dark(#a4937a, #75695a) 0 2px, transparent 2px 5px); box-shadow: inset 0 0 0 1px light-dark(#a4937a, #75695a); }

  h2.all { margin-top: 56px; }
  .table td.num, .table th.num { text-align: right; font-variant-numeric: tabular-nums; padding-left: 14px; }
  .table tr.mine td { color: var(--text); font-weight: 700; }
  .table tr.mine td:first-child { color: var(--accent); }
  .table td.best { text-decoration: underline; text-decoration-color: var(--border-strong); text-underline-offset: 4px; }

  .method { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 32px; margin-top: 8px; }
  dl { margin: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 18px; font-size: 0.95rem; }
  dt { color: var(--text-faint); }
  dd { margin: 0; color: var(--text); overflow-wrap: anywhere; }
  .method ul { margin: 0; padding-left: 1.1em; font-size: 0.95rem; }
  .method h3 { margin: 0 0 10px; font-size: 1rem; }
  @media (max-width: 860px) { .method { grid-template-columns: 1fr; } }

  .empty { max-width: 560px; margin: 32px 0 0; padding: 28px; border: 1px dashed var(--border-strong); border-radius: 10px; }
  .empty h2 { margin: 12px 0 6px; font-size: 1.4rem; }
  .empty p { margin: 0 0 10px; }
`;

function runLine(data: Benchmarks) {
  const date = new Date(data.generated);
  const when = Number.isNaN(date.getTime()) ? data.generated : date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  return `Run ${when} on ${data.machine.cpu} (${data.machine.cores} threads, ${data.machine.memory}), Node ${data.machine.node}.`;
}

@route("/benchmarks")
@component("page-benchmarks")
@styles(sheet)
export class PageBenchmarks extends LoomElement {
  @reactive accessor state: BenchState | undefined = undefined;

  @mount async load() {
    window.scrollTo(0, 0);
    this.state = await loadBenchmarks();
  }

  #jump(id: string) {
    this.shadow.getElementById(`s-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  #empty() {
    return (
      <div class="page">
        <h1>Benchmarks</h1>
        <p class="lede">How yerd compares with other Node frameworks serving the same small apps on the same machine.</p>
        <div class="empty">
          <Mark size={34} />
          <h2>Not run yet</h2>
          <p>
            The comparison hasn't been run for this build of the docs. The harness lives in{" "}
            <a href={HARNESS} target="_blank" rel="noopener">bench/compare/</a>; once it writes <code>results.json</code>, the next
            docs build picks it up and the numbers appear here.
          </p>
        </div>
      </div>
    );
  }

  update() {
    const state = this.state;
    if (!state) return <p class="loading">Loading…</p>;
    const data = state.data;
    if (!data) return this.#empty();
    const t = data.tool;
    return (
      <div class="page">
        <h1>Benchmarks</h1>
        <p class="lede">
          The same small apps, written the usual way for each framework, served one at a time on one machine and loaded with {t.name}.
          Requests per second: higher is better. Latency in milliseconds: lower is better.
        </p>
        <p class="run">
          {runLine(data)} <a href={HARNESS} target="_blank" rel="noopener">See the harness</a>
        </p>
        {state.sample ? (
          <div class="sample" role="note">
            <b>Sample data.</b> No results file was found, so this development build shows made-up numbers from{" "}
            <code>benchmarks.sample.json</code>. A production build shows real results or nothing.
          </div>
        ) : null}

        {data.scenarios.length > 1 ? (
          <nav class="jump" aria-label="Scenarios">
            {data.scenarios.map((s) => (
              <button onClick={() => this.#jump(s.id)}>{s.title}</button>
            ))}
          </nav>
        ) : null}

        {data.scenarios.map((s) => (
          <section class="scenario" id={`s-${s.id}`} loom-key={s.id}>
            <h2>{s.title}</h2>
            {s.description ? <p>{s.description}</p> : null}
            <div class="chart">
              <BenchBars data={data} scenario={s} />
            </div>
          </section>
        ))}
        <div class="legend" aria-hidden="true">
          <span><i class="key mine"></i> yerd</span>
          <span><i class="key"></i> other frameworks</span>
          <span><i class="key baseline"></i> node:http baseline</span>
          <span>Each chart is scaled to its own fastest result.</span>
        </div>

        <h2 class="all">Every number</h2>
        <p>Requests per second, by framework and scenario. The fastest framework in each column is underlined; the node:http baseline is there for scale.</p>
        <div class="table">
          <table>
            <thead>
              <tr>
                <th>Framework</th>
                {data.scenarios.map((s) => (
                  <th class="num">{s.title}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.frameworks.map((f) => (
                <tr class={f.id === "yerd" ? "mine" : ""}>
                  <td>
                    {f.url ? <a href={f.url} target="_blank" rel="noopener">{f.name}</a> : f.name} <span class="muted">{f.version}</span>
                  </td>
                  {data.scenarios.map((s) => {
                    const r = s.results.find((x) => x.framework === f.id);
                    const best = fastestFramework(s.results);
                    return <td class={`num ${r && r === best ? "best" : ""}`}>{r ? formatNumber(Math.round(r.reqPerSec)) : "n/a"}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2>How it's measured</h2>
        <div class="method">
          <div>
            <h3>Machine and load</h3>
            <dl>
              <dt>CPU</dt>
              <dd>{data.machine.cpu}, {data.machine.cores} threads</dd>
              <dt>Memory</dt>
              <dd>{data.machine.memory}</dd>
              <dt>OS</dt>
              <dd>{data.machine.os}</dd>
              <dt>Node</dt>
              <dd>{data.machine.node}</dd>
              <dt>Load</dt>
              <dd>
                {t.name}, {t.connections} connections, {t.duration} s per run, pipelining {t.pipelining}
              </dd>
              <dt>Runs</dt>
              <dd>
                {t.warmup ? `${t.warmup} s warmup, then ` : ""}
                {t.runs} {t.runs === 1 ? "run" : "runs"} per scenario
              </dd>
            </dl>
          </div>
          <div>
            <h3>Notes</h3>
            <ul>
              {(data.notes ?? []).map((n) => (
                <li>{n}</li>
              ))}
              <li>
                Every app is in <a href={HARNESS} target="_blank" rel="noopener">bench/compare/</a>: read them, run them on your machine, and
                send a fix if one isn't fair to its framework.
              </li>
            </ul>
          </div>
        </div>
      </div>
    );
  }
}
