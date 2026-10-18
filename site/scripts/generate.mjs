// Generates the docs site's data from the repository itself:
//
//   public/data/api.json      every public export of the package's entry points,
//                             with signatures as written, JSDoc, examples, source
//                             links, class/interface members, and the version
//                             each one first shipped in
//   public/data/guides.json   the guides (docs/*.md and the README), by slug
//   public/data/guides/*.md   their text
//   public/data/benchmarks.json
//                             bench/compare/results.json, when the comparison
//                             harness has been run
//
// "Since" versions come from git: for every release tag that's on npm, the
// same walk runs over that tag's src/, and an export (or member) is stamped
// with the first version it appears in. Anything only on main is unreleased.
//
// Run from site/: `node scripts/generate.mjs`. Needs the git history (tags);
// CI checks out with fetch-depth 0.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, "..");
const repo = resolve(site, "..");
const out = join(site, "public", "data");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const REPO_URL = "https://github.com/Toyz/yerd";

/** The package's documented entry points (package.json exports), source side. */
const ENTRIES = [
  { module: "@toyz/yerd", file: "src/index.ts" },
  { module: "@toyz/yerd/auth", file: "src/auth/index.ts" },
  { module: "@toyz/yerd/vite", file: "src/vite/index.ts" },
  { module: "@toyz/yerd/client", file: "src/client/index.ts" },
  { module: "@toyz/yerd/jsx-runtime", file: "src/jsx/jsx-runtime.ts" },
];

/** Sections of the reference, by source file (then by directory). */
const BY_FILE = {
  "src/decorators/route.ts": "Routing",
  "src/decorators/request.ts": "Request data",
  "src/decorators/dto.ts": "DTOs and validation",
  "src/decorators/guards.ts": "Guards",
  "src/decorators/response.ts": "Responses",
  "src/respond/errors.ts": "Errors",
  "src/decorators/kit.ts": "Decorator kit",
  "src/decorators/keys.ts": "Decorator kit",
  "src/assets.ts": "Assets",
  "src/polyfill.ts": "Runtime",
};
const BY_DIR = {
  server: "Server",
  router: "Server",
  di: "Dependency injection",
  render: "Rendering",
  jsx: "JSX",
  respond: "Responses",
  actions: "Actions and dynamics",
  attributes: "Actions and dynamics",
  client: "Actions and dynamics",
  session: "Sessions",
  auth: "Auth",
  live: "Live and streaming",
  events: "Events",
  log: "Logging",
  vite: "Vite",
  seo: "Sitemaps",
};
const SECTION_ORDER = [
  "Server", "Routing", "Request data", "DTOs and validation", "Responses", "Errors", "Rendering", "JSX",
  "Actions and dynamics", "Guards", "Dependency injection", "Events", "Sessions", "Auth", "Live and streaming",
  "Logging", "Assets", "Sitemaps", "Decorator kit", "Vite", "Runtime",
];

function sectionOf(file) {
  if (BY_FILE[file]) return BY_FILE[file];
  const dir = file.split("/")[1];
  return BY_DIR[dir] ?? "Other";
}

// ── the TypeScript program ──

function programFor(root, entries) {
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ["lib.es2023.d.ts", "lib.esnext.decorators.d.ts", "lib.dom.d.ts"],
    jsx: ts.JsxEmit.ReactJSX,
    jsxImportSource: "@toyz/yerd",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ["node"],
    typeRoots: [join(repo, "node_modules", "@types")],
  };
  const files = entries.map((e) => join(root, e.file)).filter((f) => existsSync(f));
  return ts.createProgram(files, options);
}

const PRINT = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

function isHidden(symbol) {
  return (symbol.getDeclarations() ?? []).some((d) => nodeDoc(d).hidden);
}

// The JSDoc tags that mean something here. TypeScript's own parser treats any
// "@word" as a tag, even mid-sentence, so prose like "Promises (like @body's)"
// or a ```ts example full of decorators would cut the description short. We
// read the comment's raw text instead and only split on these, at the start
// of a line and outside code fences.
const KNOWN_TAGS = new Set(["example", "deprecated", "since", "param", "returns", "return", "internal", "hidden", "see", "throws", "default", "remarks", "typeParam", "template"]);

