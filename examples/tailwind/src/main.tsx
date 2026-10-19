/// <reference types="vite/client" />
import {
  Local, Region, Scripts, Stylesheet, action, get, route, session, yerd,
  type Action, type Child, type LayoutProps, type Session,
} from "@toyz/yerd";

function RootLayout({ children, meta }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{meta.title ?? "yerd + tailwind"}</title>
        {/* Vite serves (and Tailwind builds) this in dev; after `vite build` it's the hashed file. */}
        <Stylesheet href="src/app.css" />
        <Scripts />
      </head>
      <body class="min-h-dvh bg-stone-100 text-stone-900 antialiased dark:bg-stone-950 dark:text-stone-100">{children}</body>
    </html>
  );
}

const LABELS: Record<string, string> = { coffee: "Coffees", bugs: "Bugs fixed", deploys: "Deploys", yerds: "Yerds" };
const IDS = Object.keys(LABELS);

/** Shared by everyone: one count per counter, in this process. */
const shared = new Map<string, number>(IDS.map((id) => [id, 0]));

/**
 * What this page keeps in a visitor's session: their own counts, by counter
 * id. A class, so the session gets its method; `= {}` is a default, saved
 * only once a counter is bumped.
 */
class Counts {
  mine: Record<string, number> = {};

  bump(id: string): number {
    this.mine[id] = (this.mine[id] ?? 0) + 1;
    return this.mine[id];
  }
}

/** Where a counter keeps its count. */
type Store =
  | { kind: "shared" | "session"; value: number; bump: Action<{ id: string }> }
  | { kind: "tab" | "browser" };

/**
 * One counter, wherever its count lives. Server stores (shared, session)
 * post an action and get back just this counter: its Region id is unique
 * (`shared-bugs`) and its form calls the action with this counter's id, signed,
 * so the browser can't change which one it bumps. Client stores (tab,
 * browser) are a <Local>: clicks never leave the page, and "browser" keeps
 * the count in localStorage across reloads.
 */
function Counter({ id, store }: { id: string; store: Store }) {
  const big = "text-5xl font-black tabular-nums text-orange-600";
  if (store.kind === "shared" || store.kind === "session") {
    return (
      <Card label={LABELS[id] ?? id}>
        <Region id={`${store.kind}-${id}`} class={big}>
          {/* A new key per value, so the runtime inserts a fresh element and data-[yx-new] animates it. */}
          <span key={store.value} class="inline-block data-[yx-new]:animate-bounce">{store.value}</span>
        </Region>
        <form action={() => store.bump({ id })}>
          <PlusButton />
        </form>
      </Card>
    );
  }
  return (
    <Card label={LABELS[id] ?? id}>
      <Local state={{ count: 0 }} persist={store.kind === "browser" ? `counter-${id}` : undefined}>
        {(s) => (
          <>
            <span class={big}>{s.count}</span>
            <PlusButton onClick={() => s.count++} />
          </>
        )}
      </Local>
    </Card>
  );
}

function Card({ label, children }: { label: string; children: Child }) {
  return (
    <div class="flex flex-col items-center gap-3 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-stone-200 dark:bg-stone-900 dark:ring-stone-800">
      <span class="text-sm font-medium text-stone-500 dark:text-stone-400">{label}</span>
      {children}
    </div>
  );
}

/** A form's submit button (server stores), or a click handler (inside a <Local>). */
function PlusButton({ onClick }: { onClick?: () => unknown }) {
  return (
    <button
      class="rounded-xl bg-orange-700 px-4 py-2 font-semibold text-white shadow transition hover:bg-orange-800 active:translate-y-px"
      onClick={onClick}
    >
      +1
    </button>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: Child }) {
  return (
    <section class="flex w-full flex-col gap-4">
      <div class="text-left">
        <h2 class="text-xl font-bold">{title}</h2>
        <p class="text-sm text-stone-600 dark:text-stone-400">{note}</p>
      </div>
      <div class="grid w-full grid-cols-2 gap-4 sm:grid-cols-4">{children}</div>
    </section>
  );
}

@route("/", { meta: { title: "Tailwind in yerd" } })
export class Home {
  // The session, seen through Counts: this.counts.mine and this.counts.bump(), typed.
  @session(Counts) accessor counts!: Session<Counts>;

  @get page() {
    return (
      <main class="mx-auto flex max-w-3xl flex-col items-center gap-12 px-4 py-20 text-center">
        <div class="flex flex-col items-center gap-4">
          <h1 class="text-4xl font-bold tracking-tight sm:text-6xl">
            Tailwind, <span class="text-orange-600">yerd</span> style
          </h1>
          <p class="text-lg text-stone-600 dark:text-stone-400">One counter component, four places to keep its count.</p>
        </div>

        <Section title="Shared" note="Server state everyone sees. Open a second browser: same numbers.">
          {IDS.map((id) => <Counter id={id} store={{ kind: "shared", value: shared.get(id)!, bump: this.bumpShared }} />)}
        </Section>

        <Section title="Yours" note="Kept in your session on the server: survives a reload, another browser has its own.">
          {IDS.map((id) => <Counter id={id} store={{ kind: "session", value: this.counts.mine[id] ?? 0, bump: this.bumpMine }} />)}
        </Section>

        <Section title="This tab" note="Local state: no requests at all, gone on reload.">
          {IDS.map((id) => <Counter id={id} store={{ kind: "tab" }} />)}
        </Section>

        <Section title="This browser" note="Local state kept in localStorage: no requests, survives a reload, other tabs follow along.">
          {IDS.map((id) => <Counter id={id} store={{ kind: "browser" }} />)}
        </Section>
      </main>
    );
  }

  /** Bumps one shared counter and sends back just that counter; its Region replaces the one on the page. */
  @action bumpShared({ id }: { id: string }) {
    if (!shared.has(id)) return 404;
    shared.set(id, shared.get(id)! + 1);
    return <Counter id={id} store={{ kind: "shared", value: shared.get(id)!, bump: this.bumpShared }} />;
  }

  /** Same, in this visitor's session: the action token is bound to the session too, so it can't be replayed from another. */
  @action bumpMine({ id }: { id: string }) {
    if (!(id in LABELS)) return 404;
    return <Counter id={id} store={{ kind: "session", value: this.counts.bump(id), bump: this.bumpMine }} />;
  }
}

export default yerd().layout(RootLayout).sessions();
