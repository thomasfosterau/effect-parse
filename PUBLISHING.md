# Publishing & releases

`@thomasfosterau/effect-parse` is released with [Changesets](https://github.com/changesets/changesets) and published to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC). There is no `NPM_TOKEN`.

## The release flow

1. **Add a changeset with your change.** Run `pnpm changeset`, pick the bump (`patch` / `minor` / `major`) and write a user-facing summary, then commit the generated file with the change. Changes to behaviour, types or doc comments (they reach the emitted `.d.ts`) take a changeset; README, docs, CI and tooling changes need none. While the package is `0.x`, a breaking change is a `minor`.
2. **Merge to `main`.** The [Release workflow](.github/workflows/release.yml) opens or updates a **`chore: version packages`** PR that bumps `package.json` and rolls the pending changesets into `CHANGELOG.md`.
3. **Merge the version PR.** With no changesets left, the workflow waits for approval on the `release` environment, then runs [`scripts/release.sh`](scripts/release.sh): it packs the built `dist/` with `pnpm pack`, publishes the tarball with `npm publish` (which performs the OIDC exchange), and runs `changeset tag` so the action pushes the `v<version>` tag and creates the GitHub release.

Never version or publish by hand once the bootstrap below is done.

**No scripts in the release job.** The job holds `id-token: write`, so it installs with `--ignore-scripts`, packs with `--config.ignore-scripts=true`, and publishes a tarball (which runs no lifecycle script). `release.sh` skips a version that is already on npm, so a re-run after a partial publish does not fail.

**Provenance.** Nothing requests [provenance](https://docs.npmjs.com/generating-provenance-statements) explicitly. Under trusted publishing npm attaches it by itself when the repository is public; an explicit `--provenance` from a private repository fails the publish, so do not add one.

**npm version.** OIDC publishing needs npm >= 11.5.1; the job installs an exact version (`npm@11.20.0`). Bump it by hand.

## One-time setup

1. **Rename the repository** to `thomasfosterau/effect-parse` (**Settings → General → Repository name**). The Release workflow only runs under that name (`if: github.repository == 'thomasfosterau/effect-parse'`), and the trusted publisher below is bound to it. GitHub redirects the old URL, but update local remotes: `git remote set-url origin https://github.com/thomasfosterau/effect-parse`.
2. **Allow Actions to open the version PR.** **Settings → Actions → General → Workflow permissions** → enable **Allow GitHub Actions to create and approve pull requests**.
3. **Create the `release` environment.** **Settings → Environments → New environment → `release`**: add yourself as a **required reviewer** and restrict deployments to `main`.
4. **Bootstrap the first version.** A trusted publisher can only be configured on a package that already exists, so `0.1.0` is published by hand once. After steps 1–3, merging any change to `main` makes the Release workflow open the `chore: version packages` PR (0.0.0 → 0.1.0). Before merging it, from a machine logged in to npm with publish rights on the `@thomasfosterau` scope:

   ```sh
   git fetch origin && git checkout changeset-release/main
   pnpm install --frozen-lockfile
   pnpm build && pnpm check:dist
   pnpm pack --pack-destination .release
   npm publish .release/thomasfosterau-effect-parse-0.1.0.tgz --access public
   ```

   Then do step 5 and merge the version PR: `release.sh` finds `0.1.0` already on npm, skips the publish and only tags the release.

5. **Configure the trusted publisher.** On npmjs.com, open the package → **Settings → Trusted publishing** → **GitHub Actions**:
   - Organization or user: `thomasfosterau`
   - Repository: `effect-parse`
   - Workflow filename: `release.yml`
   - Environment: `release`

   Then, under **Publishing access**, choose **Require two-factor authentication and disallow tokens**, and revoke any token used for the bootstrap.

6. **Protect `main`.** Require pull requests and the `CI` check before merging, so a release can only come from merging the reviewed version PR.