/** Parse one raw JSDoc comment: description, examples, and the tags we use. */
function parseComment(raw) {
  const lines = raw
    .replace(/^\/\*\*\s?/, "")
    .replace(/\s*\*\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, ""));
  const description = [];
  const tags = [];
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const tag = !fence && /^@(\w+)\s?(.*)$/.exec(line);
    if (tag && KNOWN_TAGS.has(tag[1])) tags.push({ name: tag[1], lines: [tag[2]] });
    else if (tags.length) tags[tags.length - 1].lines.push(line);
    else description.push(line);
  }
  // Code blocks in the description are its examples: they go in the page's
  // Examples section (every page lays out the same way); the prose stays.
  const examples = [];
  const prose = [];
  let block;
  for (const line of description) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (block) {
        examples.push(block.join("\n").replace(/^\n+|\s+$/g, ""));
        block = undefined;
      } else block = [];
      continue;
    }
    if (block) block.push(line);
    else prose.push(line);
  }
  if (block) prose.push(...block);
  const text = prose.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  let deprecated;
  let since;
  let hidden = false;
  for (const tag of tags) {
    const body = tag.lines.join("\n").trim();
    if (tag.name === "example") examples.push(body.replace(/^```\w*\n?|\n?```$/g, "").trim());
    else if (tag.name === "deprecated") deprecated = body || "Deprecated.";
    else if (tag.name === "since") since = body.replace(/^v/, "");
    else if (tag.name === "internal" || tag.name === "hidden") hidden = true;
  }
  return { text, examples, deprecated, since, hidden, params: [] };
}

/** The doc comment on a declaration (for a variable, the one on its statement). */
function nodeDoc(node) {
  const docs = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc);
  if (docs.length === 0) return { text: "", examples: [], params: [] };
  return parseComment(docs[docs.length - 1].getText());
}

function docOf(symbol, checker) {
  // The first declaration that has a comment (overloads often document only one).
  for (const decl of symbol.getDeclarations() ?? []) {
    const doc = nodeDoc(decl);
    if (doc.text || doc.examples.length || doc.deprecated || doc.hidden) return doc;
  }
  return { text: ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim(), examples: [], params: [] };
}

/** A declaration's text as the author wrote it, without its body. */
function headerOf(node, source) {
  const text = node.getText(source);
  let body;
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) body = node.body;
  else if (ts.isClassDeclaration(node)) return classHeader(node, source);
  if (!body) return clean(text);
  return clean(text.slice(0, body.getStart(source) - node.getStart(source)).trimEnd());
}

function classHeader(node, source) {
  const text = node.getText(source);
  const brace = node.members.pos - node.getStart(source);
  return clean(text.slice(0, text.lastIndexOf("{", brace + 1)).trimEnd());
}

/** Drop JSDoc, decorators-on-own-lines noise and `export` from printed declarations. */
function clean(text) {
  return text
    .replace(/\/\*\*[\s\S]*?\*\/\s*/g, "")
    .replace(/^export\s+(default\s+)?/, "")
    .replace(/^declare\s+/, "")
    .trim();
}

function kindOf(decl) {
  if (ts.isClassDeclaration(decl)) return "class";
  if (ts.isInterfaceDeclaration(decl)) return "interface";
  if (ts.isTypeAliasDeclaration(decl)) return "type";
  if (ts.isEnumDeclaration(decl)) return "enum";
  if (ts.isFunctionDeclaration(decl)) return "function";
  if (ts.isVariableDeclaration(decl)) return "const";
  return "other";
}

function location(decl, root) {
  const source = decl.getSourceFile();
  const { line } = source.getLineAndCharacterOfPosition(decl.getStart(source));
  return { file: relative(root, source.fileName).split("\\").join("/"), line: line + 1 };
}

function memberKind(m) {
  if (ts.isMethodDeclaration(m) || ts.isMethodSignature(m)) return "method";
  if (ts.isGetAccessor(m) || ts.isSetAccessor(m)) return "accessor";
  if (ts.isConstructorDeclaration(m) || ts.isConstructSignatureDeclaration(m)) return "constructor";
  if (ts.isIndexSignatureDeclaration(m)) return "index";
  return "property";
}

function memberName(m, source) {
  if (ts.isConstructorDeclaration(m) || ts.isConstructSignatureDeclaration(m)) return "constructor";
  if (ts.isIndexSignatureDeclaration(m)) return "[index]";
  if (!m.name) return undefined;
  if (ts.isPrivateIdentifier(m.name)) return undefined;
  return m.name.getText(source);
}

function isPublicMember(m) {
  const mods = ts.canHaveModifiers(m) ? ts.getModifiers(m) ?? [] : [];
  return !mods.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword || x.kind === ts.SyntaxKind.ProtectedKeyword);
}

