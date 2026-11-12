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
import effect from "@enfect/oxlint"
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
    // oxlint's defaults (eslint, typescript, unicorn, oxc) plus the import,
    // promise, vitest and node rule sets; `categories` turns on each one's
    // correctness rules.
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "promise", "vitest", "node"],
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
      // Every `effect/*` rule is at the preset's `error`. The overrides below
      // turn a rule off only where it cannot apply, each with its reason
      // (effect-parse#68); a new site anywhere else is an error.
      //
      // `casting-awareness` flags every `as`, as a prompt to justify it. Each
      // assertion here is justified by the `// SAFETY:` comment that
      // `require-safety-comment-for-type-assertion` requires (at `error`), so
      // the prompt has been answered at every site and can't be satisfied
      // further: the assertions that remain are those the type system can't
      // express (the interpreter's erased step boundary, input kinds known at
      // run time, deliberate type lies in tests).
      "effect/casting-awareness": "off",
      // Hard-codes abbreviations (`Arr`, `P`, `R`, …) with no options, so it is
      // unsatisfiable under the full-name convention (`import * as Option from
      // "effect/Option"`) this library shares with its consumers.
      "effect/prefer-namespace-imports": "off",
      "typescript/no-explicit-any": "off",
      "typescript/no-empty-object-type": "off",
      "typescript/ban-ts-comment": "off",
      "unicorn/no-empty-file": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
      // The suites assert through local helpers (`expectSuccess`,
      // `ok` / `fails`, the differential `same*` / `differential` runners) and
      // Node's `assert`, which the rule cannot see through by default.
      "vitest/expect-expect": [
        "error",
        { assertFunctionNames: ["expect*", "assert*", "*.assert*", "ok", "fails", "same*", "differential"] }
      ],
      // `expect(actual, message)`: the second argument is Vitest's own
      // failure message, which the suites use to name the failing input.
      "vitest/valid-expect": ["error", { maxArgs: 2 }]
    },
    overrides: [
      // ---- Effect rules that cannot apply here (effect-parse#68) ----------
      // `unknown` is the honest type at the interpreter's erased boundary: a
      // step returns the value of whatever parser it runs, a node stores the
      // user callbacks of every parser kind, and the compilers walk nodes
      // whose values they never inspect. The rules ask for a named domain
      // type that does not exist there.
      {
        files: ["src/**"],
        rules: {
          "effect/no-unknown-parameters": "off",
          "effect/no-unknown-returns": "off"
        }
      },
      // The hand-fused benchmark parser returns any JSON value, and the JSON
      // benchmark's cases are timed for their work: their values are dropped.
      {
        files: ["bench/json-fused.ts", "bench/json.bench.ts"],
        rules: {
          "effect/no-unknown-returns": "off"
        }
      },
      // `| undefined` is the absent value of the published API (`Parser.opt`,
      // the options members spelled `?: T | undefined` under
      // `exactOptionalPropertyTypes`, `Input.State` fields) and of the step
      // protocol: changing the public spelling breaks every consumer, and
      // boxing a step result in `Option` allocates on every parse step. The
      // test harnesses mirror that protocol (`eager.ts`, the differential
      // runners, `defined`), the JSON example's `null` is JSON's null, and the
      // hand-fused benchmark parser returns the same sentinel.
      {
        files: [
          "src/**",
          "test/eager.ts",
          "test/utils.ts",
          "test/Parser.test.ts",
          "test/Compiler.test.ts",
          "examples/json.ts",
          "bench/json-fused.ts"
        ],
        rules: {
          "effect/prefer-option-over-null": "off"
        }
      },
      // The step functions switch on `state.inputKind` once per input
      // position: `Match.value` there took 100.6 ms per million positions
      // against 4.84 ms for the `switch` (21x; Node 22). The compilers and
      // `children` dispatch exhaustively over the ~55-member `Node` union,
      // which tsc checks for exhaustiveness; the hand-fused benchmark parser
      // is the plain-JavaScript reference the compilers are measured against.
      {
        files: [
          "src/internal/compiler/**",
          "src/internal/node.ts",
          "src/internal/tokens.ts",
          "src/Input.ts",
          "src/Token.ts",
          "bench/json-fused.ts"
        ],
        rules: {
          "effect/prefer-match-over-switch": "off",
          "effect/avoid-direct-tag-checks": "off"
        }
      },
      // `Result.try` measured ~12x slower than an inline `try` on the parse
      // path (effect-parse#53): `tryMapUnknown` (per call of `f`) and
      // `Stack.run` (per run). `provideService` / `provide`, `Stack.runCompiled`
      // (its `compiledRun` flag, #82) and two tests use `try`/`finally` to
      // restore state, which `Result.try` cannot express.
      {
        files: ["src/Parser.ts", "src/internal/stack.ts", "test/Parser.test.ts", "test/Compiler.test.ts"],
        rules: {
          "effect/avoid-try-catch": "off"
        }
      },
      // `JSON.stringify` writes a string as a quoted literal: in the JIT's
      // generated JavaScript, and in error messages (`expected "true"`, found
      // tokens, previews), whose text is published and compared byte for byte.
      // These are not JSON data at a boundary, which the rule's Schema codecs
      // are for. The examples' tests compare the JSON parsers with
      // `JSON.parse`, the subject of the comparison.
      {
        files: [
          "src/internal/compiler/jit.ts",
          "src/internal/tokens.ts",
          "src/internal/text.ts",
          "src/Text.ts",
          "src/ParseError.ts",
          "src/Parser.ts",
          "test/examples.test.ts"
        ],
        rules: {
          "effect/avoid-direct-json": "off"
        }
      },
      // The runtime's mutable tables are keyed by object identity (parsers,
      // checkpoint keys) or by a code unit, are written while parsing or
      // compiling, and are never shared: memo tables, per-character caches,
      // the streaming checkpoints. `Object.fromEntries` must be the built-in,
      // which the compilers recognise by identity. The INI example returns
      // `Map`s by design, and the tests build the values they compare with.
      {
        files: ["src/**", "examples/ini.ts", "test/Input.test.ts", "test/Compiler.test.ts", "test/examples.test.ts"],
        rules: {
          "effect/avoid-native-object-helpers": "off"
        }
      },
      // `internal/entries.ts` fills a fresh plain object with parsed entries:
      // `object` is its honest type, there is no narrower owner type, and the
      // struct outputs the closure compiler builds hold `unknown` values.
      {
        files: ["src/internal/entries.ts"],
        rules: {
          "effect/no-object-parameters": "off"
        }
      },
      {
        files: ["src/internal/compiler/closure.ts"],
        rules: {
          "effect/no-unsafe-dictionary-type": "off"
        }
      },
      // `Parser.consoleTracer` is a synchronous tracer called from step
      // functions, where no Effect runtime (and so no `Console` service) runs.
      {
        files: ["src/Parser.ts"],
        rules: {
          "effect/use-console-service": "off"
        }
      },
      // The hand-fused benchmark parser's `let v: unknown` holds any JSON
      // value. (The overloaded exports have named contracts since #77.)
      {
        files: ["bench/json-fused.ts"],
        rules: {
          "effect/no-known-value-widening": "off"
        }
      },
      // The parser runtime: every step function scans input a unit at a time
      // and the compilers build code in loops. The shape this rule asks for
      // (`Arr.range` + `Arr.findFirstIndex` over the positions) scans a 1 MB
      // run of digits 7x slower than the `while` loop it replaces (9.15 ms
      // against 1.26 ms, best of 30, Node 22; the `internal/tokens.ts` `scan`
      // loop), and recursion overflows the stack on long inputs. The example
      // custom parser step is the same kind of code, and the benchmarks'
      // timing loops measure it, so a callback per iteration would skew them.
      // The tape example's member lookup walks an object's records and
      // compares key bytes in place: the array of members the rule's shape
      // needs is the garbage per lookup that the example exists to avoid.
      {
        files: ["src/**", "examples/json-syntax.ts", "examples/json-tape.ts", "bench/**"],
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
      // The JIT compiler's whole job is building a step function from
      // generated source with `new Function`; there is no other way to do it.
      // The WebAssembly compiler builds its value builders the same way.
      {
        files: ["src/internal/compiler/jit.ts", "src/internal/compiler/wasm.ts"],
        rules: {
          "typescript/no-implied-eval": "off"
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
          "effect/no-unsafe-dictionary-type": "off",
          // Times each backend picked by name (`Compiler[backend]`).
          "import/namespace": "off"
        }
      },
      // The jq benchmark races the real `jq` binary: like the other
      // benchmarks it is a plain Node program, and it also spawns processes,
      // writes its generated document to a temporary file and reads its
      // settings from the environment, before and outside any timing.
      {
        files: ["bench/jq.bench.ts"],
        rules: {
          "effect/avoid-node-imports": "off",
          "effect/use-command-executor-service": "off",
          "effect/use-filesystem-service": "off",
          "effect/use-temp-file-scoped": "off",
          "effect/use-path-service": "off",
          "effect/avoid-sync-fs": "off",
          "effect/avoid-process-env": "off",
          "effect/avoid-try-catch": "off",
          "effect/prefer-option-over-null": "off"
        }
      },
      // The jq example's evaluator implements jq's dynamically typed language
      // over plain JSON values (the `json-fast.ts` parser's output), once per
      // value: `typeof` and `Array.isArray` are jq's own type tests (`type`,
      // `numbers`, its ordering), `null` is JSON's null, `JSON.stringify` is
      // jq's output format, and objects are the plain objects jq's key order
      // is read from. jq's `?`, `try` and `//` are errors that unwind through
      // the evaluator's callbacks, and its builtins loop over arrays. The
      // shapes the rules ask for cost per value what the measurements above
      // record (`Match.value` 21x a `switch`, `Result.try` 12x a `try`, a
      // callback per iteration 7x a loop), and would put Effect's cost into
      // the benchmark that measures the parser.
      {
        files: ["examples/jq.ts"],
        rules: {
          "effect/no-runtime-typeof": "off",
          "effect/prefer-effect-is": "off",
          "effect/prefer-option-over-null": "off",
          "effect/avoid-direct-json": "off",
          "effect/avoid-native-object-helpers": "off",
          "effect/avoid-try-catch": "off",
          "effect/imperative-loops": "off",
          "effect/no-length-comparison": "off",
          "effect/prefer-arr-match": "off",
          "effect/prefer-match-over-switch": "off",
          "effect/avoid-direct-tag-checks": "off",
          "effect/no-known-value-widening": "off",
          "effect/no-unknown-parameters": "off"
        }
      },
      // A test body is the harness boundary the rule itself names as the
      // place to run an Effect.
      {
        files: ["test/**"],
        rules: {
          "effect/effect-run-in-body": "off",
          // The differential suites pick a compiler backend by name
          // (`Compiler[backend]` over `["closure", "jit"]`) to run every case
          // through each; the computed access is the point, and tsc already
          // checks the key against the namespace's exports.
          "import/namespace": "off"
        }
      },
      // The suite derives parsers from `Schema.Number` itself: which numbers
      // that grammar accepts (signs, exponents) is the behaviour under test.
      {
        files: ["test/ParserSchema.test.ts"],
        rules: {
          "effecttsgo/schema-number": "off"
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
      // ---- examples/ripgrep: ripgrep's command line on effect-parse --------
      // `erg` is a command-line program run by `bin/erg.ts` in bare Node, with
      // no Effect runtime and no platform layer (`@effect/platform-node` is not
      // a dependency of this repository), and its benchmark harness and tests
      // spawn the tools they compare. `node:*` modules, `process`, and
      // `try`/`catch` around Node's throwing APIs (the caught value arriving
      // as `unknown`) are all it has for I/O, as in `scripts/**`.
      {
        files: ["examples/ripgrep/**"],
        rules: {
          "effect/avoid-node-imports": "off",
          "effect/avoid-sync-fs": "off",
          "effect/avoid-process-env": "off",
          "effect/avoid-try-catch": "off",
          "effect/use-filesystem-service": "off",
          "effect/use-path-service": "off",
          "effect/use-command-executor-service": "off",
          "effect/use-temp-file-scoped": "off",
          "effect/no-unknown-parameters": "off"
        }
      },
      // Its matcher and searcher are the same kind of code as the parser
      // runtime in `src/**`, and the reasons recorded there for these rules
      // apply unchanged: loops over the bytes of a buffer, its lines and the
      // code point ranges of a class (`imperative-loops`); `undefined` as the
      // absent value of the step protocol, of `Parser.optional` and of the
      // `?: T | undefined` options (`prefer-option-over-null`; a match search
      // runs once per match, where an `Option` allocates); mutable lookup
      // tables keyed by code point, flag or name, built once
      // (`avoid-native-object-helpers`); and exhaustive `switch`es over the
      // regex syntax tree, which tsc checks (`prefer-match-over-switch`,
      // `avoid-direct-tag-checks`). `JSON.stringify` writes ripgrep's `--json`
      // records and quoted literals in messages, compared byte for byte with
      // ripgrep's own output (`avoid-direct-json`).
      {
        files: ["examples/ripgrep/**"],
        rules: {
          "effect/imperative-loops": "off",
          "effect/prefer-option-over-null": "off",
          "effect/avoid-native-object-helpers": "off",
          "effect/prefer-match-over-switch": "off",
          "effect/avoid-direct-tag-checks": "off",
          "effect/avoid-direct-json": "off"
        }
      },
      // Build/test configs and the dist guard are evaluated in bare Node,
      // before any Effect runtime exists — there is no `Config` provider to
      // read from and no `FileSystem` service to call, so `process.env` and
      // `node:*` are the only things that work there. The Effect preset's
      // service rules have no satisfiable fix in these files.
      {
        files: ["vite.config.ts", "scripts/**", "examples/ripgrep/scripts/**"],
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
    // Type-aware rules run through the oxlint-tsgolint Vite+ bundles (patched
    // by `effect-tsgo patch --oxlint`, so the `effecttsgo/*` rules see types
    // too). `typeCheck` adds the compiler's own diagnostics; the one
    // tsconfig.json covers src, test, examples and bench, so it agrees with
    // the `check` task, which stays the gate of record.
    options: {
      typeAware: true,
      typeCheck: true
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
      "bench:drivers": bench("drivers"),
      "bench:jq": bench("jq"),
      "bench:downstream": bench("downstream"),
      "bench:zero-copy": bench("zero-copy")
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
    // The example packages' suites run with the library's: examples/ripgrep
    // checks its output against ripgrep's when `rg` is installed.
    include: ["test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
    ...(maxWorkers === undefined ? {} : { maxWorkers: Number(maxWorkers) }),
    coverage: {
      provider: "istanbul",
      // `json` writes coverage-final.json, the Istanbul map `fallow audit`
      // reads (`health.coverage` in .fallowrc.json).
      reporter: ["text-summary", "json-summary", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts", "examples/ripgrep/src/**/*.ts"],
      exclude: ["**/*.d.ts"],
      // Per glob, so the library's floor covers the library alone, as it did
      // before the example's sources were measured (a top-level threshold
      // counts every included file).
      thresholds: {
        "src/**/*.ts": { statements: 90, branches: 85, functions: 90, lines: 90 },
        "examples/ripgrep/src/**/*.ts": { statements: 80, branches: 70, functions: 80, lines: 80 }
      }
    }
  }
})
