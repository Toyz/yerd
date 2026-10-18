/**
 * The landing page: what yerd is in one look (a route class, and what each
 * kind of return value turns into), how to install it, where to go next,
 * and how it measures up.
 */

import { LoomElement, component, css, mount, reactive, styles } from "@toyz/loom";
import { route } from "@toyz/loom/router";
import { BASELINE, BenchBars, benchStyles, fastestFramework, formatNumber } from "../bench-chart";
import { loadApi, loadBenchmarks, type Api, type BenchState } from "../data";
import { highlight } from "../highlight";
import { Mark, onCopyClick } from "../ui";

const sheet = css`
  ${benchStyles}
  :host { padding-top: 0; }
  .wrap { max-width: 1160px; margin: 0 auto; }

  /* ── hero ── */
  .hero {
    display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr); gap: 56px; align-items: center;
    padding: 64px 0 56px;
  }
  .hero h1 { font-size: clamp(2.5rem, 1.6rem + 3vw, 3.9rem); line-height: 1.04; letter-spacing: -0.02em; margin: 0 0 22px; }
  .hero .pitch { font-size: 1.15rem; line-height: 1.6; color: var(--text-dim); margin: 0 0 30px; max-width: 34rem; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 22px; }
  .btn {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 11px 20px; border-radius: 6px; font-weight: 700; font-size: 0.98rem; text-decoration: none;
    border: 1px solid var(--border-strong); color: var(--text); background: var(--bg-raised);
  }
  .btn:hover { border-color: var(--text-faint); }
  .btn.primary { background: light-dark(#b23c21, #e0573b); border-color: transparent; color: light-dark(#fff, #1b1814); }
  .btn.primary:hover { background: light-dark(#9a321b, #ea6a4f); }
  .install {
    display: flex; align-items: center; gap: 12px; max-width: 30rem;
    padding: 6px 6px 6px 16px; border-radius: 6px;
    background: var(--code-bg); border: 1px solid var(--border);
    font: 0.92rem var(--mono); color: var(--code-text);
  }
  .install .prompt { color: var(--text-faint); user-select: none; }
  .install code { background: none; padding: 0; font-size: inherit; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .install button {
    font: 700 0.78rem var(--font); padding: 6px 12px; border-radius: 4px; cursor: pointer;
    border: 1px solid var(--border-strong); background: var(--bg-raised); color: var(--text-dim);
  }
  .install button:hover { color: var(--accent); border-color: var(--accent-dim); }

  /* ── the demo: one route, five return values ── */
  .demo { border-radius: 10px; border: 1px solid var(--border-strong); background: var(--bg-raised); overflow: hidden; box-shadow: var(--shadow); }
  .demo-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 12px; border-bottom: 1px solid var(--border); }
  .demo-bar .ask { font-size: 0.85rem; color: var(--text-dim); }
  .choices { display: flex; gap: 2px; flex-wrap: wrap; padding: 3px; border-radius: 7px; background: var(--bg-sunken); }
  .choices button {
    font: 600 0.84rem var(--font); padding: 5px 11px; border-radius: 5px; border: 0; cursor: pointer;
    background: none; color: var(--text-dim);
  }
  .choices button:hover { color: var(--text); }
  .choices button[aria-pressed="true"] { background: var(--bg-raised); color: var(--text); box-shadow: 0 1px 2px rgba(60, 40, 20, 0.18); }
  .demo pre {
    margin: 0; padding: 16px 0; background: var(--code-bg); color: var(--code-text);
    font: 0.84rem/1.65 var(--mono); overflow-x: auto; scrollbar-width: thin;
  }
  .demo pre code { display: inline-block; min-width: 100%; }
  .demo pre .line { display: block; padding: 0 18px; border-left: 3px solid transparent; min-height: 1.65em; }
  .demo pre .line.changed { background: var(--accent-bg); border-left-color: var(--brand); }
  .file { font: 0.76rem var(--mono); color: var(--text-faint); padding: 8px 18px 0; background: var(--code-bg); }
  .response { padding: 14px 18px 18px; border-top: 1px dashed var(--border-strong); min-height: 168px; }
  .req { font: 0.8rem var(--mono); color: var(--text-faint); margin-bottom: 8px; }
  .exchange + .exchange { margin-top: 14px; padding-top: 12px; border-top: 1px dotted var(--border-strong); }
  .status { font: 600 0.84rem var(--mono); color: var(--text); }
  .status.bad { color: var(--warn); }
  .header-line { font: 0.8rem var(--mono); color: var(--text-dim); }
  .body { margin-top: 10px; font: 0.84rem/1.6 var(--mono); color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; }
  .body.empty { color: var(--text-faint); font-style: italic; font-family: var(--font); }
  .body .chunk { display: block; animation: arrive 0.3s ease both; }
  @keyframes arrive { from { opacity: 0; transform: translateY(3px); } }

  .card {
    margin-top: 10px; display: flex; gap: 14px; align-items: center;
    padding: 12px 14px; border-radius: 8px; background: var(--bg); border: 1px solid var(--border);
    font-family: var(--font);
  }
  .card .thumb { flex: none; width: 40px; height: 40px; border-radius: 8px; display: grid; place-items: center; background: var(--accent-bg); color: var(--accent); font: 700 0.8rem var(--mono); }
  .card b { display: block; font: 400 1.15rem var(--display); color: var(--text); }
  .card span { display: block; font-size: 0.85rem; color: var(--text-dim); }
  .card .price { margin-left: auto; text-align: right; font-weight: 700; color: var(--text); }
  .card .price small { display: block; font-weight: 400; color: var(--moss); font-size: 0.8rem; }

  /* ── sections ── */
  section.band { padding: 56px 0; border-top: 1px solid var(--border); }
  section.band > h2 { margin: 0 0 8px; font-size: 1.9rem; }
  section.band > p.intro { margin: 0 0 30px; max-width: var(--measure); }

  .features { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 32px; }
  a.feature { display: block; padding: 14px 0 16px; color: var(--text); text-decoration: none; border-bottom: 1px solid var(--border); }
  a.feature b { display: flex; align-items: center; gap: 9px; font-size: 1.06rem; margin-bottom: 4px; }
  a.feature b::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 2px; background: var(--brand); }
  a.feature span { display: block; color: var(--text-dim); font-size: 0.95rem; line-height: 1.55; }
  a.feature code { display: block; margin-top: 8px; background: none; padding: 0; font-size: 0.8rem; color: var(--text-faint); }
  a.feature:hover b { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; }
  .more { margin-top: 22px; font-weight: 700; }

  .deps { display: grid; grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr); gap: 48px; align-items: start; }
  .tree {
    margin: 0; padding: 18px 20px; border-radius: 8px; background: var(--code-bg); border: 1px solid var(--border);
    font: 0.9rem/1.7 var(--mono); color: var(--code-text); overflow-x: auto;
  }
  .tree .dim { color: var(--text-faint); }
  .tree .pkg { color: var(--accent); font-weight: 600; }
  .deps h2 { margin: 0 0 10px; font-size: 1.9rem; }
  .deps p { margin: 0 0 18px; }
  .inbox { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 0; list-style: none; }
  .inbox li {
    margin: 0; padding: 5px 12px; border-radius: 999px; font-size: 0.9rem; color: var(--text);
    background: var(--moss-bg);
  }

  .teaser-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 24px; margin-bottom: 6px; }
  .teaser-head h2 { margin: 0; font-size: 1.9rem; }
  .teaser h3 { margin: 14px 0 12px; font-size: 1rem; color: var(--text-dim); font-weight: 400; }
  .teaser h3 b { color: var(--text); }
  .teaser .chart { border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); padding: 8px 0; }
  .teaser .sample { font-size: 0.85rem; color: var(--warn); margin: 10px 0 0; }

  @media (max-width: 980px) {
    .hero { grid-template-columns: minmax(0, 1fr); gap: 36px; padding: 40px 0; }
    .features { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .deps { grid-template-columns: minmax(0, 1fr); gap: 24px; }
  }
  @media (max-width: 620px) {
    .features { grid-template-columns: minmax(0, 1fr); }
    .demo pre { font-size: 0.78rem; }
    .demo pre .line { padding: 0 12px; }
    .response { padding: 12px; }
    section.band { padding: 44px 0; }
  }
`;

