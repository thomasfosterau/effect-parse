#!/usr/bin/env bash
#
# Publish the package: the `publish-script` the Release workflow hands to
# changesets/action once the "chore: version packages" PR has merged (see
# PUBLISHING.md). The workflow builds `dist/` before this runs.
#
# `pnpm pack` builds the tarball; `npm publish` of the tarball performs the
# OIDC exchange with npm (the Release job pins npm >= 11.5.1). No
# `--provenance`: an explicit request fails the publish from a private
# repository, and npm adds provenance by itself once the repository is public.
# Idempotent: a version already on npm is skipped, so a re-run after a partial
# publish, or a version bootstrapped by hand, does not fail.
set -euo pipefail

name="$(node -p "require('./package.json').name")"
version="$(node -p "require('./package.json').version")"

if pnpm view "$name@$version" version >/dev/null 2>&1; then
  echo "skip: $name@$version is already published"
else
  out="$PWD/.release"
  rm -rf "$out"
  mkdir -p "$out"
  # No lifecycle scripts in the id-token job (`pnpm pack` has no
  # `--ignore-scripts` flag, so the setting is passed as config).
  pnpm pack --config.ignore-scripts=true --pack-destination "$out"
  # A tarball spec runs no lifecycle scripts under `npm publish`.
  npm publish "$out"/*.tgz --access public
fi

# Prints the `New tag:` line the Changesets action reads to push the tag and
# create the GitHub release.
pnpm exec changeset tag
