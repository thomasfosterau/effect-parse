# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately via GitHub's [**Report a vulnerability**](https://github.com/thomasfosterau/effect-parse/security/advisories/new) button (Security → Advisories), **not** through public issues.

You can expect an initial response within a few days. Please include a description, reproduction steps, and the affected version.

Parsers run on untrusted input by design, so reports of a parser that hangs, overflows the stack, or uses memory out of proportion to its input are in scope, as is any way for input to reach code the JIT compiler generates (it builds parsers with `new Function` from the parser's description, never from input).

## Supply-chain hardening

The package is published with a hardened, automated pipeline designed to resist supply-chain attacks (e.g. self-propagating npm worms that steal credentials and publish trojanized versions):

- **No long-lived npm token.** Releases use npm [**OIDC Trusted Publishing**](https://docs.npmjs.com/trusted-publishers): GitHub Actions proves its identity to npm with a short-lived, workflow-bound OIDC token. There is no `NPM_TOKEN` secret to steal from CI.
- **Provenance.** Once the repository is public, every version the release workflow publishes carries [npm provenance](https://docs.npmjs.com/generating-provenance-statements), linking the artifact to the exact source commit and workflow. npm attaches it by itself under trusted publishing; nothing requests it explicitly.
- **No dependency code next to the publishing credential.** The job that holds `id-token: write` checks out nothing, installs nothing and restores no cache: it downloads a tarball, checks its SHA-256 and runs `npm publish` on it (which runs no lifecycle script), with an npm CLI pinned to an exact version and installed without scripts. The tarball is built by a separate job with a read-only token and no OIDC token; that job installs with `pnpm install --frozen-lockfile --ignore-scripts` (and pnpm 11's `verify-deps-before-run` off, so a later `pnpm run` cannot re-install with scripts), runs the same dist guard as CI on the build it packs, and is the only place dependency code (the bundler, the lint presets `vite.config.ts` imports) executes. A compromised (transitive) dev dependency therefore has no token to steal.
- **Pinned actions.** All GitHub Actions are pinned to full commit SHAs, so a hijacked tag cannot inject workflow code.
- **Least privilege.** Workflows default to `permissions: {}`; each job opts into only the scopes it needs. CI checks out with `persist-credentials: false`.
- **Manual approval gate.** Publishing runs in a protected `release` environment that requires manual approval. The Release workflow separates versioning, building and publishing: only its `publish` job runs in that environment and holds `id-token: write`, so refreshing the version PR and building the tarball need no approval and cannot publish.
- **Locked dependencies with a cooling-off period.** Installs use `pnpm install --frozen-lockfile` against the committed `pnpm-lock.yaml`; `minimumReleaseAge` holds newly published third-party versions for 8 hours before pnpm will install them; Dependabot proposes updates for review after a 1-day cooldown (its smallest unit, so never sooner than pnpm accepts), and CI runs `pnpm audit --audit-level high`.
- **No runtime dependencies.** The published package has none; `effect` is a peer the consumer provides.

## Release pipeline

The publishing pipeline and its one-time maintainer setup are documented in [PUBLISHING.md](PUBLISHING.md).
