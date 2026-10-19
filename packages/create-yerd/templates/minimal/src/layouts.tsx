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
        <Stylesheet href="src/styles.css" />
        <Scripts />
      </head>
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}

/** app.errorPage(): 404s and crashes render here, inside RootLayout. */
export function ErrorPage({ status, message }: ErrorPageProps) {
  return (
    <section class="error">
      <p class="status">{status}</p>
      <h1>{status === 404 ? "Page not found" : "Something went wrong"}</h1>
      <p>{message}</p>
      <a href="/">Home</a>
    </section>
  );
}
