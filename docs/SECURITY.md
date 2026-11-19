# Security

## Reporting a vulnerability

Report vulnerabilities privately with GitHub's [**Report a vulnerability**](https://github.com/thomasfosterau/effect-parse/security/advisories/new) button, not in a public issue. Include a description, reproduction steps and the affected version; expect a first response within a few days.

Parsers run on untrusted input by design, so a parser that hangs, overflows the stack or uses memory out of proportion to its input is in scope, as is any way for input to reach the code the JIT compiler generates (it builds parsers with `new Function` from the parser's description, never from input).

## Supply chain

- Published with npm trusted publishing (no long-lived token) from a protected `release` environment that needs manual approval; only that job holds `id-token: write`, and it runs no dependency code: it publishes a tarball built and checksummed by a separate job with a read-only token. See [PUBLISHING.md](PUBLISHING.md).
- Workflows default to `permissions: {}` and never persist checkout credentials; actions are pinned to release tags whose commits `.github/workflows/actions.lock` records.
- Installs use the committed lockfile; `minimumReleaseAge` and Dependabot both hold new versions for a day, and CI runs `pnpm audit --audit-level high`.
- The published package has no runtime dependencies; `effect` is a peer.
