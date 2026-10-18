/// <reference types="vite/client" />
import {
  Local, Region, Scripts, Stylesheet, action, bind, get, not, route, session, yerd,
  type Action, type Child, type LayoutProps, type Session,
} from "@toyz/yerd";

// What this app keeps in a visitor's session: their own counts, by counter id.
declare module "@toyz/yerd" {
  interface SessionData {
    mine?: Record<string, number>;
  }
}

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

/** Shared by everyone: one count per counter, in this process. */
const shared = new Map<string, number>(Object.keys(LABELS).map((id) => [id, 0]));

/**
 * One counter card. Two things let several live on one page:
 * - its Region id is unique (`shared-bugs`, `mine-bugs`), so a response
 *   carrying one morphs that counter and nothing else;
 * - its form is bound to *this* counter with bind(): the action receives
 *   `{ id }`, signed, so the browser can't change which one it bumps.
 * `bump` is typed as an Action taking `{ id }`, so passing the wrong action
 * (or binding the wrong arguments) doesn't compile.
 */
function Counter({ scope, id, value, bump }: { scope: string; id: string; value: number; bump: Action<{ id: string }> }) {
  return (
    <Card label={LABELS[id] ?? id}>
      <Region id={`${scope}-${id}`} class="text-5xl font-black tabular-nums text-orange-600">
        {/* A new key per value, so the runtime inserts a fresh element and data-[yx-new] animates it. */}
        <span key={value} class="inline-block data-[yx-new]:animate-bounce">{value}</span>
      </Region>
      <form action={bind(bump, { id })}>
        <PlusButton />
      </form>
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

function PlusButton() {
  return (
    <button class="rounded-xl bg-orange-600 px-4 py-2 font-semibold text-white shadow transition hover:bg-orange-500 active:translate-y-px">
      +1
    </button>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: Child }) {
  return (
    <section class="flex w-full flex-col gap-4">
      <div class="text-left">
        <h2 class="text-xl font-bold">{title}</h2>
        <p class="text-sm text-stone-500 dark:text-stone-400">{note}</p>
      </div>
      <div class="grid w-full grid-cols-2 gap-4 sm:grid-cols-4">{children}</div>
    </section>
  );
}

@route("/", { meta: { title: "Tailwind in yerd" } })
export class Home {
  @session accessor session!: Session;

  get mine(): Record<string, number> {
    return this.session.get("mine") ?? {};
  }

  @get page() {
    return (
      <main class="mx-auto flex max-w-3xl flex-col items-center gap-12 px-4 py-20 text-center">
        <div class="flex flex-col items-center gap-4">
          <h1 class="text-4xl font-bold tracking-tight sm:text-6xl">
            Tailwind, <span class="text-orange-600">yerd</span> style
          </h1>
          <p class="text-lg text-stone-600 dark:text-stone-400">Three kinds of state, one page.</p>
        </div>

        <Section title="Shared" note="Server state everyone sees. Open a second browser: same numbers.">
          {[...shared.keys()].map((id) => (
            <Counter scope="shared" id={id} value={shared.get(id)!} bump={this.bumpShared} />
          ))}
        </Section>

        <Section title="Yours" note="Kept in your session: survives a reload, and a different browser has its own.">
          {Object.keys(LABELS).map((id) => (
            <Counter scope="mine" id={id} value={this.mine[id] ?? 0} bump={this.bumpMine} />
          ))}
        </Section>

        <Section title="Local" note="Lives only in this tab: no requests at all, gone on reload.">
          {Object.keys(LABELS).map((id) => (
            <Card label={LABELS[id]!}>
              <Local state={{ count: 0, picked: false }}>
                {(s) => (
                  <div class="flex flex-col items-center gap-3">
                    <span class={{ "text-5xl font-black tabular-nums": true, "text-orange-600": not(s.picked), "text-emerald-600": s.picked }}>
                      {s.count}
                    </span>
                    <div class="flex gap-2">
                      <button
                        class="rounded-xl bg-orange-600 px-4 py-2 font-semibold text-white shadow transition hover:bg-orange-500 active:translate-y-px"
                        onClick={() => s.count++}
                      >
                        +1
                      </button>
                      <button
                        class="rounded-xl px-3 py-2 font-semibold ring-1 ring-stone-300 dark:ring-stone-700"
                        aria-pressed={s.picked}
                        onClick={() => (s.picked = !s.picked)}
                      >
                        ★
                      </button>
                    </div>
                  </div>
                )}
              </Local>
            </Card>
          ))}
        </Section>
      </main>
    );
  }

  /** Bumps one shared counter and sends back just that counter; its Region replaces the one on the page. */
  @action bumpShared({ id }: { id: string }) {
    if (!shared.has(id)) return 404;
    shared.set(id, shared.get(id)! + 1);
    return <Counter scope="shared" id={id} value={shared.get(id)!} bump={this.bumpShared} />;
  }

  /** Same, in this visitor's session: the action token is bound to the session too, so it can't be replayed from another. */
  @action bumpMine({ id }: { id: string }) {
    if (!(id in LABELS)) return 404;
    const mine = { ...this.mine, [id]: (this.mine[id] ?? 0) + 1 };
    this.session.set("mine", mine);
    return <Counter scope="mine" id={id} value={mine[id]!} bump={this.bumpMine} />;
  }
}

export default yerd().layout(RootLayout).sessions();
