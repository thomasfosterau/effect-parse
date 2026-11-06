/**
 * Benchmarks `erg` (ripgrep's interface, matching with effect-parse)
 * against ripgrep, GNU grep and whichever other search tools are installed
 * (`ugrep`, `ag`, `git grep`), on a generated corpus or on a directory you
 * name. Every `erg` result is checked against ripgrep's output first, so a
 * time is only reported for a correct answer.
 *
 * ```sh
 * node bench/compare.ts              # bundles erg, then a 12 MB corpus, 5 runs per case
 * node bench/compare.ts --files 800 --lines 4000 --runs 10
 * node bench/compare.ts --corpus ~/src/linux --cases literal,word
 * node bench/compare.ts --backends jit,closure,none --json results.json
 * ```
 *
 * @since 0.0.0
 */
import * as ChildProcess from "node:child_process"
import * as Fs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import { parseArgs } from "node:util"
import * as Arr from "effect/Array"
import * as Order from "effect/Order"
import * as Corpus from "./corpus.ts"
import * as Differential from "./differential.ts"

interface Case {
  readonly name: string
  /** Arguments for ripgrep and erg (the search path is appended). */
  readonly rg: ReadonlyArray<string>
  /** Arguments for GNU grep, or undefined when it has no equivalent. */
  readonly grep: ReadonlyArray<string> | undefined
  /** Arguments for ugrep, which reads ignore files with `--ignore-files`. */
  readonly ugrep?: ReadonlyArray<string> | undefined
  /** Arguments for the silver searcher. */
  readonly ag?: ReadonlyArray<string> | undefined
}

const cases: ReadonlyArray<Case> = [
  { name: "literal", rg: ["-n", "Sherlock"], grep: ["-rn", "Sherlock"], ugrep: ["-rn", "Sherlock"], ag: ["Sherlock"] },
  {
    name: "literal-count",
    rg: ["-c", "parser"],
    grep: ["-rc", "parser"],
    ugrep: ["-rc", "parser"],
    ag: ["-c", "parser"]
  },
  {
    name: "ignore-case",
    rg: ["-n", "-i", "sherlock holmes"],
    grep: ["-rni", "sherlock holmes"],
    ugrep: ["-rni", "sherlock holmes"],
    ag: ["-i", "sherlock holmes"]
  },
  { name: "word", rg: ["-n", "-w", "match"], grep: ["-rnw", "match"], ugrep: ["-rnw", "match"], ag: ["-w", "match"] },
  {
    name: "alternation",
    rg: ["-c", "Sherlock|Watson|Moriarty|Baker"],
    grep: ["-rcE", "Sherlock|Watson|Moriarty|Baker"],
    ugrep: ["-rc", "Sherlock|Watson|Moriarty|Baker"],
    ag: ["-c", "Sherlock|Watson|Moriarty|Baker"]
  },
  {
    name: "class-repeat",
    rg: ["-o", "[a-z]+@[a-z]+\\.com"],
    grep: ["-roE", "[a-z]+@[a-z]+\\.com"],
    ugrep: ["-ro", "[a-z]+@[a-z]+\\.com"],
    ag: ["-o", "[a-z]+@[a-z]+\\.com"]
  },
  {
    name: "unicode-class",
    rg: ["-c", "\\p{Greek}+"],
    grep: ["-rcP", "\\p{Greek}+"],
    ugrep: ["-rc", "\\p{Greek}+"],
    ag: ["-c", "\\p{Greek}+"]
  },
  {
    name: "word-chars",
    rg: ["-c", "\\w+_\\w+\\(\\d+\\)"],
    grep: ["-rcE", "[[:alnum:]_]+_[[:alnum:]_]+\\([0-9]+\\)"],
    ugrep: ["-rc", "\\w+_\\w+\\(\\d+\\)"]
  },
  {
    name: "no-match",
    rg: ["-c", "zzzzqqqq"],
    grep: ["-rc", "zzzzqqqq"],
    ugrep: ["-rc", "zzzzqqqq"],
    ag: ["-c", "zzzzqqqq"]
  },
  { name: "invert-count", rg: ["-v", "-c", "e"], grep: ["-rvc", "e"], ugrep: ["-rvc", "e"] },
  {
    name: "files-with-matches",
    rg: ["-l", "FIXME"],
    grep: ["-rl", "FIXME"],
    ugrep: ["-rl", "FIXME"],
    ag: ["-l", "FIXME"]
  },
  {
    name: "context",
    rg: ["-n", "-C2", "Moriarty"],
    grep: ["-rn", "-C2", "Moriarty"],
    ugrep: ["-rn", "-C2", "Moriarty"],
    ag: ["-C2", "Moriarty"]
  }
]

const { values: options } = parseArgs({
  options: {
    files: { type: "string", default: "300" },
    lines: { type: "string", default: "1500" },
    seed: { type: "string", default: "1" },
    runs: { type: "string", default: "5" },
    corpus: { type: "string" },
    cases: { type: "string" },
    tools: { type: "string" },
    backends: { type: "string", default: "jit,closure" },
    json: { type: "string" },
    "no-verify": { type: "boolean", default: false }
  }
})

const runs = Number(options.runs)

// erg is timed as the bundle, which loads as one module.
ChildProcess.execFileSync(process.execPath, [Path.join(import.meta.dirname, "..", "scripts", "bundle.mjs")], {
  stdio: "inherit"
})
const which = (tool: string): boolean => ChildProcess.spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0

