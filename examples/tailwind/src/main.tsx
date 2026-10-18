/// <reference types="vite/client" />
import { Region, Scripts, Stylesheet, action, bind, get, route, yerd, type Action, type LayoutProps } from "@toyz/yerd";

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

const counters = new Map<string, { label: string; clicks: number }>([
  ["coffee", { label: "Coffees", clicks: 0 }],
  ["bugs", { label: "Bugs fixed", clicks: 0 }],
  ["deploys", { label: "Deploys", clicks: 0 }],
  ["yerds", { label: "Yerds", clicks: 0 }],
]);

/**
 * One counter. Two things make several of them on a page work:
 * - its Region has its own id, so a response carrying `counter-bugs` morphs
 *   that counter and nothing else;
 * - the form is bound to *this* counter with bind(): the action receives
 *   `{ id }`, signed, so the browser can't change which counter it bumps.
 * `bump` is typed as an Action taking `{ id }`, so passing the wrong action
 * (or binding the wrong arguments) doesn't compile.
 */
function Counter({ id, bump }: { id: string; bump: Action<{ id: string }> }) {
  const counter = counters.get(id)!;
  return (
    <div class="flex flex-col items-center gap-3 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-stone-200 dark:bg-stone-900 dark:ring-stone-800">
      <span class="text-sm font-medium text-stone-500 dark:text-stone-400">{counter.label}</span>
      <Region id={`counter-${id}`} class="text-5xl font-black tabular-nums text-orange-600">
        {/* A new key per value, so the runtime inserts a fresh element and data-[yx-new] animates it. */}
        <span key={counter.clicks} class="inline-block data-[yx-new]:animate-bounce">{counter.clicks}</span>
      </Region>
      <form action={bind(bump, { id })}>
        <button class="rounded-xl bg-orange-600 px-4 py-2 font-semibold text-white shadow transition hover:bg-orange-500 active:translate-y-px">
          +1
        </button>
      </form>
    </div>
  );
}

@route("/", { meta: { title: "Tailwind in yerd" } })
export class Home {
  @get page() {
    return (
      <main class="mx-auto flex max-w-3xl flex-col items-center gap-10 px-4 py-24 text-center">
        <div class="flex flex-col items-center gap-4">
          <h1 class="text-4xl font-bold tracking-tight sm:text-6xl">
            Tailwind, <span class="text-orange-600">yerd</span> style
          </h1>
          <p class="text-lg text-stone-600 dark:text-stone-400">Utility classes in server-rendered TSX, morphed by actions.</p>
        </div>
        <div class="grid w-full grid-cols-2 gap-4 sm:grid-cols-4">
          {[...counters.keys()].map((id) => (
            <Counter id={id} bump={this.bump} />
          ))}
        </div>
      </main>
    );
  }

  /** Bumps one counter and sends back just that counter; its Region replaces the one on the page. */
  @action bump({ id }: { id: string }) {
    const counter = counters.get(id);
    if (!counter) return 404;
    counter.clicks++;
    return <Counter id={id} bump={this.bump} />;
  }
}

export default yerd().layout(RootLayout);
