/** What each API section is for, and the guide that teaches it. */
export const SECTION_INFO: Record<string, { blurb: string; guide?: string }> = {
  Server: { blurb: "Create the app, wire layouts, middleware, static files and error pages, then listen.", guide: "getting-started" },
  Routing: { blurb: "Classes become routes: paths, verbs, groups, layouts, content negotiation and prerendering.", guide: "routing" },
  "Request data": { blurb: "Accessors for params, query, headers, cookies, bodies and uploads, with transform and validate pipelines.", guide: "request-data" },
  "DTOs and validation": { blurb: "Classes as schemas: is.* field decorators that validate bodies, forms and files into typed instances.", guide: "request-data" },
  Responses: { blurb: "Everything a handler can return, and the helpers for status, headers, cookies and streams.", guide: "responses" },
  Errors: { blurb: "YerdError and its ready-made subclasses: throw one to answer with a status, or extend one for errors of your own.", guide: "responses" },
  Rendering: { blurb: "Turn TSX into HTML: the renderer, escaping, raw HTML and <Dynamic> parts of prerendered pages.", guide: "pages-and-layouts" },
  JSX: { blurb: "yerd's JSX runtime and the typed HTML and SVG elements it accepts.", guide: "pages-and-layouts" },
  "Actions and dynamics": { blurb: "Forms that post with or without JavaScript, Regions, the client runtime, custom attributes and prefetch.", guide: "interactivity" },
  Guards: { blurb: "Gates in front of routes and actions: allow, refuse, or answer with something else.", guide: "sessions-and-auth" },
  "Dependency injection": { blurb: "Services with singleton, scoped and transient lifetimes, injection, lifecycle hooks and background work.", guide: "services" },
  Sessions: { blurb: "Sealed cookie or memory sessions: data, flash messages, regeneration and expiry.", guide: "sessions-and-auth" },
  Auth: { blurb: "Session-based sign-in with typed users, roles, guards and password hashing.", guide: "sessions-and-auth" },
  Events: { blurb: "An app-wide bus: emit what happened, react in background handlers, and make typed calls, in one process or across instances.", guide: "services" },
  "Live and streaming": { blurb: "NDJSON and Server-Sent Events, and channels for pushing updates to the right users.", guide: "streaming-and-live" },
  Logging: { blurb: "Structured logs and spans, request ids, filters, sinks and @instrument.", guide: "logging" },
  Assets: { blurb: "Link built CSS and assets through Vite's manifest.", guide: "deploying" },
  "Decorator kit": { blurb: "Build your own accessors and decorators with the same tools yerd's built-ins use." },
  Vite: { blurb: "The Vite plugin: dev server with reloads, production builds and prerendering.", guide: "deploying" },
  Runtime: { blurb: "Runtime support yerd installs for you." },
};

/** Kinds grouped the way the index lists them. */
export const KIND_GROUPS: Array<{ title: string; kinds: string[] }> = [
  { title: "Functions and decorators", kinds: ["function"] },
  { title: "Classes", kinds: ["class"] },
  { title: "Constants", kinds: ["const"] },
  { title: "Interfaces and types", kinds: ["interface", "type", "enum", "other"] },
];