function membersOf(decl, checker, source, root) {
  if (!ts.isClassDeclaration(decl) && !ts.isInterfaceDeclaration(decl)) return [];
  const members = [];
  const seen = new Map();
  for (const m of decl.members) {
    const name = memberName(m, source);
    if (!name || name.startsWith("_") || !isPublicMember(m)) continue;
    const symbol = m.name ? checker.getSymbolAtLocation(m.name) : undefined;
    if (symbol && isHidden(symbol)) continue;
    const doc = symbol ? docOf(symbol, checker) : nodeDoc(m);
    // Parameter properties: `constructor(readonly status: number)` documents fields too.
    const mods = ts.canHaveModifiers(m) ? ts.getModifiers(m) ?? [] : [];
    const isStatic = mods.some((x) => x.kind === ts.SyntaxKind.StaticKeyword);
    let signature = headerOf(m, source).replace(/^(public\s+)/, "");
    // `handle = async (...) => {...}` class fields: the type, not the function body.
    if (ts.isPropertyDeclaration(m) && m.initializer && (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer))) {
      signature = `${name}: ${checker.typeToString(checker.getTypeAtLocation(m), undefined, PRINT)}`;
    } else if (ts.isPropertyDeclaration(m) && m.initializer) {
      signature = signature.replace(/\s*=[\s\S]*$/, "");
    }
    const entry = {
      name,
      kind: memberKind(m),
      static: isStatic || undefined,
      signature,
      doc: doc.text || undefined,
      examples: doc.examples.length ? doc.examples : undefined,
      deprecated: doc.deprecated,
      sinceOverride: doc.since,
      line: location(m, root).line,
    };
    // Overloads: one entry, every signature.
    const key = `${isStatic ? "static " : ""}${name}`;
    if (seen.has(key)) {
      const prev = seen.get(key);
      if (!ts.isMethodDeclaration(m) || !m.body) prev.overloads = [...(prev.overloads ?? [prev.signature]), signature];
      continue;
    }
    seen.set(key, entry);
    members.push(entry);
  }
  // A method with overloads lists the overload signatures, not the implementation.
  for (const m of members) if (m.overloads) m.signature = m.overloads.filter((s) => !/\{\s*$/.test(s)).join("\n");
  return members;
}

/**
 * An object-shaped constant (`export const is = { string(...), int(...) }`)
 * documents its properties as members rather than as one enormous type.
 */
function objectMembers(symbol, decl, checker, root) {
  if (!ts.isVariableDeclaration(decl)) return undefined;
  const type = checker.getTypeOfSymbolAtLocation(symbol, decl);
  if (type.getCallSignatures().length > 0 || type.isUnion()) return undefined;
  const properties = type.getProperties();
  if (properties.length < 2 || !decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) return undefined;
  return properties.map((prop) => {
    const propDecl = prop.getDeclarations()?.[0];
    const propType = checker.getTypeOfSymbolAtLocation(prop, propDecl ?? decl);
    const callable = propType.getCallSignatures();
    const doc = docOf(prop, checker);
    const signature = callable.length
      ? callable.map((sig) => `${prop.getName()}${checker.signatureToString(sig, propDecl, PRINT)}`).join("\n")
      : `${prop.getName()}: ${checker.typeToString(propType, propDecl, PRINT)}`;
    return {
      name: prop.getName(),
      kind: callable.length ? "method" : "property",
      signature,
      doc: doc.text || undefined,
      examples: doc.examples.length ? doc.examples : undefined,
      deprecated: doc.deprecated,
      sinceOverride: doc.since,
      line: propDecl ? location(propDecl, root).line : undefined,
    };
  });
}

function signatureOf(symbol, decls, checker, source) {
  const first = decls[0];
  if (ts.isFunctionDeclaration(first)) {
    // Overloads, when there are any, are the public signatures; the implementation isn't.
    const overloads = decls.filter((d) => ts.isFunctionDeclaration(d) && !d.body);
    return (overloads.length ? overloads : [first]).map((d) => headerOf(d, d.getSourceFile())).join("\n");
  }
  if (ts.isVariableDeclaration(first)) {
    const list = first.parent;
    const keyword = list && (list.flags & ts.NodeFlags.Const) ? "const" : "let";
    const type = first.type ? first.type.getText(source) : checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, first), first, PRINT);
    return `${keyword} ${symbol.getName()}: ${type}`;
  }
  return decls.map((d) => headerOf(d, d.getSourceFile())).join("\n\n");
}

