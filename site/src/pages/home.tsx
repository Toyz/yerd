/** The landing page: what yerd is, where to start, and what's in it. */

import { LoomElement, component, css, mount, reactive, styles } from "@toyz/loom";
import { route } from "@toyz/loom/router";
import { entryId, loadApi, type Api } from "../data";
import { Code, SinceBadge } from "../ui";

const sheet = css`
  .hero { padding: 24px 0 8px; }
  .eyebrow { font: 700 0.75rem var(--mono); text-transform: uppercase; letter-spacing: 0.1em; color: var(--accent); }
  .hero h1 { font-size: 3rem; margin: 6px 0 14px; letter-spacing: -0.03em; }
  .tagline { font-size: 1.25rem; line-height: 1.5; color: var(--text-dim); max-width: 720px; margin: 0 0 26px; }
  .tagline strong { color: var(--text); font-weight: 600; }

  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 26px; }
  .btn {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 10px 18px; border-radius: 8px; font-weight: 600; font-size: 0.95rem;
    border: 1px solid var(--border-strong); color: var(--text); background: var(--bg-raised);
  }
  .btn:hover { text-decoration: none; border-color: var(--accent-dim); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--bg); }
  .btn.primary:hover { filter: brightness(1.08); }

  .install { max-width: 560px; }
  .install pre.code { margin: 0; }

  .showcase { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 28px; align-items: center; margin: 48px 0 12px; }
  .showcase h2 { border: 0; margin: 0 0 10px; padding: 0; font-size: 1.4rem; }
  .showcase p { margin: 0 0 10px; }
  .showcase ul { margin: 8px 0 0; padding-left: 1.2em; }
  .showcase pre.code { margin: 0; }
  @media (max-width: 980px) { .showcase { grid-template-columns: 1fr; } }

  h2.features-title { margin-top: 56px; }
  .features { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
  a.feature {
    display: block; padding: 16px 18px; border-radius: var(--radius);
    border: 1px solid var(--border); background: var(--bg-raised); color: var(--text);
    transition: border-color 0.12s ease, transform 0.12s ease;
  }
  a.feature:hover { border-color: var(--accent-dim); text-decoration: none; transform: translateY(-1px); }
  .feature b { display: block; font-size: 1rem; margin-bottom: 4px; }
  .feature span { display: block; font-size: 0.87rem; color: var(--text-dim); line-height: 1.5; }
  .feature code { font-size: 0.78rem; }

  .pending { margin: 40px 0 0; padding: 14px 18px; border: 1px solid rgba(232, 196, 106, 0.35); background: var(--warn-bg); border-radius: var(--radius); }
  .pending-title { display: flex; align-items: center; gap: 10px; margin: 0 0 8px; color: var(--text); font-weight: 600; }
  .pending a { display: inline-block; margin: 2px 14px 2px 0; font-family: var(--mono); font-size: 0.85rem; }

  .meta { margin-top: 48px; padding-top: 18px; border-top: 1px solid var(--border); font-size: 0.82rem; color: var(--text-faint); display: flex; flex-wrap: wrap; gap: 6px 22px; }
  .meta b { color: var(--text-dim); font-weight: 600; }
`;

const SAMPLE = `import { get, post, route, body, is, yerd } from "@toyz/yerd";

class NewTodo {
  @is.string({ validate: (s: string) => s.length > 0 }) title!: string;
}
const todos: NewTodo[] = [];

@route("/todos")
class Todos {
  @body(NewTodo) accessor input!: Promise<NewTodo>;

  @get list() {
    return <ul>{todos.map((t) => <li>{t.title}</li>)}</ul>;
  }

  @post async add() {
    todos.push(await this.input); // validated (or a 400)
    return 201;
  }
}

await yerd().listen(3000);`;

