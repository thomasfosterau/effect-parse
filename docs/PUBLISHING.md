# Publishing

`@thomasfosterau/effect-parse` is released with [Changesets](https://github.com/changesets/changesets) and published to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC); there is no `NPM_TOKEN`.

## Flow

1. Each change that needs one carries a changeset (see [CONTRIBUTING.md](CONTRIBUTING.md#changesets)).
2. On `trunk`, the [Release workflow](../.github/workflows/release.yml) opens or updates the `chore: version packages` PR (the `changeset:version` task; `"format": false` in `.changeset/config.json` because Changesets would otherwise run an `oxfmt` shim that fails outside an editor).
3. Merging it triggers `build` (read-only token, no `id-token`): it installs without scripts and runs the `release:pack` task, which builds `dist/`, runs the dist guard and packs the tarball with `vp pm pack` (pnpm, which replaces `catalog:peers` with the published range). The `publish` job, in the protected `release` environment, waits for approval, checks the tarball's SHA-256, runs `vp pm publish` on it (pnpm does the OIDC exchange and adds provenance) and creates the `v<version>` tag and GitHub release through the API. A version already on npm (`vp pm view`, run outside the checkout because the root `devEngines.runtime: "lts"` makes it fail inside) is skipped. There is no publish script, and the release path calls neither `npm` nor `pnpm` directly.

`vp run release:dry-run` runs the dist guard and shows what `vp pm publish` would publish, without publishing or tagging.

The `publish` job holds `id-token: write`, so it checks out only `package.json` and `pnpm-workspace.yaml` (to resolve the pinned Vite+ and pnpm), installs no dependencies and restores no cache; all dependency code runs in `build`. Don't pass `--provenance`: pnpm adds provenance itself under trusted publishing from a public repository.

## One-time setup (owner)

- **Settings → Actions → General**: allow GitHub Actions to create and approve pull requests.
- **Settings → Environments → `release`**: a required reviewer; deployments limited to `trunk`.
- **npmjs.com → package → Settings → Trusted publishing**: GitHub Actions, `thomasfosterau/effect-parse`, workflow `release.yml`, environment `release`; require 2FA and disallow tokens.
- **Rulesets on `trunk`**: require pull requests and the `ci (node lts)` and `ci (node latest)` checks.

A trusted publisher can only be attached to a package that exists. A publish by hand (a first version, or recovery) runs from a clean `trunk` as the owner: `vp install --frozen-lockfile`, `vp run release:dry-run`, then `vp run release` (`vp pm publish -r`, which skips a version npm already has, then `changeset git-tag`), then `git push origin --tags`.
