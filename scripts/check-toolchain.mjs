// Checks the catalog entries that must equal what `vite-plus` pins (Dependabot
// cannot move the `vite` npm alias); `--fix` rewrites them, then `pnpm install`.
import { readFile, writeFile } from "node:fs/promises"

const workspaceUrl = new URL("../pnpm-workspace.yaml", import.meta.url)
const workspace = await readFile(workspaceUrl, "utf8")
const vitePlus = JSON.parse(await readFile(new URL("../node_modules/vite-plus/package.json", import.meta.url), "utf8"))

/** The catalog line of `name` (top-level `catalog:` entries are indented two spaces). */
const entry = (name) => new RegExp(`^  ("?)${name.replace(/[/@.]/g, "\\$&")}\\1: (.+)$`, "m")

const expected = [
  // vite-plus depends on `vite` as this alias; the override forces every
  // `vite` to the catalog's, so it must be the same release
  ["vite", vitePlus.dependencies.vite],
  ["vitest", vitePlus.dependencies.vitest],
  // vite-plus refuses to run coverage when this differs from its vitest
  ["@vitest/coverage-istanbul", vitePlus.dependencies.vitest]
]

const catalogVitePlus = workspace.match(entry("vite-plus"))?.[2]
if (catalogVitePlus !== vitePlus.version) {
  console.error(
    `node_modules has vite-plus ${vitePlus.version}, the catalog ${catalogVitePlus}: run \`pnpm install\` first`
  )
  process.exit(1)
}

const fix = process.argv.includes("--fix")
let fixed = workspace
let drift = 0
for (const [name, want] of expected) {
  const match = fixed.match(entry(name))
  if (match === null) {
    console.error(`catalog: no \`${name}\` entry`)
    drift++
    continue
  }
  if (match[2] === want) {
    console.log(`ok: ${name} ${want}`)
    continue
  }
  drift++
  console.error(`catalog: \`${name}: ${match[2]}\` must be \`${want}\`, to match vite-plus ${vitePlus.version}`)
  fixed = fixed.replace(entry(name), `  $1${name}$1: ${want}`)
}

if (drift > 0 && fix) {
  await writeFile(workspaceUrl, fixed)
  console.error("Rewrote pnpm-workspace.yaml; run `pnpm install` and commit pnpm-lock.yaml with it.")
} else if (drift > 0) {
  console.error("Fix with `node scripts/check-toolchain.mjs --fix && pnpm install`.")
}
process.exit(drift > 0 && !fix ? 1 : 0)
