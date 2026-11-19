# Contributing

Read the [README](../README.md) first. Agents should also read [AGENTS.md](../AGENTS.md).

## Workflow

- Branch off `trunk` and open a pull request into `trunk`; never commit to `trunk` directly. Open a draft PR as soon as you start, so others can see the work.
- One PR per change, however large: don't split a change into a PR per slice. It is your job to get the PR green, reviewed and free of conflicts. Rebase onto `origin/trunk` rather than merging `trunk` in; PRs are squash-merged with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`).
- Found something out of scope? File an issue and carry on. Keep issue bodies evergreen: update the body with context, rationale and the proposed fix rather than appending comments.
- Dependabot keeps dependencies current. Don't update them by hand unless your change needs a newer version or the update is one Dependabot can't make (below).

## Toolchain

[Vite+](https://viteplus.dev) (`vp`) manages Node, pnpm and every tool; run things through it (`vp exec <bin>` instead of `npx`, `vp run <task>` for the tasks in `vite.config.ts`). `vp install` installs dependencies, the git hooks (pre-commit runs `vp staged`: format and lint staged files) and the `prepare` step that patches the native `tsc` / `oxlint` with `@effect/tsgo`.

| Command | What it does |
| --- | --- |
| `vp check` | Format + lint (Oxfmt, Oxlint with the Effect presets; type-aware) |
| `vp run check` | The type gate: the Effect-patched native `tsc` over `src`, `test`, `examples`, `bench` |
| `vp run test:unit` | The unit suite; `vp test run test/Parser.test.ts` runs one file |
| `vp run build` / `vp run check:dist` | `vp pack` to `dist/`; the dist guard (exports, `/*#__PURE__*/`, compiler isolation) |
| `vp run ci` | Everything CI runs, in order, stopping at the first failure |
| `vp run test:coverage` | The suite under Istanbul with coverage floors; writes the map `fallow audit` reads |
| `vp run bench*` | Benchmarks over `dist/` (`bench`, `bench:native`, `bench:stream`, `bench:downstream`, …); never in CI |

[Fallow](https://docs.fallow.tools) finds dead code, duplication and complexity. Use it to guide your work (`vp run test:coverage`, then `vp exec fallow audit --base origin/trunk`); its findings are advice, not dogma, and CI doesn't run it.

### Dependencies

Every version lives in the `pnpm-workspace.yaml` catalog; `package.json` uses `catalog:` only. After editing the catalog, run `vp install` and commit `pnpm-lock.yaml`. Dependabot can't do these:

- `vite`, `vitest` and `@vitest/coverage-istanbul` must equal what `vite-plus` pins: after a `vite-plus` bump, run `node scripts/check-toolchain.mjs --fix` and `vp install` (CI's `check:toolchain` catches drift).
- `@effect/tsgo`, `@typescript/native` (an npm alias) and vite-plus's oxlint must be a combination the `components` table in `node_modules/@effect/tsgo/dist/effect-tsgo.cjs` supports, or `vp install` fails.
- The devcontainer image tag equals the `vite-plus` pin; the `npm` version in `release.yml` is bumped by hand.

## Coding guidelines

- Use Effect idioms throughout, and prefer Effect v4's own modules (`Option`, `Result`, `Array`, `Match`, `Schema`, …) to re-inventing them; convert existing code where practical. The exceptions are non-Effect APIs, adapted at the edge, and hot paths where a measurement shows plain code is needed (the step functions and compilers, with the measurements in `vite.config.ts`). If you find non-idiomatic code you can't fix trivially, file an issue listing the sites and the idiomatic replacement.
- Public failures are `ParseError`; inside step functions the protocol is plain values and the `Fail` sentinel, for speed. Read the installed `effect` package (`node_modules/effect/dist/*.d.ts`) rather than guessing at its API.
- Step functions are hot loops: keep allocation and closures out of them, and report `vp run bench` (and the benchmark for the area) before and after changing a parser hot path or a compiler.
- Compiled and interpreted parsers must agree exactly; extend the differential suites in `test/Compiler.test.ts`, `test/Streaming.test.ts` and `test/Syntax.test.ts` with any new combinator.
- `"sideEffects": false` holds only if every top-level call is marked `/*#__PURE__*/`.
- Fix lint findings rather than disabling rules; a rule is turned off only in `vite.config.ts`, scoped and with its reason.

### Comments

- A file-level comment only when it adds non-obvious context (under 50 words).
- Doc comments on exports where they help someone reading IntelliSense: what it's for, not a restatement of the signature. Public exports carry `@since` and an `@example` for functions.
- Inline comments only where the code can't explain itself: workarounds, performance, non-obvious decisions.
- Never reference GitHub issues, PRs or CI runs in code or docs; stable links to external documentation are fine.

### Tests

- Tests import from `vite-plus/test`, never `vitest`. `test/<Module>.test.ts` covers a module; `test/*.types.ts` holds compile-time assertions.
- Test logic, edge cases and regressions; don't test what the type system already enforces, or trivial code.
- The examples in [guide.md](guide.md) are run by `test/guide.test.ts`; change both together.

## Before you push

Run `vp run ci` (format, lint, type gate, tests, build, dist guard, `pnpm audit`); for parity with CI, start from `rm -rf node_modules dist && vp install --frozen-lockfile`. Optionally run `vp run test:coverage` and `vp exec fallow audit --base origin/trunk`.

## Changesets

Every change to the package's behaviour or its emitted `.d.ts` (doc comments included, as a `patch`) needs a changeset: run `pnpm changeset` and commit the file with the change. Docs, CI and tooling changes need none. While the package is `0.x`, a breaking change is a `minor`. Never version or publish by hand: see [PUBLISHING.md](PUBLISHING.md).
