/**
 * The `jq` example (`examples/jq.ts`, behind `examples/jq-cli.ts`) raced
 * against the real `jq` on a generated document of about 37 MB.
 *
 * For each filter it reports:
 *
 * - `jq`: the real jq's wall-clock time, process start included (a few
 *   milliseconds for a native binary).
 * - `cli`: the example CLI's wall-clock time: Node's start, loading Effect
 *   and `effect/cli`, reading, running and writing.
 * - `core`: the same CLI run's own `--timings`, read + run + write, with
 *   the parser compiled and run once, cold, as a CLI runs it: the
 *   comparison without the CLI's overhead.
 * - `warm`: `Jq.run` in this process, best of several runs, once the
 *   parser is compiled and V8 has optimised it.
 *
 * Every CLI run's output is compared with jq's. Each case runs a few
 * times, and the best time is reported. Needs `jq` on the PATH.
 *
 * Run with `vp run bench:jq`. `JQ_BENCH_ITEMS` sets the document's size
 * (default 100000 items), `JQ_BENCH_BACKENDS` the backends (default
 * `jit,wasm,closure,interpreted`), `JQ_BENCH_RUNS` the runs per case.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as Jq from "../examples/jq.ts"

const items = Number(process.env.JQ_BENCH_ITEMS ?? 100_000)
const runs = Number(process.env.JQ_BENCH_RUNS ?? 3)
const allBackends: ReadonlyArray<Jq.Backend> = ["jit", "wasm", "closure", "interpreted"]
const isBackend = (name: string): name is Jq.Backend => allBackends.some((b) => b === name)
const backends = (process.env.JQ_BENCH_BACKENDS ?? allBackends.join(",")).split(",").filter(isBackend)

try {
  execFileSync("jq", ["--version"])
} catch {
  console.error("jq is not on the PATH: install it to run this benchmark")
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), "jq-bench-"))
const file = join(dir, "data.json")
writeFileSync(
  file,
  JSON.stringify(
    Array.from({ length: items }, (_, i) => ({
      id: i,
      name: `item ${i}`,
      label: `élément nº${i} — 項目 😀`,
      tags: ["a", "b", "c"].slice(0, (i % 3) + 1),
      price: i * 1.25,
      active: i % 2 === 0,
      nested: { x: i, y: [1, 2, 3], z: null },
      desc: 'Lorem ipsum dolor sit amet, "quoted" \\ text\n'
    })),
    null,
    2
  )
)
const bytes = readFileSync(file)
console.log(
  `jq ${execFileSync("jq", ["--version"]).toString().trim()}, ${(bytes.length / 1e6).toFixed(1)} MB, best of ${runs}\n`
)

const cases: ReadonlyArray<readonly [string, ReadonlyArray<string>, string]> = [
  ["parse + pretty print", [], "."],
  ["parse + compact print", ["-c"], "."],
  ["length", [], "length"],
  ["select + project", ["-c"], ".[] | select(.active) | {id, name}"],
  ["sum a field", [], "map(.price) | add"],
  ["group_by", ["-c"], "group_by(.tags | length) | map({n: length, total: map(.id) | add})"],
  ["raw strings", ["-r"], ".[] | .label"]
]

const cli = fileURLToPath(new URL("../examples/jq-cli.ts", import.meta.url))
const decoder = new TextDecoder()

const time = (f: () => void): number => {
  const t = performance.now()
  f()
  return performance.now() - t
}
const best = (f: () => number): number => {
  let b = Infinity
  for (let i = 0; i < runs; i++) b = Math.min(b, f())
  return b
}
const ms = (n: number) => `${n.toFixed(0).padStart(6)} ms`
const ratio = (ours: number, theirs: number) => `${(ours / theirs).toFixed(2)}x`.padStart(6)

let mismatches = 0
for (const [name, flags, filter] of cases) {
  let expected = ""
  const jq = best(() =>
    time(() => {
      expected = execFileSync("jq", [...flags, filter, file], { maxBuffer: 1 << 30 }).toString()
    })
  )
  console.log(`${name}: jq ${flags.join(" ")} '${filter}'`)
  console.log(`  ${"jq".padEnd(12)} ${ms(jq)}`)
  const program = Jq.compile(filter)
  const options: Jq.Options = { compact: flags.includes("-c"), raw: flags.includes("-r") }
  for (const backend of backends) {
    let core = Infinity
    const wall = best(() =>
      time(() => {
        const r = spawnSync(
          process.execPath,
          [
            "--experimental-strip-types",
            "--no-warnings",
            cli,
            "--timings",
            "--backend",
            backend,
            ...flags,
            filter,
            file
          ],
          { maxBuffer: 1 << 30 }
        )
        if (r.stdout.toString() !== expected) {
          mismatches++
          console.log(`  ${backend}: output differs from jq's`)
        }
        const t = /read ([\d.]+) ms, run ([\d.]+) ms, write ([\d.]+) ms/.exec(r.stderr.toString())
        if (t !== null) core = Math.min(core, Number(t[1]) + Number(t[2]) + Number(t[3]))
      })
    )
    const warm = best(() => time(() => Jq.run(program, decoder.decode(bytes), { ...options, backend })))
    console.log(
      `  ${backend.padEnd(12)} cli ${ms(wall)} ${ratio(wall, jq)}   core ${ms(core)} ${ratio(core, jq)}   warm ${ms(warm)} ${ratio(warm, jq)}`
    )
  }
}

rmSync(dir, { recursive: true, force: true })
if (mismatches > 0) {
  console.error(`\n${mismatches} runs printed something other than jq`)
  process.exitCode = 1
}
