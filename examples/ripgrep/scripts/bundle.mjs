/**
 * Bundles `erg` into one JavaScript module, `dist/erg.mjs`: effect-parse
 * (from its sources), the parts of `effect` it uses, and the CLI. Node then
 * loads one file with no type stripping, and its compile cache keeps the
 * compiled code between runs, which takes most of the start-up time away.
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { build } from "rolldown"

const here = (path) => fileURLToPath(new URL(path, import.meta.url))

await build({
  input: here("../bin/erg.ts"),
  platform: "node",
  resolve: {
    alias: { "@thomasfosterau/effect-parse": here("../../../src/index.ts") }
  },
  output: {
    file: here("../dist/erg-bundle.mjs"),
    format: "esm",
    // ERG_NO_MINIFY=1 keeps names, for profiling.
    minify: process.env.ERG_NO_MINIFY !== "1"
  },
  logLevel: "warn"
})

// The launcher turns on Node's compile cache (22.1+) before it loads the
// bundle, so the bundle's compiled code is kept between runs.
writeFileSync(
  here("../dist/erg.mjs"),
  '#!/usr/bin/env node\nimport { enableCompileCache } from "node:module"\nenableCompileCache?.()\nawait import("./erg-bundle.mjs")\n',
  { mode: 0o755 }
)