const ROUTE_HEAD = `@route("/products/:id")
class ProductPage {
  @param("id", { transform: toInt }) accessor id!: number;
  @inject(Shop) accessor shop!: Shop;
`;
const ROUTE_END = `  }
}`;

/** The handler around each tab's changed line. */
const HANDLERS = {
  show: `  @get show() {
    const product = this.shop.find(this.id);
    if (!product) return new NotFound("No such product");`,
  find: `  @get show() {`,
  remove: `  @del remove() {
    this.shop.remove(this.id);`,
};

type Exchange = {
  request: string;
  status: string;
  headers: string[];
  body: "card" | "empty" | string | string[];
};

type Answer = {
  label: string;
  handler: keyof typeof HANDLERS;
  line: string;
  exchanges: Exchange[];
};

const PRODUCT = "GET /products/7";

const ANSWERS: Record<string, Answer> = {
  jsx: {
    label: "JSX",
    handler: "show",
    line: "return <ProductCard product={product} />;",
    exchanges: [{ request: PRODUCT, status: "200 OK", headers: ["content-type: text/html", "(inside your layouts, streamed)"], body: "card" }],
  },
  object: {
    label: "an object",
    handler: "find",
    line: 'return this.shop.find(this.id) ?? new NotFound("No such product");',
    exchanges: [
      { request: PRODUCT, status: "200 OK", headers: ["content-type: application/json"], body: `{"id":7,"name":"Field notebook","price":24,"stock":3}` },
      { request: "GET /products/99", status: "404 Not Found", headers: ["content-type: application/json"], body: `{"error":"No such product","code":"not_found"}` },
    ],
  },
  string: {
    label: "a string",
    handler: "show",
    line: "return `${product.name}: ${product.stock} in stock`;",
    exchanges: [{ request: PRODUCT, status: "200 OK", headers: ["content-type: text/plain"], body: "Field notebook: 3 in stock" }],
  },
  number: {
    label: "a number",
    handler: "remove",
    line: "return 204;",
    exchanges: [{ request: "DELETE /products/7", status: "204 No Content", headers: [], body: "empty" }],
  },
  stream: {
    label: "a stream",
    handler: "show",
    line: "return this.shop.stockUpdates(product); // async iterable",
    exchanges: [
      {
        request: PRODUCT,
        status: "200 OK",
        headers: ["content-type: text/plain", "transfer-encoding: chunked"],
        body: ["Field notebook: 3 left\n", "Field notebook: 2 left\n", "Field notebook: 2 left (one on hold)\n", "Field notebook: sold out\n"],
      },
    ],
  },
};