/** Walk one checkout's entry points. `full`: collect everything; otherwise just the names (for since-stamping). */
function walk(root, full) {
  const program = programFor(root, ENTRIES);
  const checker = program.getTypeChecker();
  const entries = [];
  const keys = new Set();
  for (const { module, file } of ENTRIES) {
    const source = program.getSourceFile(join(root, file));
    if (!source) continue;
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (!moduleSymbol) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const name = exported.getName();
      if (name === "default" || name.startsWith("_")) continue;
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const decls = (symbol.getDeclarations() ?? []).filter((d) => !ts.isSourceFile(d));
      if (decls.length === 0 || isHidden(symbol)) continue;
      // A name that's both a value and a type (`export const ILogger = token<ILogger>()`
      // next to `interface ILogger`) is documented once, by its most descriptive declaration.
      const main = decls.find((d) => ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d)) ?? decls.find((d) => ts.isFunctionDeclaration(d)) ?? decls[0];
      const declSource = main.getSourceFile();
      const key = `${module}:${name}`;
      keys.add(key);
      const objectProps = objectMembers(symbol, main, checker, root);
      const members = objectProps ?? membersOf(main, checker, declSource, root);
      for (const m of members) keys.add(`${key}.${m.static ? "static " : ""}${m.name}`);
      if (!full) continue;
      const doc = docOf(symbol, checker);
      const where = location(main, root);
      entries.push({
        module,
        name,
        kind: kindOf(main),
        section: sectionOf(where.file),
        signature: objectProps
          ? `const ${name}: { ${objectProps.map((p) => p.name).join(", ")} }`
          : signatureOf(symbol, ts.isFunctionDeclaration(main) ? decls.filter(ts.isFunctionDeclaration) : [main], checker, declSource),
        doc: doc.text || undefined,
        examples: doc.examples.length ? doc.examples : undefined,
        deprecated: doc.deprecated,
        sinceOverride: doc.since,
        source: where,
        members: members.length ? members : undefined,
      });
    }
  }
  return { entries, keys };
}

// ── versions ──

function git(...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

async function publishedVersions() {
  try {
    const response = await fetch(`https://registry.npmjs.org/${pkg.name.replace("/", "%2f")}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return undefined;
    const meta = await response.json();
    return new Set(Object.keys(meta.versions ?? {}));
  } catch {
    return undefined;
  }
}

async function releases() {
  const tags = git("tag", "--list", "v*", "--sort=v:refname").split("\n").filter(Boolean);
  const onNpm = await publishedVersions();
  // A tag whose release never reached npm (a failed publish) didn't ship anything.
  return tags.map((tag) => ({ tag, version: tag.slice(1) })).filter((r) => !onNpm || onNpm.has(r.version));
}

function checkout(tag) {
  const dir = mkdtempSync(join(tmpdir(), `yerd-${tag}-`));
  const archive = execFileSync("git", ["archive", "--format=tar", tag, "src"], { cwd: repo, maxBuffer: 256 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", dir], { input: archive });
  return dir;
}

// ── guides ──

// The user guides live in docs/guide/NN-slug.md (ordered by the number); the
// older docs/*.md are design notes, kept for anyone curious about internals.
const DESIGN_NOTES = [
  { slug: "design", file: "docs/PLAN.md", title: "Design and decisions" },
  { slug: "dynamics-design", file: "docs/DYNAMICS.md" },
  { slug: "auth-design", file: "docs/AUTH.md" },
  { slug: "decorators-design", file: "docs/DECORATORS.md" },
  { slug: "logging-design", file: "docs/LOGGING.md" },
  { slug: "build-design", file: "docs/BUILD.md" },
  { slug: "performance", file: "docs/PERF.md" },
  { slug: "releasing", file: "docs/RELEASING.md" },
  { slug: "builder", file: "docs/BUILDER.md" },
  { slug: "spikes", file: "docs/SPIKES.md" },
];

/**
 * The sidebar: guides by group, in reading order, with short titles. A guide
 * file not listed here still shows up, at the end of "Guides", so a new file
 * is never silently missing.
 */
const GUIDE_GROUPS = [
  { group: "Get started", guides: [["getting-started", "Installation"], ["your-first-app", "Your first app"]] },
  { group: "Core concepts", guides: [["routing", "Routing"], ["request-data", "Request data"], ["responses", "Responses"], ["pages-and-layouts", "Pages and layouts"]] },
  { group: "Building apps", guides: [["interactivity", "Interactivity"], ["client-code", "Client code"], ["streaming-and-live", "Streaming and live"], ["services", "Services and DI"], ["events", "Events"], ["sessions-and-auth", "Sessions and auth"]] },
  { group: "Recipes", guides: [["recipes", "Recipes"]] },
  { group: "Production", guides: [["logging", "Logging"], ["deploying", "Deploying"], ["sitemaps", "Sitemaps and robots.txt"], ["testing", "Testing"], ["security", "Security"]] },
];

function guideList() {
  const list = [{ slug: "overview", file: "README.md", title: "Introduction", group: "Get started" }];
  const dir = join(repo, "docs", "guide");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d+-[\w-]+\.md$/.test(f)).sort() : [];
  const bySlug = new Map(files.map((f) => [f.replace(/^\d+-|\.md$/g, ""), f]));
  for (const { group, guides } of GUIDE_GROUPS) {
    for (const [slug, title] of guides) {
      const file = bySlug.get(slug);
      if (!file) continue;
      list.push({ slug, file: `docs/guide/${file}`, title, group });
      bySlug.delete(slug);
    }
  }
  for (const [slug, file] of bySlug) list.push({ slug, file: `docs/guide/${file}`, group: "Production" });
  for (const note of DESIGN_NOTES) list.push({ ...note, group: "Design notes" });
  return list;
}

/** Same as slugify() in src/markdown.ts, so search results land on the heading's anchor. */
function slugify(text) {
  return text.toLowerCase().replace(/<[^>]+>/g, "").replace(/[`*~]/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
}

/** Inline markdown as plain text: link labels only ("[@session](api:yerd.session)" reads "@session"), no code ticks or emphasis. */
function plain(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?!\w)/g, "$1$2");
}

