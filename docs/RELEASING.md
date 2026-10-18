# Releasing

Releases go to npm from GitHub Actions (`.github/workflows/release.yml`)
with npm trusted publishing: GitHub's OIDC token proves which repository and
workflow is publishing, so no npm token is stored anywhere, and every version
gets a provenance attestation.

## Every release

```sh
npm version patch        # or minor / major: bumps package.json, commits, tags vX.Y.Z
git push --follow-tags   # the tag runs the release workflow
```

The workflow checks the tag matches `package.json`, runs the typecheck,
build, unit and e2e tests, then `npm publish --access public`.

## One-time setup (done once per package)

npm only accepts trusted publishing for a package that already exists, so the
very first version is published by hand:

1. `npm login` (as the `toyz` npm account), then from a clean checkout of the
   release commit: `npm ci && npm run build && npm publish --access public`.
2. On npmjs.com, open the package, then Settings -> Trusted publisher -> GitHub
   Actions, and fill in: owner `Toyz`, repository `yerd`, workflow
   `release.yml` (no environment).
3. Still in Settings -> Publishing access, choose "Require two-factor
   authentication and disallow tokens". From then on, CI with OIDC is the
   only way to publish.

`repository.url` in package.json must match the GitHub repository
(`git+https://github.com/Toyz/yerd.git`) or npm refuses the OIDC publish.
