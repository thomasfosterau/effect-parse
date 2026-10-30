/**
 * The one Vite+ configuration for this package: the repo-wide format / lint /
 * staged passes (read statically by `vp fmt` / `vp lint` / `vp staged`), the
 * task graph (`check`, `build`, `check:dist`, `test:unit`, `test:coverage`,
 * the `bench*` tasks), the `vp pack` (tsdown) settings and the vitest /
 * coverage settings.
 *
 * Shaped like the owner's other Effect libraries (effect-web,
 * effect-schema-ext): every comment that explains a load-bearing decision is
 * part of the standard and travels with the config.
 *
 * @copyright Thomas Foster
 */

import { fileURLToPath } from "node:url"
import { recommended } from "@effect/tsgo/oxlint-presets"
import effect from "@mpsuesser/oxlint-plugin-effect"
import { defineConfig } from "vite-plus"

/**
 * Input fingerprint for the cached tasks: auto tracking minus node_modules
 * bookkeeping churn (pnpm rewrites `.modules.yaml` on every install), with the
 * lockfile back explicitly so a dependency upgrade still invalidates a
 * type-check or a test run.
 */
const cacheInputs = [{ auto: true }, "!node_modules/**", "!coverage/**", "pnpm-lock.yaml"]

const maxWorkers = process.env.VITEST_MAX_WORKERS

/**
 * A benchmark task: plain Node over the built `dist/` (the benchmarks import
 * the package by name, through `exports`), never cached, never in CI.
 */
const bench = (file: string) => ({
  command: `node --experimental-strip-types bench/${file}.bench.ts`,
  dependsOn: ["build"],
  cache: false
})

