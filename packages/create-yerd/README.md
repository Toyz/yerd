# create-yerd

Scaffold a [yerd](https://toyz.github.io/yerd/) app.

```sh
npm create yerd@latest my-app
pnpm create yerd my-app
yarn create yerd my-app
bun create yerd my-app
```

It asks for anything the flags leave out: the directory, a template,
Tailwind, the package manager, git, and whether to install. Then it prints
what to run next. Node 24.7 or newer; no dependencies.

## Templates

| Template | What you get |
| --- | --- |
| `full` | A small shop: a catalog with search, product pages with a 404, a session cart updated by actions that answer with `<Region>`s, sign-in with `createAuth`, a validated checkout form, a JSON API, a health check. Unit tests with `app.request()` / `app.client()` and one Playwright test. |
| `minimal` | One page and a layout, a session counter updated by an action, a stylesheet, a test. |
| `api` | JSON routes for notes: DTO-validated bodies, `NotFound` / `Conflict` errors, `@status(HttpStatus.Created)`, `HttpStatus.NoContent` for deletes. No pages, no client runtime. Tests. |

Every template runs with Vite in dev (`vite`) and builds to a plain Node
server (`vite build`, then `node dist/server/server.js`), with
`tsconfig.json` set up for TC39 decorators and yerd's JSX, vitest, and a
`.env.example` for `YERD_SECRET`.

`--tailwind` adds Tailwind CSS v4 to `full` or `minimal`: `@tailwindcss/vite`
in `vite.config.ts` and a stylesheet that starts with `@import "tailwindcss"`,
linked with `<Stylesheet>` like any other.

## Options

| Flag | Meaning |
| --- | --- |
| `[directory]` | where to create the app; `.` for the current folder |
| `-t, --template <name>` | `full`, `minimal` or `api` |
| `--tailwind`, `--no-tailwind` | add Tailwind CSS (`full` and `minimal` only) |
| `--pm <name>` | `npm`, `pnpm`, `yarn` or `bun`; default: the one running create-yerd |
| `--git`, `--no-git` | `git init` and a first commit (default: yes; skipped inside a repository) |
| `--install`, `--no-install` | install dependencies (default: yes) |
| `-y, --yes` | take the defaults for everything not given: `yerd-app`, `minimal`, no Tailwind, git, install |
| `-f, --force` | write into a directory that isn't empty, overwriting files with the same names |
| `-h, --help` | show the options |
| `-v, --version` | show the version |

With npm, flags go after `--`:

```sh
npm create yerd@latest my-app -- --template full --tailwind
pnpm create yerd my-api --template api --yes
npm create yerd@latest . -- --yes --no-install
```

Without a terminal (a pipe, CI), each question is one line on stdin, and
every question takes its default once input runs out. `NO_COLOR` turns off
colors.

## Versions

create-yerd is released together with yerd, at the same version:
`create-yerd@X.Y.Z` writes `"@toyz/yerd": "^X.Y.Z"`.

## Working on it

From the repository root:

```sh
npm ci && npm run build                                # the integration test installs this build
npm test --prefix packages/create-yerd                  # unit tests
npm run test:integration --prefix packages/create-yerd  # every template: install, tsc, test, build, serve
npm run check --prefix packages/create-yerd             # type-check the JS
```

Templates live in `templates/`: `_shared` goes into every app, then the
template's folder, then for Tailwind `tailwind/_shared` and
`tailwind/<template>`; later files replace earlier ones. `{{name}}`,
`{{run_dev}}` and the other placeholders in `src/render.js` are filled in,
and `_gitignore` becomes `.gitignore`. `package.json` is written by
`src/render.js`.

## License

MIT
