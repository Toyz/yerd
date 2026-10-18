/**
 * The generated data (scripts/generate.mjs writes public/data/), loaded once
 * and shared by every page.
 */

import type { LinkContext } from "./markdown";

export interface Member {
  name: string;
  kind: "method" | "property" | "accessor" | "constructor" | "index";
  static?: boolean;
  signature: string;
  doc?: string;
  examples?: string[];
  deprecated?: string;
  /** Absent: as old as its owner. null: not in any release yet. */
  since?: string | null;
  line?: number;
}

export interface Entry {
  module: string;
  name: string;
  kind: "class" | "interface" | "type" | "enum" | "function" | "const" | "other";
  section: string;
  signature: string;
  doc?: string;
  examples?: string[];
  deprecated?: string;
  /** The first release it shipped in; null: only on main so far. */
  since: string | null;
  source: { file: string; line: number };
  members?: Member[];
  /** A type only this other export uses (its id): documented on that export's page. */
  partOf?: string;
  /** The types documented on this page (see partOf). */
  parts?: string[];
}

export interface Api {
  package: string;
  version: string;
  released: string[];
  latest: string | null;
  commit: string;
  repo: string;
  generated: string;
  sections: string[];
  entries: Entry[];
}

export interface GuideInfo {
  slug: string;
  title: string;
  file: string;
  group: string;
  /** Its ## and ### headings, for search, with the first sentence under each. */
  sections?: Array<{ id: string; text: string; summary?: string }>;
}

const base = import.meta.env.BASE_URL;

async function json<T>(path: string): Promise<T> {
  const response = await fetch(`${base}data/${path}`);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

let api: Promise<Api> | undefined;
let guides: Promise<GuideInfo[]> | undefined;
const guideText = new Map<string, Promise<string>>();

export const loadApi = () => (api ??= json<Api>("api.json"));
export const loadGuides = () => (guides ??= json<GuideInfo[]>("guides.json"));

export function loadGuide(slug: string): Promise<string> {
  let text = guideText.get(slug);
  if (!text) {
    text = fetch(`${base}data/guides/${encodeURIComponent(slug)}.md`).then((r) => {
      if (!r.ok) throw new Error(`No guide "${slug}"`);
      return r.text();
    });
    guideText.set(slug, text);
  }
  return text;
}

// ── benchmarks ──

export interface BenchResult {
  framework: string;
  reqPerSec: number;
  latencyP50: number;
  latencyP99: number;
  throughputMBs: number;
  errors: number;
}

export interface Benchmarks {
  generated: string;
  machine: { cpu: string; cores: number; memory: string; os: string; node: string };
  tool: { name: string; connections: number; duration: number; pipelining: number; runs: number; warmup: number };
  frameworks: Array<{ id: string; name: string; version: string; url?: string }>;
  scenarios: Array<{ id: string; title: string; description?: string; results: BenchResult[] }>;
  notes?: string[];
}

/** What the benchmarks page shows: the results, whether they're the dev sample, or nothing yet. */
export interface BenchState {
  data: Benchmarks | null;
  sample: boolean;
}

async function benchFile(name: string): Promise<Benchmarks | null> {
  try {
    const response = await fetch(`${base}data/${name}`);
    if (!response.ok) return null;
    // A dev server answers a missing file with index.html; only JSON counts.
    const data = (await response.json()) as Benchmarks;
    return Array.isArray(data?.scenarios) ? data : null;
  } catch {
    return null;
  }
}

let benchmarks: Promise<BenchState> | undefined;

/**
 * bench/compare/results.json, copied in by the generator when the harness has
 * run. In development only, a sample stands in so the page can be worked on;
 * a production build never looks for it.
 */
export const loadBenchmarks = () =>
  (benchmarks ??= (async () => {
    const real = await benchFile("benchmarks.json");
    if (real) return { data: real, sample: false };
    if (import.meta.env.DEV) {
      const sample = await benchFile("benchmarks.sample.json");
      if (sample) return { data: sample, sample: true };
    }
    return { data: null, sample: false };
  })());

/** `@toyz/yerd/auth` -> `auth`, `@toyz/yerd` -> `yerd`: the short module name used in ids. */
export function moduleShort(module: string): string {
  return module === "@toyz/yerd" ? "yerd" : module.slice("@toyz/yerd/".length);
}

/** An entry's id in URLs: `yerd.res`, `auth.createAuth`. */
export function entryId(entry: Pick<Entry, "module" | "name">): string {
  return `${moduleShort(entry.module)}.${entry.name}`;
}

export function sourceUrl(api: Api, file: string, line?: number): string {
  return `${api.repo}/blob/main/${file}${line ? `#L${line}` : ""}`;
}

export function sectionId(section: string): string {
  return section.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

const indexes = new WeakMap<Api, Map<string, Entry>>();

/**
 * The API page for a name: `res` -> "yerd.res", `ActionForm.parse` ->
 * "yerd.ActionForm/parse". The main entry point wins when a name exists in
 * two modules.
 */
export function resolveApi(api: Api, name: string): string | undefined {
  let index = indexes.get(api);
  if (!index) {
    index = new Map();
    for (const entry of api.entries) if (!index.has(entry.name) || entry.module === "@toyz/yerd") index.set(entry.name, entry);
    indexes.set(api, index);
  }
  const [owner, member] = name.split(".");
  const entry = index.get(owner!);
  if (!entry) return undefined;
  if (!member) return entryId(entry);
  return entry.members?.some((m) => m.name === member) ? `${entryId(entry)}/${member}` : entryId(entry);
}

/** The entry an API id ("yerd.ActionForm/parse") points at, and the member if any. */
export function lookupApi(api: Api, id: string): { entry: Entry; member?: Member } | undefined {
  const [entryPart, memberName] = id.split("/");
  const entry = api.entries.find((e) => entryId(e) === entryPart);
  if (!entry) return undefined;
  return { entry, member: memberName ? entry.members?.find((m) => m.name === memberName) : undefined };
}

/** How markdown in guides and JSDoc resolves its links. `self`: the API page being rendered. */
export function linkContext(api: Api, guideList: GuideInfo[], slug?: string, self?: string): LinkContext {
  return {
    slug,
    self,
    resolveApi: (name) => resolveApi(api, name),
    repoUrl: api.repo,
    // "02-routing.md", "docs/DYNAMICS.md", "DYNAMICS.md": by path, then by file name.
    guideFor: (file) => {
      const name = file.split("/").pop()!;
      return (guideList.find((g) => g.file === file) ?? guideList.find((g) => g.file.split("/").pop() === name))?.slug;
    },
  };
}