/** The tallest handler's line count, so the code doesn't jump between tabs. */
const CODE_LINES = ROUTE_HEAD.split("\n").length + Math.max(...Object.values(HANDLERS).map((h) => h.split("\n").length)) + 1 + ROUTE_END.split("\n").length;

const FEATURES: Array<{ title: string; text: string; code: string; guide: string }> = [
  { title: "Routing", text: "A class per URL, a method per verb. Groups, guards and layouts nest the way your folders do.", code: "@route @get @post @group", guide: "routing" },
  { title: "Request data", text: "Typed accessors for params, query, headers and bodies. DTO classes validate before your handler runs.", code: "@param @query @body is.string()", guide: "request-data" },
  { title: "Pages in TSX", text: "TSX rendered on the server, nested layouts, error pages, and prerendering with live parts.", code: "<Layout> <Dynamic>", guide: "pages-and-layouts" },
  { title: "Forms that work without JS", text: "Actions post with or without JavaScript and update the page in place when it's there.", code: "@action <Region>", guide: "interactivity" },
  { title: "Services", text: "Singleton, scoped and transient lifetimes, injected into routes, with hooks and background work.", code: "@service @inject @every", guide: "services" },
  { title: "Sessions and auth", text: "Sealed sessions, typed users and roles, argon2id passwords, CSRF checks on by default.", code: "createAuth() @session", guide: "sessions-and-auth" },
];

