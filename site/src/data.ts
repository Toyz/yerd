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
  group: "Start" | "Guides" | "Design notes";
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

/** How markdown in guides and JSDoc resolves its links. */
export function linkContext(api: Api, guideList: GuideInfo[], slug?: string): LinkContext {
  return {
    slug,
    repoUrl: api.repo,
    // "02-routing.md", "docs/DYNAMICS.md", "DYNAMICS.md": by path, then by file name.
    guideFor: (file) => {
      const name = file.split("/").pop()!;
      return (guideList.find((g) => g.file === file) ?? guideList.find((g) => g.file.split("/").pop() === name))?.slug;
    },
  };
}