/** A paragraph's first sentence, short enough for a search result. */
function firstSentence(text) {
  const end = text.search(/[.!?:](\s|$)/);
  const sentence = end === -1 ? text : text.slice(0, end + 1);
  return sentence.length > 160 ? `${sentence.slice(0, 157).replace(/\s+\S*$/, "")}...` : sentence;
}

/**
 * A guide's ## and ### headings, for search: their text, anchor ids (numbered
 * like the renderer's) and a one-sentence summary from the section's first
 * paragraph. Fenced blocks (code, `answer`, `diagram`, tabs) are skipped
 * whole, closing only on a fence as long as the one that opened them, the
 * way markdown.ts reads them; callouts, tables and lists aren't summaries.
 */
function sectionsOf(text) {
  const sections = [];
  const used = new Map();
  let fence = "";
  let paragraph;
  const finish = () => {
    const current = sections.at(-1);
    if (current && paragraph?.length && !current.summary) current.summary = firstSentence(plain(paragraph.join(" ")));
    paragraph = undefined;
  };
  for (const line of text.split("\n")) {
    if (fence) {
      if (line.trimStart().startsWith(fence)) fence = "";
      continue;
    }
    const open = /^\s*(```+|~~~+)/.exec(line);
    if (open) {
      finish();
      fence = open[1];
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      finish();
      let id = slugify(heading[2]) || "section";
      const n = used.get(id) ?? 0;
      used.set(id, n + 1);
      if (n > 0) id = `${id}-${n}`;
      if (heading[1].length === 2 || heading[1].length === 3) sections.push({ id, text: plain(heading[2]) });
      continue;
    }
    if (line.trim() === "" || /^\s*(>|\||[-*+]\s|\d+[.)]\s|<)/.test(line) || /^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      finish();
      continue;
    }
    (paragraph ??= []).push(line.trim());
  }
  finish();
  return sections;
}

function writeGuides() {
  mkdirSync(join(out, "guides"), { recursive: true });
  const keep = new Set(guideList().map((g) => `${g.slug}.md`));
  for (const name of readdirSync(join(out, "guides"))) if (!keep.has(name)) rmSync(join(out, "guides", name));
  const index = [];
  for (const guide of guideList()) {
    const path = join(repo, guide.file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.replace(/`/g, "") ?? guide.slug;
    writeFileSync(join(out, "guides", `${guide.slug}.md`), text);
    index.push({ slug: guide.slug, title: guide.title ?? heading, file: guide.file, group: guide.group, sections: sectionsOf(text) });
  }
  writeFileSync(join(out, "guides.json"), JSON.stringify(index, null, 2));
  return index;
}

// ── main ──

