# Publishing

`@thomasfosterau/effect-parse` is released with [Changesets](https://github.com/changesets/changesets) and published to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC); there is no `NPM_TOKEN`.

## Flow

1. Each change that needs one carries a changeset (see [CONTRIBUTING.md](CONTRIBUTING.md#changesets)).
2. On `trunk`, the [Release workflow](../.github/workflows/release.yml) opens or updates the `chore: version packages` PR (the `changeset:version` task; `"format": false` in `.changeset/config.json` because Changesets would otherwise run an `oxfmt` shim that fails outside an editor).
3. Merging it triggers `build` (read-only token, no `id-token`): it installs without scripts, builds `dist/`, runs the dist guard and packs the tarball with `pnpm pack` (which replaces `catalog:peers` with the published range). The `publish` job, in the protected `release` environment, waits for approval, checks the tarball's SHA-256, runs `npm publish` on it and creates the `v<version>` tag and GitHub release through the API. A version already on npm is skipped.

The `publish` job holds `id-token: write`, so it checks out nothing, installs nothing and restores no cache; all dependency code runs in `build`. Don't pass `--provenance`: npm adds provenance itself under trusted publishing once the repository is public, and requesting it from a private repository fails. OIDC needs npm ≥ 11.5.1, pinned in `release.yml`.

## One-time setup (owner)

- **Settings → Actions → General**: allow GitHub Actions to create and approve pull requests.
- **Settings → Environments → `release`**: a required reviewer; deployments limited to `trunk`.
- **npmjs.com → package → Settings → Trusted publishing**: GitHub Actions, `thomasfosterau/effect-parse`, workflow `release.yml`, environment `release`; require 2FA and disallow tokens.
- **Rulesets on `trunk`**: require pull requests and the `ci (node lts)` and `ci (node latest)` checks.
