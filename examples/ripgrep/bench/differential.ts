/**
 * Runs one command line through ripgrep and through `erg`, and compares
 * their standard output and exit status.
 *
 * @since 0.0.0
 */
import * as ChildProcess from "node:child_process"
import * as Path from "node:path"
import * as Arr from "effect/Array"
import * as Order from "effect/Order"

/**
 * The `erg` entry point the benchmarks time: the bundle `scripts/bundle.mjs`
 * builds (one module, no type stripping, compile cache on).
 *
 * @since 0.0.0
 */
export const ergBin = Path.join(import.meta.dirname, "..", "dist", "erg.mjs")

/**
 * What a run produced.
 *
 * @since 0.0.0
 */
export interface Run {
  readonly stdout: string
  readonly stderr: string
  readonly status: number | null
}

/**
 * Runs a program with arguments in `cwd`, standard input closed (so neither
 * tool searches stdin unless told to), and colours off by default.
 *
 * @since 0.0.0
 */
const run = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string> = {},
  input?: string
): Run => {
  const r = ChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, RIPGREP_CONFIG_PATH: "", ...env },
    input: input ?? "",
    stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    maxBuffer: 1 << 30
  })
  return { stdout: r.stdout, stderr: r.stderr, status: r.status }
}

/**
 * Runs ripgrep.
 *
 * @since 0.0.0
 */
export const rg = (args: ReadonlyArray<string>, cwd: string, env: Record<string, string> = {}, input?: string): Run =>
  run("rg", args, cwd, env, input)

/**
 * Whether ripgrep 14.1, the release `erg` implements, is installed. Other
 * releases print some things differently, so the comparisons skip them.
 *
 * @since 0.0.0
 */
export const hasRipgrep = (): boolean => {
  const r = ChildProcess.spawnSync("rg", ["--version"], { encoding: "utf8" })
  return r.status === 0 && r.stdout.startsWith("ripgrep 14.1.")
}

/**
 * Replaces the timings in `--json` and `--stats` output, which differ on
 * every run.
 *
 * @since 0.0.0
 */
export const normalizeTimings = (out: string): string =>
  out.replaceAll(/"elapsed(_total)?":\{[^}]*\}/g, '"elapsed$1":{}').replaceAll(/^\d+\.\d+ seconds/gm, "N seconds")

/**
 * Sorts output lines, for runs whose file order is not fixed (ripgrep
 * searches in parallel unless `--sort` is given).
 *
 * @since 0.0.0
 */
export const sortLines = (out: string): string => Arr.sort(out.split("\n"), Order.String).join("\n")