const root =
  options.corpus === undefined
    ? Corpus.write(Path.join(Os.tmpdir(), "erg-bench-corpus"), {
        files: Number(options.files),
        lines: Number(options.lines),
        seed: Number(options.seed)
      })
    : Path.resolve(options.corpus)

const corpusBytes = (dir: string): number => {
  let total = 0
  for (const entry of Fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += Fs.statSync(Path.join(entry.parentPath, entry.name)).size
  }
  return total
}

interface Tool {
  readonly name: string
  readonly command: string
  readonly args: (c: Case) => ReadonlyArray<string> | undefined
  readonly env?: Record<string, string>
}

const backends = options.backends.split(",").filter((b) => b !== "")
const ripgrep: Tool = { name: "rg", command: "rg", args: (c) => c.rg }
const tools: Array<Tool> = [ripgrep]
for (const backend of backends) {
  tools.push({
    name: `erg (${backend})`,
    command: process.execPath,
    args: (c) => [Differential.ergBin, ...c.rg],
    env: { ERG_COMPILER: backend }
  })
}
if (which("grep")) tools.push({ name: "grep", command: "grep", args: (c) => c.grep })
if (which("ugrep"))
  tools.push({
    name: "ugrep",
    command: "ugrep",
    args: (c) => (c.ugrep === undefined ? undefined : ["--ignore-files", ...c.ugrep])
  })
if (which("ag")) tools.push({ name: "ag", command: "ag", args: (c) => c.ag })
if (which("git") && Fs.existsSync(Path.join(root, ".git", "HEAD"))) {
  tools.push({
    name: "git grep",
    command: "git",
    args: (c) => (c.grep === undefined ? undefined : ["grep", ...c.grep.map((a) => a.replace(/^-r/, "-"))])
  })
}

const selectedTools =
  options.tools === undefined
    ? tools
    : tools.filter((t) => (options.tools ?? "").split(",").some((n) => t.name.startsWith(n)))
const selectedCases =
  options.cases === undefined ? cases : cases.filter((c) => (options.cases ?? "").split(",").includes(c.name))

interface Timing {
  readonly ms: number
  readonly stdout: string
  readonly status: number | null
}

const time = (tool: Tool, args: ReadonlyArray<string>): Timing => {
  const start = process.hrtime.bigint()
  const r = ChildProcess.spawnSync(tool.command, [...args, "."], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, RIPGREP_CONFIG_PATH: "", ...tool.env },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1 << 30
  })
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, stdout: r.stdout, status: r.status }
}

const median = (xs: ReadonlyArray<number>): number => {
  const s = Arr.sort(xs, Order.Number)
  return s[Math.floor(s.length / 2)]
}

interface Row {
  readonly case: string
  readonly tool: string
  readonly medianMs: number
  readonly minMs: number
  readonly verified: boolean | undefined
}

const rows: Array<Row> = []
const size = corpusBytes(root)
process.stdout.write(
  `corpus: ${root} (${(size / 1e6).toFixed(1)} MB), ${runs} runs per case, node ${process.version}\n\n`
)

for (const c of selectedCases) {
  const reference = Differential.sortLines(time(ripgrep, c.rg).stdout)
  for (const tool of selectedTools) {
    const args = tool.args(c)
    if (args === undefined) continue
    const first = time(tool, args)
    const verified =
      tool.name.startsWith("erg") && !options["no-verify"]
        ? Differential.sortLines(first.stdout) === reference
        : undefined
    const samples: Array<number> = []
    for (let i = 0; i < runs; i++) samples.push(time(tool, args).ms)
    const row = { case: c.name, tool: tool.name, medianMs: median(samples), minMs: Math.min(...samples), verified }
    rows.push(row)
    process.stderr.write(
      `  ${c.name.padEnd(20)} ${tool.name.padEnd(16)} ${row.medianMs.toFixed(1).padStart(9)} ms${verified === false ? "  OUTPUT DIFFERS FROM rg" : ""}\n`
    )
  }
}

const toolNames = selectedTools.map((t) => t.name).filter((n) => rows.some((r) => r.tool === n))
const header = `| case | ${toolNames.join(" | ")} |`
const rule = `| --- | ${toolNames.map(() => "---:").join(" | ")} |`
const lines = [header, rule]
/** The ratio of a time to rg's, as ` (n×)`, or nothing for rg itself. */
const ratio = (r: Row, base: Row | undefined): string =>
  base === undefined || r.tool === "rg" ? "" : ` (${(r.medianMs / base.medianMs).toFixed(1)}×)`

const cell = (r: Row | undefined, base: Row | undefined): string =>
  r === undefined ? "—" : `${r.medianMs.toFixed(1)} ms${ratio(r, base)}${r.verified === false ? " ✗" : ""}`

for (const c of selectedCases) {
  const base = rows.find((r) => r.case === c.name && r.tool === "rg")
  const cells = toolNames.map((n) =>
    cell(
      rows.find((x) => x.case === c.name && x.tool === n),
      base
    )
  )
  lines.push(`| ${c.name} | ${cells.join(" | ")} |`)
}
process.stdout.write(
  `\n${lines.join("\n")}\n\nMedian wall time per run, including process start-up; (n×) is relative to rg. ✗ marks erg output that differs from rg's.\n`
)
if (options.json !== undefined)
  Fs.writeFileSync(options.json, JSON.stringify({ root, bytes: size, runs, rows }, null, 2))
if (rows.some((r) => r.verified === false)) process.exitCode = 1
