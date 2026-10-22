# Publishing & releases

`@thomasfosterau/effect-parse` is released with [Changesets](https://github.com/changesets/changesets) and published to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC). There is no `NPM_TOKEN`. See [SECURITY.md](SECURITY.md) for the rationale behind the pipeline.

## The release flow

1. **Add a changeset with your change.** Run `pnpm changeset`, pick the bump (`patch` / `minor` / `major`) and write a user-facing summary, then commit the generated file with the change. Which changes need one is set out in [AGENTS.md](AGENTS.md#branches-and-pull-requests); a doc-comment change reaches the emitted `.d.ts` and takes a `patch`. While the package is `0.x`, a breaking change is a `minor`.
2. **Merge to `trunk`.** The [Release workflow](.github/workflows/release.yml) opens or updates a **`chore: version packages`** PR that bumps `package.json` and rolls the pending changesets into `CHANGELOG.md`. The version step is `changeset version && vp fmt && pnpm install --lockfile-only`, with `"format": false` in `.changeset/config.json`: Changesets 3 would otherwise run the `oxfmt` binary Vite+ installs (an IDE-only shim that exits 1 outside LSP mode) on the changelog.
3. **Merge the version PR.** With no changesets left, the workflow waits for approval on the `release` environment, builds `dist/` and runs [`scripts/release.sh`](scripts/release.sh): it packs the package with `pnpm pack` (which replaces `catalog:peers` with the published peer range), publishes the tarball with `npm publish` (which performs the OIDC exchange), and runs `changeset tag` so the action pushes the `v<version>` tag and creates the GitHub release.

Never version or publish by hand.

**No scripts in the release job.** The job holds `id-token: write`, so it installs with `--ignore-scripts` (with pnpm's `verify-deps-before-run` off, so no later `pnpm run` re-installs with scripts), packs with `--config.ignore-scripts=true`, and publishes a tarball (which runs no lifecycle script). `release.sh` skips a version that is already on npm, so a re-run after a partial publish does not fail.

**Provenance.** Nothing requests [provenance](https://docs.npmjs.com/generating-provenance-statements) explicitly. Under trusted publishing npm attaches it by itself when the repository is public; an explicit `--provenance` from a private repository fails the publish, so do not add one.

**npm version.** OIDC publishing needs npm >= 11.5.1; the job installs an exact version (`npm@11.20.0`). Bump it by hand.

## One-time setup

`0.1.0` is already on npm, so the bootstrap is done. What the owner keeps configured:

1. **Default branch `trunk`.** **Settings → General → Default branch**: rename `main` to `trunk` (GitHub keeps the history and retargets open PRs). CI, the Release workflow, Dependabot, Changesets (`baseBranch`) and the fallow gate all expect `trunk`. Update local clones afterwards: `git fetch origin && git branch -m main trunk && git branch -u origin/trunk trunk && git remote set-head origin -a`.
2. **Allow Actions to open the version PR.** **Settings → Actions → General → Workflow permissions** → enable **Allow GitHub Actions to create and approve pull requests**.
3. **The `release` environment.** **Settings → Environments → `release`**: a **required reviewer** (yourself), deployments restricted to `trunk`.
4. **The trusted publisher.** On npmjs.com, the package → **Settings → Trusted publishing** → **GitHub Actions**: organization or user `thomasfosterau`, repository `effect-parse`, workflow filename `release.yml`, environment `release`. Under **Publishing access**, choose **Require two-factor authentication and disallow tokens**.
5. **Protect `trunk`.** Require pull requests and the `CI` check before merging, so a release can only come from merging the reviewed version PR.
