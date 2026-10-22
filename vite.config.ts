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
        command: "vp test run --coverage",
        cache: { env: ["VITEST_MAX_WORKERS", "NODE_OPTIONS"], input: cacheInputs, output: ["coverage/**"] }
      },
      // Benchmarks: run by hand around a change to a hot path, never in CI
      // (their numbers depend on the machine).
      bench: bench("json"),
      "bench:native": bench("native"),
      "bench:stream": bench("stream"),
      "bench:gen": bench("gen"),
      "bench:syntax": bench("syntax")
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
      exclude: ["**/*.d.ts"]
    }
  }
})
