import { Scripts, Styles, Stylesheet, type LayoutProps } from "@toyz/yerd";

/** Every page of the fixture, for the nav. */
const PAGES: Array<[href: string, label: string]> = [
  ["/", "Home"],
  ["/morph", "Morph"],
  ["/nav/one", "Navigation"],
  ["/prefetch", "Prefetch"],
  ["/triggers", "Triggers"],
  ["/regions", "Regions"],
  ["/forms", "Forms"],
  ["/local", "Local"],
  ["/dnd", "Drag and drop"],
  ["/cues", "Cues"],
  ["/islands", "Islands"],
  ["/lazy", "Lazy modules"],
  ["/session", "Session"],
  ["/stale", "Stale pages"],
];

export function RootLayout({ children, meta }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{meta.title ? `${meta.title} · fixture` : "yerd runtime fixture"}</title>
        <Stylesheet href="src/fixture.css" />
        {/* css`` rules: inline in dev, one hashed stylesheet after vite build. */}
        <Styles />
        <Scripts />
      </head>
      <body>
        <nav class="site" aria-label="Fixture pages" data-yx-boost>
          {PAGES.map(([href, label]) => (
            <a href={href}>{label}</a>
          ))}
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