const started = performance.now();
// Files are overwritten in place (and stale ones removed one by one) rather
// than deleting the folder: a running Vite dev server keeps a list of public
// files, and removing the whole directory under it makes it serve index.html.
mkdirSync(out, { recursive: true });

const current = walk(repo, true);
const shipped = await releases();
const firstSeen = new Map();
for (const { tag, version } of shipped) {
  const dir = checkout(tag);
  try {
    for (const key of walk(dir, false).keys) if (!firstSeen.has(key)) firstSeen.set(key, version);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let unreleased = 0;
for (const entry of current.entries) {
  const key = `${entry.module}:${entry.name}`;
  entry.since = entry.sinceOverride ?? firstSeen.get(key) ?? null;
  delete entry.sinceOverride;
  if (entry.since === null) unreleased++;
  for (const m of entry.members ?? []) {
    m.since = m.sinceOverride ?? firstSeen.get(`${key}.${m.static ? "static " : ""}${m.name}`) ?? null;
    delete m.sinceOverride;
    // A member newer than its owner is worth a badge; one as old as its owner isn't.
    if (m.since === entry.since) m.since = undefined;
  }
}

// ── companions ──
//
// A type only one other export refers to (OnOptions, used by on() alone) is
// part of that export's story: it's documented on that page, and its own id
// points there. Types several exports share keep their own page.

const shortOf = (module) => (module === pkg.name ? "yerd" : module.slice(pkg.name.length + 1));
const idOf = (entry) => `${shortOf(entry.module)}.${entry.name}`;
for (const child of current.entries) {
  if (child.kind !== "interface" && child.kind !== "type") continue;
  const mention = new RegExp(`(^|[^\\w$.])${child.name.replace(/[$]/g, "\\$&")}(?![\\w$])`);
  // Every export that mentions it, types included: one another type also uses is shared vocabulary.
  const referrers = current.entries.filter(
    (other) => other !== child && (mention.test(other.signature) || (other.members ?? []).some((m) => mention.test(m.signature))),
  );
  if (referrers.length !== 1) continue;
  const parent = referrers[0];
  if (parent.kind !== "function" && parent.kind !== "class" && parent.kind !== "const") continue;
  // Kept where people look for it: SessionOptions stays in Sessions, not on YerdApp's page.
  if (parent.section !== child.section) continue;
  child.partOf = idOf(parent);
  (parent.parts ??= []).push(child.name);
}
if (process.env.SHOW_COMPANIONS) {
  for (const e of current.entries) if (e.parts) console.log(`${idOf(e)}: ${e.parts.join(", ")}`);
}

current.entries.sort((a, b) => {
  const s = SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section);
  return s !== 0 ? s : a.name.localeCompare(b.name);
});

let commit = "unknown";
try {
  commit = git("rev-parse", "--short", "HEAD");
} catch {
  // not a git checkout
}

const api = {
  package: pkg.name,
  version: pkg.version,
  released: shipped.map((r) => r.version),
  latest: shipped.at(-1)?.version ?? null,
  commit,
  repo: REPO_URL,
  generated: new Date().toISOString(),
  sections: SECTION_ORDER.filter((s) => current.entries.some((e) => e.section === s)),
  entries: current.entries,
};
writeFileSync(join(out, "api.json"), JSON.stringify(api));
const guides = writeGuides();

// ── benchmarks ──
//
// The comparison harness (bench/compare/) writes results.json; the site shows
// it when it's there and says "not run yet" when it isn't. A stale copy from
// an earlier run is removed so the page never shows numbers the repo lost.
const benchSource = join(repo, "bench", "compare", "results.json");
const benchTarget = join(out, "benchmarks.json");
let bench = "no benchmark results";
if (existsSync(benchSource)) {
  const results = JSON.parse(readFileSync(benchSource, "utf8"));
  if (!Array.isArray(results.scenarios)) throw new Error(`${relative(repo, benchSource)}: no "scenarios" array`);
  writeFileSync(benchTarget, JSON.stringify(results));
  bench = `benchmarks from ${results.generated ?? "an undated run"}`;
} else if (existsSync(benchTarget)) {
  rmSync(benchTarget);
}

console.log(
  `[site] ${current.entries.length} exports (${unreleased} unreleased) across ${api.sections.length} sections, ` +
    `since-stamped from ${shipped.length} release(s) [${api.released.join(", ")}], ${guides.length} guides, ${bench}, ` +
    `${Math.round(performance.now() - started)}ms`,
);
