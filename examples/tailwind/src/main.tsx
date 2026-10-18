/// <reference types="vite/client" />
import { Region, Scripts, Stylesheet, action, get, route, yerd, type LayoutProps } from "@toyz/yerd";

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

let clicks = 0;

function Counter() {
  return (
    <Region id="counter" class="text-5xl font-black tabular-nums text-orange-600">
      <span key={clicks} class="inline-block data-[yx-new]:animate-bounce">{clicks}</span>
    </Region>
  );
}

@route("/", { meta: { title: "Tailwind in yerd" } })
export class Home {
  @get page() {
    return (
      <main class="mx-auto flex max-w-xl flex-col items-center gap-6 px-4 py-24 text-center">
        <h1 class="text-4xl font-bold tracking-tight sm:text-6xl">
          Tailwind, <span class="text-orange-600">yerd</span> style
        </h1>
        <p class="text-lg text-stone-600 dark:text-stone-400">Utility classes in server-rendered TSX, morphed by actions.</p>
        <Counter />
        <form action={this.bump}>
          <button class="rounded-xl bg-orange-600 px-5 py-3 font-semibold text-white shadow-lg transition hover:bg-orange-500 active:translate-y-px">
            Click me
          </button>
        </form>
      </main>
    );
  }

  @action bump() {
    clicks++;
    return <Counter />;
  }
}

export default yerd().layout(RootLayout);