export default defineConfig({
  // Staged-file checks run by `vp staged` (pre-commit).
  staged: {
    "*.{js,mjs,ts,css,json,md}": "vp check --fix"
  },
  fmt: {
    // The house style the source was written in (Effect's own): no
    // semicolons, no trailing commas, 120 columns.
    semi: false,
    trailingComma: "none",
    printWidth: 120,
    ignorePatterns: ["**/dist/**", "**/coverage/**", "CHANGELOG.md", "pnpm-lock.yaml"],
    overrides: [
      {
        files: ["**/*.md"],
        options: {
          proseWrap: "never"
        }
      }
    ]
  },
  lint: {
    ignorePatterns: ["**/dist/**", "**/coverage/**", "**/node_modules/**"],
    extends: [recommended, effect.configs.recommended],
    categories: {
      correctness: "error"
    },
    rules: {
      "eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_"
        }
      ],
      "eslint/prefer-const": "warn",
      // The `Buffer` global is typed `any` wherever a consumer loads
      // @cloudflare/workers-types next to @types/node, so every call on it is
      // unchecked there. Use Uint8Array / TextEncoder / DataView instead.
      "eslint/no-restricted-globals": [
        "error",
        {
          name: "Buffer",
          message:
            "The `Buffer` global is typed `any` wherever @cloudflare/workers-types is loaded. Use Uint8Array / TextEncoder / DataView."
        }
      ],
      // `casting-awareness` is an awareness prompt, not a defect rule — it
      // fires on every `as`. Stays visible as a warning.
      "effect/casting-awareness": "warn",

      // ---- Effect preset: allowances still being paid down ------------------
      // The parser predates the Effect oxlint preset. These rules sit at
      // `warn` with the count they had when the preset was adopted, so the
      // code stays committable while every site stays reported; a new site is
      // a defect, not headroom. The remaining sites are listed in
      // effect-parse#35. Flip a rule back to the
      // preset's `error` and delete its line when its count reaches zero.
      "effect/require-safety-comment-for-type-assertion": "warn", // 303
      "effect/avoid-any": "warn", // 60
      "effect/avoid-direct-tag-checks": "warn", // 11, all `switch (x._tag)`: the compilers, `children` and examples/sexpr
      "effect/avoid-direct-json": "warn", // 35 outside bench/
      "effect/avoid-native-object-helpers": "warn", // 43 outside bench/
      "effect/no-known-value-widening": "warn", // 33
      "effect/prefer-match-over-switch": "warn", // 22
      "effect/no-chained-type-assertions": "warn", // 13
      // `avoid-try-catch`: 6. Four are `try`/`finally` (`provideService` /
      // `provide` restoring `state.context`, and two tests), which `Result.try`
      // cannot express. Two are on the parse path, where `Result.try`'s closure
      // measured ~12x slower than an inline `try` (effect-parse#53):
      // `tryMapUnknown` (per call of `f`) and `Stack.run` (per parse).
      "effect/avoid-try-catch": "warn",
      "effect/no-unsafe-dictionary-type": "warn", // 3 outside bench/
      "effect/use-console-service": "warn", // 2 outside bench/ (`Parser.debug`'s console tracer)
      // ---- Effect preset: rules this library's conventions cut across ------
      // `prefer-option-over-null` fires on every `| undefined`: the absent
      // value of the public API (`Parser.opt`, the options members spelled
      // `?: T | undefined` under `exactOptionalPropertyTypes`, `Input.State`
      // fields) and the step protocol's per-step results. Changing the public
      // spelling breaks every consumer; boxing a step result in `Option`
      // allocates on every parse step. 219 sites.
      "effect/prefer-option-over-null": "warn",
      // `unknown` is the honest type at the interpreter's erased boundary: a
      // step returns the value of whatever parser it runs, and the compilers
      // walk parser nodes whose values they never inspect. 43 + 45 sites.
      // `object` keys are identity keys (the parser or node a checkpoint or a
      // syntax node belongs to), compared by reference in `Map`s. 15 sites.
      "effect/no-unknown-parameters": "warn",
      "effect/no-unknown-returns": "warn",
      "effect/no-object-parameters": "warn",
      // Hard-codes abbreviations (`Arr`, `P`, `R`, …) with no options, so it is
      // unsatisfiable under the full-name convention (`import * as Option from
      // "effect/Option"`) this library shares with its consumers.
      "effect/prefer-namespace-imports": "off",
      "typescript/no-explicit-any": "off",
      "typescript/no-empty-object-type": "off",
      "typescript/ban-ts-comment": "off",
      "unicorn/no-empty-file": "off",
      "vite-plus/prefer-vite-plus-imports": "error"
    },
    overrides: [
      // The parser runtime: every step function scans input a unit at a time
      // and the compilers build code in loops. The shape this rule asks for
      // (`Arr.range` + `Arr.findFirstIndex` over the positions) scans a 1 MB
      // run of digits 7x slower than the `while` loop it replaces (9.15 ms
      // against 1.26 ms, best of 30, Node 22; the `internal/tokens.ts` `scan`
      // loop), and recursion overflows the stack on long inputs. The example
      // custom parser step is the same kind of code, and the benchmarks'
      // timing loops measure it, so a callback per iteration would skew them.
      {
        files: ["src/**", "examples/json-syntax.ts", "bench/**"],
        rules: {
          "effect/imperative-loops": "off"
        }
      },
      // Preallocating an array whose length is known (a sequence's results,
      // a syntax node's children) in the step loop: `new Array(n)` filled by
      // index takes 20.8 ms for 3M four-element arrays, `[]` + `push` 88.5 ms
      // and `Array.from({ length: n })` 1471 ms (Node 22).
      {
        files: ["src/**"],
        rules: {
          "unicorn/no-new-array": "off"
        }
      },
      // `ParseError` and `ParserStream.ReadError` are published
      // `Data.TaggedError` classes; moving them to `Schema.TaggedError`
      // changes their public type for every consumer.
      {
        files: ["src/ParseError.ts", "src/ParserStream.ts"],
        rules: {
          "effect/avoid-data-tagged-error": "off"
        }
      },
      // The benchmarks are plain Node programs: they print a table, compare
      // against `JSON.parse` (the subject of the comparison), run their
      // Effect programs at the top level, and abort on a wrong result.
      {
        files: ["bench/**"],
        rules: {
          "effect/use-console-service": "off",
          "effect/avoid-direct-json": "off",
          "effect/effect-run-in-body": "off",
          "effect/avoid-untagged-errors": "off",
          "effect/avoid-native-object-helpers": "off",
          "effect/no-unsafe-dictionary-type": "off"
        }
      },
      // A test body is the harness boundary the rule itself names as the
      // place to run an Effect.
      {
        files: ["test/**"],
        rules: {
          "effect/effect-run-in-body": "off"
        }
      },
      // Type-level tests: the expect-error directives ARE the assertions (a
      // statement that must fail to compile).
      {
        files: ["test/**/*.types.ts"],
        rules: {
          "effect/avoid-ts-ignore": "off"
        }
      },
      // Build/test configs and the dist guard are evaluated in bare Node,
      // before any Effect runtime exists — there is no `Config` provider to
      // read from and no `FileSystem` service to call, so `process.env` and
      // `node:*` are the only things that work there. The Effect preset's
      // service rules have no satisfiable fix in these files.
      {
        files: ["vite.config.ts", "scripts/**"],
        rules: {
          "effect/avoid-node-imports": "off",
          "effect/avoid-sync-fs": "off",
          "effect/avoid-process-env": "off",
          // Plain Node build tooling (the dist guard): native loops, `.length`
          // and `Object.fromEntries` are the idiom.
          "effect/imperative-loops": "off",
          // The dist guard is untyped JavaScript walking rolldown's ESTree
          // JSON: `typeof` probes, `throw` / `try` around a dynamic import and
          // `.sort()` on plain arrays are all it has.
          "effect/no-runtime-typeof": "off",
          "effect/prefer-effect-is": "off",
          "effect/avoid-untagged-errors": "off",
          "effect/avoid-try-catch": "off",
          "effect/avoid-direct-json": "off",
          "effect/prefer-arr-sort": "off",
          "effect/no-length-comparison": "off",
          "effect/prefer-arr-match": "off",
          "effect/avoid-native-object-helpers": "off",
          "effect/use-console-service": "off",
          "effect/use-filesystem-service": "off",
          "effect/use-path-service": "off",
          "effect/effect-promise-vs-trypromise": "off",
          // `...(process.env.X ? { x } : {})` is how a vitest option is left
          // unset under `exactOptionalPropertyTypes`.
          "effect/no-conditional-empty-object-spread": "off"
        }
      }
    ],
    // Type-aware linting is intentionally disabled: type checking stays the
    // `check` task's job (native tsc, Effect-patched).
    options: {
      typeAware: false,
      typeCheck: false
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin"
      }
    ]
  },
  run: {
    tasks: {
      // The type gate: `src`, the tests, the examples and the benchmarks
      // under the native, Effect-patched `tsc`. tsconfig.json resolves the
      // package name to `src/`, so it never needs a build first.
      check: {
        command: "tsc -p tsconfig.json",
        cache: { input: cacheInputs, output: [] }
      },
      // The catalog entries that move in lockstep with `vite-plus`
      // (scripts/check-toolchain.mjs; `--fix` rewrites them): Dependabot
      // bumps vite-plus but not its `vite` alias or its vitest pin.
      "check:toolchain": {
        command: "node scripts/check-toolchain.mjs",
        cache: false
      },
      // The published artifact: one ESM module + declaration file per source
      // module (`vp pack` → tsdown; see `pack` below).
      build: {
        command: "vp pack",
        cache: { input: cacheInputs, output: ["dist/**"] }
      },
      // The dist guard (scripts/check-dist.mjs): imports every `exports`
      // entry from the built `dist/` as a consumer does, fails on any
      // top-level call not marked `/*#__PURE__*/` (`sideEffects: false` is a
      // claim about `dist/`), and checks that only the `Compiler` module
      // reaches the compilers. Reads `dist/`, hence the build edge.
      "check:dist": {
        command: "node scripts/check-dist.mjs",
        dependsOn: ["build"],
        cache: false
      },
      "test:unit": {
        command: "vp test run",
        cache: { env: ["VITEST_MAX_WORKERS", "NODE_OPTIONS"], input: cacheInputs, output: [] }
      },
      // The unit suite under Istanbul, writing `coverage/coverage-final.json`,
      // which `fallow audit` reads for exact per-function CRAP scores
      // (`health.coverage` in .fallowrc.json). Without it fallow estimates
      // every function as uncovered, and any function with cyclomatic
      // complexity ≥ 5 fails the gate on its own. Run this before
      // `fallow audit` (the Claude Code PreToolUse fallow gate runs the audit
      // on `git commit` / `git push` but never refreshes this map).
      "test:coverage": {
        // Istanbul instrumentation slows the differential suites several-fold,
        // past vitest's 5 s default; the unit run keeps the default.
        command: "vp test run --coverage --testTimeout 30000",
        cache: { env: ["VITEST_MAX_WORKERS", "NODE_OPTIONS"], input: cacheInputs, output: ["coverage/**"] }
      },
      // Benchmarks: run by hand around a change to a hot path, never in CI
      // (their numbers depend on the machine).
      bench: bench("json"),
      "bench:native": bench("native"),
      "bench:stream": bench("stream"),
      "bench:gen": bench("gen"),
      "bench:syntax": bench("syntax"),
      "bench:drivers": bench("drivers")
    }
  },
  pack: {
    // Every source module is an entry and every relative import stays
    // external, so `vp pack` emits one module per source module with its
    // imports untouched, as `tsc` did: `dist/` keeps the `src/` layout that
    // `exports` and the dist guard rely on, the `Compiler` subpath stays the
    // only route to the compilers, and `export * as X` stays a native
    // namespace re-export (bundling it, even unbundled, makes each subpath
    // export an extra `X_exports` binding the root namespace does not have).
    entry: ["src/**/*.ts"],
    deps: { neverBundle: [/^\.\.?\//] },
    format: "esm",
    platform: "neutral",
    target: "es2022",
    dts: { sourcemap: true },
    sourcemap: true,
    outDir: "dist",
    clean: true
  },
  resolve: {
    // Tests import the package by name, exactly as a consumer would (and as
    // tsconfig.json's `paths` type-checks them), so the runner resolves that
    // name to `src/` rather than to the built `dist/` that `exports` points
    // at — a unit run never needs a build first.
    alias: {
      "@thomasfosterau/effect-parse": fileURLToPath(new URL("./src/index.ts", import.meta.url))
    }
  },
  test: {
    include: ["test/**/*.test.ts"],
    ...(maxWorkers === undefined ? {} : { maxWorkers: Number(maxWorkers) }),
    coverage: {
      provider: "istanbul",
      // `json` writes coverage-final.json, the Istanbul map `fallow audit`
      // reads (`health.coverage` in .fallowrc.json).
      reporter: ["text-summary", "json-summary", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.d.ts"],
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 }
    }
  }
})