const FEATURES: Array<[title: string, text: string, guide: string]> = [
  ["Routing", "Decorated classes, groups, layouts anywhere, guards, content negotiation.", "routing"],
  ["Request data", "Typed accessors for params, query, bodies and uploads; DTO classes that validate.", "request-data"],
  ["Return anything", "Strings, numbers, objects, streams, JSX pages, or full control with res().", "responses"],
  ["Pages and layouts", "TSX on the server, nested layouts, error pages, prerendering with live parts.", "pages-and-layouts"],
  ["Interactivity", "Forms that work without JavaScript and update in place with it. No client framework.", "interactivity"],
  ["Streaming and live", "NDJSON, Server-Sent Events, and channels that push updates to the right users.", "streaming-and-live"],
  ["Services", "C#-style DI: singleton, scoped and transient lifetimes, hooks, background work.", "services"],
  ["Sessions and auth", "Sealed sessions, typed users, roles, CSRF protection that's on by default.", "sessions-and-auth"],
  ["Logging", "Spans like Rust's tracing, request ids, @instrument, bring-your-own sink.", "logging"],
  ["Deploying", "A Vite plugin for dev and builds, or plain tsc and node. Graceful shutdown built in.", "deploying"],
  ["Testing", "Boot the app on a random port and fetch it. Fakes through DI.", "testing"],
];

@route("/")
@component("page-home")
@styles(sheet)
export class PageHome extends LoomElement {
  @reactive accessor api: Api | undefined = undefined;

  @mount async load() {
    window.scrollTo(0, 0);
    this.api = await loadApi();
  }

  update() {
    const api = this.api;
    const unreleased = api ? api.entries.filter((e) => e.since === null) : [];
    const newMembers = api ? api.entries.flatMap((e) => (e.members ?? []).filter((m) => m.since === null).map((m) => ({ e, m }))) : [];
    return (
      <div>
        <div class="hero">
          <div class="eyebrow">TypeScript web server for Node</div>
          <h1>yerd</h1>
          <p class="tagline">
            Routes are <strong>decorated classes</strong>, <strong>TSX</strong> is the template engine, and a handler can{" "}
            <strong>return anything</strong>. Zero runtime dependencies.
          </p>
          <div class="actions">
            <a class="btn primary" href="#/guide/getting-started">Get started →</a>
            <a class="btn" href="#/guide/your-first-app">Build your first app</a>
            <a class="btn" href="#/api">API reference</a>
          </div>
          <div class="install">
            <Code code={"npm install @toyz/yerd"} lang="sh" />
          </div>
        </div>

        <div class="showcase">
          <Code code={SAMPLE} lang="tsx" />
          <div>
            <h2>One class, one URL</h2>
            <p>Each route is a class. Methods answer verbs, accessors pull typed, validated request data, and whatever you return becomes the response.</p>
            <ul>
              <li>A string is text, a number is a status, an object is JSON.</li>
              <li>JSX is an HTML page, wrapped in your layouts.</li>
              <li>An async iterable streams.</li>
            </ul>
          </div>
        </div>

        <h2 class="features-title">What's in the box</h2>
        <div class="features">
          {FEATURES.map(([title, text, guide]) => (
            <a class="feature" href={`#/guide/${guide}`}>
              <b>{title}</b>
              <span>{text}</span>
            </a>
          ))}
        </div>

        {unreleased.length + newMembers.length > 0 ? (
          <div class="pending">
            <div class="pending-title">
              On main, not released yet <SinceBadge since={null} />
            </div>
            {unreleased.map((e) => (
              <a href={`#/api/${entryId(e)}`}>{e.name}</a>
            ))}
            {newMembers.map(({ e, m }) => (
              <a href={`#/api/${entryId(e)}`}>
                {e.name}.{m.name}
              </a>
            ))}
          </div>
        ) : null}

        {api ? (
          <div class="meta">
            <span>
              <b>{api.entries.length}</b> public exports
            </span>
            <span>
              latest release <b>{api.latest ? `v${api.latest}` : "none"}</b>
            </span>
            <span>
              docs built from main at <b>{api.commit}</b>
            </span>
            <a href="https://github.com/Toyz/yerd" target="_blank" rel="noopener">GitHub</a>
            <a href="https://www.npmjs.com/package/@toyz/yerd" target="_blank" rel="noopener">npm</a>
          </div>
        ) : null}
      </div>
    );
  }
}
