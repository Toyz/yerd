import { Scripts, Stylesheet, type ErrorPageProps, type LayoutProps } from "@toyz/yerd";

/** The document around every HTML response, error pages included. */
export function RootLayout({ children, meta }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <title>{meta.title ? `${meta.title} · {{name}}` : "{{name}}"}</title>
        {/* Tailwind's output: served by Vite in dev, the hashed file after `vite build`. */}
        <Stylesheet href="src/styles.css" />
        <Scripts />
      </head>
      <body class="min-h-dvh bg-stone-50 text-stone-900 antialiased dark:bg-stone-950 dark:text-stone-100">
        <main class="mx-auto max-w-2xl px-5 py-16">{children}</main>
      </body>
    </html>
  );
}

/** app.errorPage(): 404s and crashes render here, inside RootLayout. */
export function ErrorPage({ status, message }: ErrorPageProps) {
  return (
    <section class="flex flex-col gap-3">
      <p class="text-5xl font-bold text-stone-400">{status}</p>
      <h1 class="text-3xl font-bold">{status === 404 ? "Page not found" : "Something went wrong"}</h1>
      <p class="text-stone-600 dark:text-stone-400">{message}</p>
      <a class="text-orange-700 underline dark:text-orange-400" href="/">Home</a>
    </section>
  );
}
