# AGENTS.md

`CLAUDE.md` is a symlink to this file. Project conventions live here; personal style preferences live in user memory.

This repo publishes one package, `@thomasfosterau/effect-parse`: parser combinators for Effect, ported from Rust's nom and winnow. It covers text, bytes, bits and token streams, streaming input, compiled parsers (a JIT and a closure compiler), syntax trees with incremental reparsing, and Schema integration. Other libraries depend on its public API (effect-robots in effect-web, effect-wikimedia), so the exported surface changes only on purpose and with a changeset.

| Package | Directory | Entries |
| --- | --- | --- |
| `@thomasfosterau/effect-parse` | `.` (`src/`) | `.` plus one subpath per module: `./Input`, `./Parser`, `./Compiler`, `./ParseError`, `./Token`, `./Ascii`, `./Text`, `./Encoding`, `./Binary`, `./Bits`, `./Expression`, `./Nom`, `./ParserSchema`, `./ParserStream`, `./Syntax` |

`src/<Module>.ts` is a public module (re-exported as a namespace from `src/index.ts` and published on its own subpath); `src/internal/**` is private. `docs/DESIGN.md` records why the port is shaped as it is; read the relevant section before changing a subsystem (the compilers, streaming, syntax trees).

## Common pitfalls

- **Never edit a version in `package.json`.** Versions live in the `pnpm-workspace.yaml` catalog (`catalogMode: strict` rejects anything else; published peer ranges are under `catalogs.peers`). After editing it, run `pnpm install` and commit `pnpm-lock.yaml`, or CI fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`. `@effect/tsgo`, `@typescript/native` and `vite-plus` move together (the tsgo patch hard-errors at install on an unsupported `tsc` or `oxlint`); read their catalog comments first.
- **`dist/` is the product, and `vp run check:dist` guards it.** `vp pack` emits one module per source module with relative imports left as written, so `dist/` mirrors `src/`. The guard imports every `exports` entry as a consumer does, requires each subpath to export exactly what its root namespace does, and checks that only `Compiler` reaches `internal/compiler/{closure,jit}` (so a program bundles only the compilers it uses).
- **`"sideEffects": false` is load-bearing.** Every call that runs when a module loads (a top-level parser built from combinators, a `new Map()`) must carry `/*#__PURE__*/`, or bundlers keep it and everything it references. `check:dist` fails on an unmarked one.
- **The step functions are hot loops.** A parser's `step` runs once per input position. Keep allocation, closures and megamorphic calls out of it; native loops and `new Array(n)` are deliberate there (the lint config records the measurements). Run the benchmarks before and after touching `src/Parser.ts`, `src/Token.ts`, `src/Text.ts`, `src/Ascii.ts`, `src/internal/**` or a compiler, and report the numbers.
- **Compiled and interpreted parsers must agree.** The compilers are optimisations, never a second semantics: every compiled result, error, position and failure mode equals the interpreter's. The differential suites in `test/Compiler.test.ts`, `test/Streaming.test.ts` and `test/Syntax.test.ts` enforce this; extend them with any new combinator.
- **`effect` is a peer, never a dependency.** Two copies break `Context` / `Schema` identity; the consumer owns the singleton.
- **README examples are tested.** `test/readme.test.ts` runs the README's examples; change both together.

## Conventions

- **Effect-first where it costs nothing at runtime.** Public failures are `ParseError` (a `Data.TaggedError`, part of the published API) with user errors typed in `E`; services are Effect `Context` services in `R`; runners return `Result` / `Effect`; streams are Effect `Stream`s. Inside step functions the protocol is plain values and the `Fail` sentinel, for speed.
- **Optional props are declared `T | undefined`, never bare `x?: T`.** The package compiles with `exactOptionalPropertyTypes`.
- **Imports:** Effect modules as namespaces (`import * as Option from "effect/Option"`, never the `effect` barrel); relative source imports carry `.js` (resolved to `.ts`); tests, examples and benchmarks import the package by name (resolved to `src/` by `tsconfig.json` `paths` and the `vite.config.ts` alias).
- **Tests import from `vite-plus/test`**, never `vitest`. `test/<Module>.test.ts` covers a module; `test/*.types.ts` holds compile-time assertions (an expect-error directive above a statement that must fail), type-checked by `vp run check`, never executed.
- **Every export has a doc comment** whose first sentence says what it is for, with `@since` (and `@category` on public modules) and an `@example` for functions. Doc-comment changes reach the emitted `.d.ts`.
- **A new public module** is added to `src/index.ts`, to `exports` in `package.json` and to `entry` in `.fallowrc.json`; `vp pack` picks it up from `src/**`.
- **Lint allowances shrink, never grow.** Rules at `warn` in `vite.config.ts` carry their remaining count (the sites are listed in [#35](https://github.com/thomasfosterau/effect-parse/issues/35)); a new site is a defect. A rule is turned `off` only with a comment giving the reason (a measurement, or the published API it would break).

## Commands

- `pnpm install` — dependencies, the Vite+ git hooks (pre-commit runs `vp staged`: format + lint on staged files) and the `prepare` step that patches the native `tsc` / `oxlint` with `@effect/tsgo`. No pre-push hook: run the gates yourself.
- `vp check` — format + lint (Oxfmt + Oxlint with `@effect/tsgo` and `@mpsuesser/oxlint-plugin-effect`). `vp run check` — the type gate (native, Effect-patched `tsc` over `src`, `test`, `examples`, `bench`). They are different commands.
- `vp run test:unit` — the unit suite (about 90 s; the differential suites are large).
- `vp run build` — `vp pack` → `dist/`.
- `vp run check:dist` — the dist guard (builds first).
- `vp run test:coverage` — the suite under Istanbul with the coverage floor, writing `coverage/coverage-final.json` for `fallow audit`.
- `vp run bench`, `bench:native`, `bench:stream`, `bench:gen`, `bench:syntax` — benchmarks over the built `dist/` (they build first). Never in CI; numbers depend on the machine.
- `pnpm changeset` — add a changeset.

Invoke everything through `vp` (`vp exec` for a binary, `vp run <task>` for a task). The sanctioned non-`vp` invocations are `pnpm install`, `pnpm changeset`, and `pnpm pack` / `npm publish` inside the Release workflow. Single-check variants are in [CONTRIBUTING.md](CONTRIBUTING.md#running-individual-checks).

## Verification

Before you report work as done, run the gates below in order and quote each command with its final pass/fail. If a gate can't run here, say which and why in the PR body; never imply it ran.

1. From a clean install, which is what CI sees: `rm -rf node_modules dist coverage && pnpm install --frozen-lockfile`.
2. `vp check`
3. `vp run check`
4. `vp run test:unit`
5. `vp run build`
6. `vp run check:dist`
7. `pnpm audit --audit-level high` (network)
8. `vp run test:coverage`, then `fallow audit --format json --quiet --explain --gate-marker agent --base origin/trunk` (the fallow gate below; not a CI step).

Steps 2–7 are CI's required `ci` job, in its order ([ci.yml](.github/workflows/ci.yml)). A change to a hot path also reports `vp run bench` (and the benchmark for the area touched) before and after. `CONTRIBUTING.md` and the PR template link here rather than restating the list.

## Branches and pull requests

- The default branch is `trunk`. Branch off `trunk`; PR against `trunk`; squash-merge with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `ci:`). Rebase onto `origin/trunk` before opening or updating a PR; never merge `trunk` into your branch.
- Every change to the package's behaviour or its emitted `.d.ts` (doc comments included, as a `patch`) carries a changeset (`pnpm changeset`); README, `docs/`, guidance, CI and tooling changes need none. While the package is `0.x`, a breaking change is a `minor`. Never publish or version by hand: the Release workflow opens the version PR (`chore: version packages`) and the owner merges it. Publishing is npm trusted publishing (OIDC) from the protected `release` environment; there is no `NPM_TOKEN` ([PUBLISHING.md](PUBLISHING.md)).
- Open a pull request only when the owner asks for one; otherwise push the branch and report it.
- GitHub writes go to `thomasfosterau/effect-parse` only, never to the libraries that depend on it or to upstream projects, without the owner's explicit approval in the current session. If another repo needs something, say so in the PR body.

## Work tracker

- Issues in `thomasfosterau/effect-parse` are the backlog: when you find work you can't do now, file an issue rather than leaving a TODO.
- The issue is the spec; later comments override the body. Re-verify its code claims against current `trunk` before editing.
- Record decisions and findings as comments on the issue they were found working; a scope cut mid-PR becomes a linked issue before merge.

## Effect

Never guess at an Effect API. Read the installed package: `node_modules/effect/dist/*.d.ts`, `node_modules/effect/src`, and the guidance it ships (`node_modules/effect/AGENTS.md`, `node_modules/effect/ai-docs/`). The pinned version is the `effect` entry in `pnpm-workspace.yaml`'s catalog; the published peer range is `catalogs.peers.effect` (`^4.0.0`), and raising its floor is a breaking change for every consumer.

## Agent sessions

- The SessionStart hook (`.claude/hooks/session-start.sh`) installs dependencies against the lockfile with pnpm and puts `vp` (a re-exec shim that prefers the nearest worktree's `node_modules`) and `fallow` on PATH for non-interactive shells. It hydrates no secrets; none are needed, and nothing here can publish.
- A PreToolUse hook (`.claude/hooks/fallow-gate.sh`) blocks `git commit` / `git push` when `fallow audit --base origin/trunk` fails; it reads the coverage map on disk, so run `vp run test:coverage` first. A PostToolUse hook runs `vp fmt` on every source, JSON, CSS or Markdown file you write or edit.
- Every gate in [Verification](#verification) runs in an agent session; `pnpm audit` needs the network.

## Documentation surfaces

`README.md` is the landing page and the API guide consumers read on npm (its examples are tested); `docs/DESIGN.md` records the research and the reasoning behind each subsystem; doc comments are the per-export reference (hovers and the emitted `.d.ts`); `CONTRIBUTING.md` carries human setup, CI expectations and single-check commands; `PUBLISHING.md` the release pipeline and its one-time owner setup; `SECURITY.md` the reporting channel and supply-chain posture; `CHANGELOG.md` is written by Changesets.

---

## Fallow local gate

Before any `git commit` or `git push`, run `fallow audit --format json --quiet --explain --gate-marker agent`. If the verdict is `fail`, fix the reported findings before retrying. Treat JSON runtime errors like `{ "error": true, ... }` as non-blocking. Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict. Pre-existing complexity and duplication are recorded in `fallow-baselines/`; re-save a baseline only when a finding is removed, never to admit a new one.

## Fallow task map

| When the agent is about to...                                     | Run                                          |
| ----------------------------------------------------------------- | -------------------------------------------- |
| delete an "unused" export or file                                 | `fallow dead-code --trace <file>:<export>`   |
| delete an "unused" dependency                                     | `fallow dead-code --trace-dependency <name>` |
| commit or open a PR                                               | `fallow audit --base <ref>`                  |
| check which architecture rules apply to a file before changing it | `fallow guard <files>`                       |
| understand a finding                                              | `fallow explain <issue-type>`                |
