# Contributing

Maintained by Thomas Foster, with a workflow meant to be approachable for both humans and coding agents. Conventions are in [AGENTS.md](AGENTS.md).

## Setup

Node 22 or later and pnpm 11 (the version `packageManager` pins; `corepack enable` or a global pnpm 11 picks it up). Then:

```sh
pnpm install
```

That installs the dependencies against the lockfile, the git hooks, and patches the native `tsc` / `oxlint` with `@effect/tsgo` (the `prepare` script). Everything else runs through `vp`, from `node_modules/.bin` (`pnpm exec vp …`, or put `node_modules/.bin` on your `PATH`).

## Branches

Branch off `trunk`, rebase rather than merge, squash-merge with a conventional prefix: see [AGENTS.md](AGENTS.md#branches-and-pull-requests).

## Git hooks

Hooks are managed by Vite+; the editable [.vite-hooks/pre-commit](.vite-hooks/pre-commit) is committed. **pre-commit** runs `vp staged` (format + lint on staged files). There is no pre-push hook.

## CI expectations

[ci.yml](.github/workflows/ci.yml) runs one required job, `ci`, whose steps are the gate list in [AGENTS.md](AGENTS.md#verification). [release.yml](.github/workflows/release.yml) runs changesets/action on `trunk`: it opens the version PR while unreleased changesets exist and publishes once it merges, via npm OIDC trusted publishing (see [PUBLISHING.md](PUBLISHING.md)). Dependabot proposes updates weekly, with the lockstep sets (the Vite+ / TypeScript / tsgo toolchain, the Effect packages) grouped so they move together.

## Pre-PR checklist

1. The gates in [AGENTS.md](AGENTS.md#verification), each with its final pass/fail.
2. For a change to a parser hot path or a compiler: `vp run bench` (and the benchmark for the area) before and after, with the numbers.
3. A changeset (`pnpm changeset`) where [AGENTS.md](AGENTS.md#branches-and-pull-requests) requires one.
4. `git fetch origin trunk && git rebase origin/trunk`
5. Docs: `README.md` (and `test/readme.test.ts`) for any exported change; `docs/DESIGN.md` for a design decision.

## Running individual checks

```sh
vp lint                              # oxlint
vp fmt                               # oxfmt
vp check                             # both
vp run check                         # the type gate
vp test run test/Parser.test.ts      # one test file
vp test run -t "dispatch"            # tests by name
vp run test:unit                     # the whole suite
vp run build                         # emit dist/
vp run check:dist                    # the dist guard
vp run test:coverage                 # coverage map for fallow
vp run fallow:audit                  # change-set review (not a CI gate)
vp run bench                         # JSON example: interpreted vs compiled, per encoding
vp run bench:native                  # compiled JSON parser vs JSON.parse
vp run bench:stream                  # parsing a fetch body as it downloads vs Response.json()
vp run bench:gen                     # parsers built inside a Parser.gen body vs hoisted
vp run bench:syntax                  # building a syntax tree, and reparsing after edits
```
