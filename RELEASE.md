# Release

Keep **git tag**, **`package.json` version**, and **npm** on the same number.
Do not publish from a dirty tree or from a version that already exists on npm.

## One-time setup

Repo secret **`NPM_TOKEN`**: a Granular npm token with publish + bypass 2FA
(Settings → Secrets and variables → Actions).

Without this secret, pushing a `v*` tag still fails the Release workflow.
You can publish by hand instead (step 5).

## Every release

1. On `main`, bump `"version"` in `package.json` (semver). Open a PR. Merge it.
2. Local, fast-forward `main`:

   ```bash
   git checkout main && git pull --ff-only
   node -p "require('./package.json').version"
   ```

3. Signed tag, same number as `package.json` (example `0.5.0`):

   ```bash
   git tag -s v0.5.0 -m "v0.5.0"
   git push origin v0.5.0
   ```

4. GitHub Release notes:

   ```bash
   gh release create v0.5.0 --title "v0.5.0" --notes-file -
   ```

5. npm:
   - If `NPM_TOKEN` is set, the **Release** workflow publishes when the tag is pushed.
   - Otherwise, from a clean `main` at that tag:

     ```bash
     pnpm publish --registry https://registry.npmjs.org --access public
     ```

     Use the official registry even if install uses npmmirror.

6. Check:

   ```bash
   npm view @tomnio/rubric version --registry https://registry.npmjs.org
   ```

## Semver

- Patch (`0.4.1`): bugfix, docs that affect usage.
- Minor (`0.5.0`): new extract API / mode / hook, backward compatible.
- Major (`1.0.0`): breaking public API.

Do not reuse a version that already failed or succeeded on npm; bump and tag again.
