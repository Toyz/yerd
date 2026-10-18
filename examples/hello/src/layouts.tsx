import type { Child } from "@toyz/yerd";

export function RootLayout({ children }: { children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>yerd</title>
      </head>
      <body>
        <nav>
          <a href="/">home</a> <a href="/users/7">user 7</a> <a href="/api/health">health</a>{" "}
          <a href="/api/stats">stats</a> <a href="/api/ticks?count=5">ndjson ticks</a>
        </nav>
        {children}
      </body>
    </html>
  );
}