const BUILT_IN = [
  "router",
  "body parsing",
  "validation",
  "TSX renderer",
  "layouts",
  "sessions",
  "auth and CSRF",
  "DI container",
  "SSE and NDJSON",
  "live channels",
  "client runtime",
  "structured logging",
  "Vite plugin",
];

/** Popular rather than fast: the one most readers are coming from. */
const FAMILIAR = "express";

@route("/")
@component("page-home")
@styles(sheet)
export class PageHome extends LoomElement {
  @reactive accessor api: Api | undefined = undefined;
  @reactive accessor bench: BenchState | undefined = undefined;
  @reactive accessor answer = "jsx";
  @reactive accessor copied = false;

  @mount async load() {
    window.scrollTo(0, 0);
    const [api, bench] = await Promise.all([loadApi(), loadBenchmarks()]);
    this.api = api;
    this.bench = bench;
  }

  #copyInstall() {
    void navigator.clipboard?.writeText("npm install @toyz/yerd").then(() => {
      this.copied = true;
      setTimeout(() => (this.copied = false), 1400);
    });
  }

  #code() {
    const a = ANSWERS[this.answer]!;
    const top = highlight(`${ROUTE_HEAD}\n${HANDLERS[a.handler]}`, "tsx").split("\n");
    const bottom = highlight(ROUTE_END, "tsx").split("\n");
    const changed = highlight(`    ${a.line}`, "tsx");
    return (
      <pre aria-label="A yerd route class" style={`min-height: ${CODE_LINES * 1.65}em`}>
        <code>
          {top.map((html) => <span class="line" rawHTML={html}></span>)}
          <span class="line changed" rawHTML={changed}></span>
          {bottom.map((html) => <span class="line" rawHTML={html}></span>)}
        </code>
      </pre>
    );
  }

  #response() {
    const a = ANSWERS[this.answer]!;
    return (
      <div class="response" aria-live="polite">
        {a.exchanges.map((x) => this.#exchange(x))}
      </div>
    );
  }

  #exchange(a: Exchange) {
    let body: unknown;
    if (a.body === "card") {
      body = (
        <div class="card">
          <div class="thumb" aria-hidden="true">FN</div>
          <div>
            <b>Field notebook</b>
            <span>Dot grid, 120 pages, lay-flat binding</span>
          </div>
          <div class="price">
            $24
            <small>3 in stock</small>
          </div>
        </div>
      );
    } else if (a.body === "empty") {
      body = <div class="body empty">No body: the number is the status.</div>;
    } else if (Array.isArray(a.body)) {
      body = (
        <div class="body">
          {a.body.map((chunk, i) => (
            <span class="chunk" style={`animation-delay: ${i * 0.35}s`} loom-key={`${this.answer}-${i}`}>
              {chunk.trimEnd()}
            </span>
          ))}
        </div>
      );
    } else {
      body = <div class="body">{a.body}</div>;
    }
    return (
      <div class="exchange">
        <div class="req">{a.request}</div>
        <div class={`status ${a.status.startsWith("2") ? "" : "bad"}`}>HTTP/1.1 {a.status}</div>
        {a.headers.map((h) => (
          <div class="header-line">{h}</div>
        ))}
        {body}
      </div>
    );
  }

  #teaser() {
    const state = this.bench;
    if (!state) return null;
    const data = state.data;
    if (!data || data.scenarios.length === 0) {
      return (
        <section class="band teaser">
          <div class="teaser-head">
            <h2>Benchmarks</h2>
            <a href="#/benchmarks">How they're run</a>
          </div>
          <p class="intro">
            yerd against Express, Fastify, Hono, Koa and NestJS, on the same machine with the same apps. The numbers haven't been run for this
            build of the docs yet.
          </p>
        </section>
      );
    }
    // The harness's first scenario, whatever it shows: the page doesn't pick the flattering one.
    const scenario = data.scenarios[0]!;
    const yerd = scenario.results.find((r) => r.framework === "yerd");
    const fastest = fastestFramework(scenario.results);
    const only = [...new Set(["yerd", fastest?.framework, FAMILIAR, BASELINE].filter((id): id is string => !!id && scenario.results.some((r) => r.framework === id)))];
    const nameOf = (id: string | undefined) => data.frameworks.find((f) => f.id === id)?.name ?? id ?? "";
    const others = data.frameworks.filter((f) => f.id !== "yerd" && f.id !== BASELINE).length;
    return (
      <section class="band teaser">
        <div class="teaser-head">
          <h2>Benchmarks</h2>
          <a href="#/benchmarks">
            All {data.scenarios.length} scenarios, {others} other frameworks
          </a>
        </div>
        <p class="intro">Same machine, same apps, same load. A few rows from the first scenario; the full page has every framework and every number.</p>
        {yerd && fastest ? (
          <h3>
            <b>{scenario.title}</b>: yerd serves {formatNumber(Math.round(yerd.reqPerSec))} requests a second,{" "}
            {Math.round((yerd.reqPerSec / fastest.reqPerSec) * 100)}% of {fastest.framework === "yerd" ? "itself (the fastest here)" : nameOf(fastest.framework)}.
          </h3>
        ) : (
          <h3>
            <b>{scenario.title}</b>
          </h3>
        )}
        <div class="chart">
          <BenchBars data={data} scenario={scenario} only={only} />
        </div>
        {state.sample ? <p class="sample">Sample data, shown in development only.</p> : null}
      </section>
    );
  }

  update() {
    return (
      <div class="wrap">
        <div class="hero">
          <div>
            <h1>Routes are classes. Handlers return anything.</h1>
            <p class="pitch">
              yerd is a TypeScript web server for Node. Decorate a class, return what fits (a page in TSX, an object, a number, a stream) and
              yerd turns it into the response. No runtime dependencies.
            </p>
            <div class="actions">
              <a class="btn primary" href="#/guide/getting-started">Get started</a>
              <a class="btn" href="#/guide/your-first-app">Build your first app</a>
            </div>
            <div class="install">
              <span class="prompt">$</span>
              <code>npm install @toyz/yerd</code>
              <button type="button" onClick={() => this.#copyInstall()} aria-label="Copy the install command">
                {this.copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          <div class="demo">
            <div class="demo-bar">
              <span class="ask" id="returns">The handler returns</span>
              <div class="choices" role="group" aria-labelledby="returns">
                {Object.entries(ANSWERS).map(([id, a]) => (
                  <button type="button" aria-pressed={this.answer === id ? "true" : "false"} onClick={() => (this.answer = id)}>
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
            <div class="file">src/routes/product.tsx</div>
            {this.#code()}
            {this.#response()}
          </div>
        </div>

        <section class="band">
          <h2>What's in it</h2>
          <p class="intro">Everything a server-rendered app needs, each with a guide that starts from a working example.</p>
          <div class="features" onClick={onCopyClick}>
            {FEATURES.map((f) => (
              <a class="feature" href={`#/guide/${f.guide}`}>
                <b>{f.title}</b>
                <span>{f.text}</span>
                <code>{f.code}</code>
              </a>
            ))}
          </div>
          <p class="more">
            <a href="#/guide/getting-started">All guides</a>, or the <a href="#/api">API reference</a>
            {this.api ? `, ${this.api.entries.length} exports generated from the source` : ""}.
          </p>
        </section>

        <section class="band">
          <div class="deps">
            <pre class="tree" aria-label="npm ls output for an app using yerd">
              <span class="dim">$ npm ls --omit=dev</span>
              {"\n"}my-shop@1.0.0{"\n"}└── <span class="pkg">@toyz/yerd@{this.api?.latest ?? this.api?.version ?? "0.x"}</span>
              {"\n"}
              <span class="dim">{"\n"}(that's the whole tree)</span>
            </pre>
            <div>
              <h2>One package, nothing under it</h2>
              <p>
                yerd has zero runtime dependencies. What you'd usually assemble from a dozen packages ships in the one you install, written and
                tested together:
              </p>
              <ul class="inbox">
                {BUILT_IN.map((item) => (
                  <li>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {this.#teaser()}
      </div>
    );
  }
}
