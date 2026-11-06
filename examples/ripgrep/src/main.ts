/**
 * The program: parses the command line, builds the matcher and the printer,
 * walks the paths and searches each file, and returns the exit status
 * (0: a match was found, 1: none, 2: an error occurred).
 *
 * @since 0.0.0
 */
import * as Fs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import type { Worker } from "node:worker_threads"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Cli from "./cli/args.ts"
import type { Args } from "./cli/args.ts"
import * as Help from "./cli/help.ts"
import * as Color from "./print/color.ts"
import * as Json from "./print/json.ts"
import { Output } from "./print/output.ts"
import type { FileEnd, Printer } from "./print/printer.ts"
import * as Printers from "./print/printer.ts"
import * as Standard from "./print/standard.ts"
import * as Summary from "./print/summary.ts"
import type * as Compile from "./regex/compile.ts"
import * as Input from "./search/input.ts"
import * as Parallel from "./parallel.ts"
import * as Pattern from "./search/pattern.ts"
import * as Searcher from "./search/searcher.ts"
import * as Glob from "./walk/glob.ts"
import * as Types from "./walk/types.ts"
import * as Walk from "./walk/walk.ts"
import * as Arr from "effect/Array"

/**
 * The process environment the program reads.
 *
 * @since 0.0.0
 */
export interface Environment {
  readonly argv: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
  readonly stdoutIsTty: boolean
  /** The file descriptor results are written to. */
  readonly stdout: number
  /** Writes a message to standard error. */
  readonly stderr: (message: string) => void
  /**
   * The worker module to search in parallel with (`src/worker.ts`, or the
   * bundle's), or `undefined` to search on this thread only.
   */
  readonly workerUrl: URL | undefined
  /** Standard input: whether it is a file or pipe (searched when no path is given), and its contents. */
  readonly stdin: { readonly readable: boolean; readonly read: () => Uint8Array }
}

const encoder = new TextEncoder()

/** Reads the configuration file named by `RIPGREP_CONFIG_PATH`. */
const configArgs = (env: Environment): ReadonlyArray<string> => {
  const file = env.env.RIPGREP_CONFIG_PATH
  if (file === undefined || file === "") return []
  try {
    return Cli.configArguments(Fs.readFileSync(file, "utf8"))
  } catch (error) {
    env.stderr(`erg: ${file}: ${Walk.describeError(error)}\n`)
    return []
  }
}

const parseArgs = (env: Environment): Args => {
  const cli = Cli.parseArgv(env.argv, Cli.defaults())
  if (cli.noConfig) return cli
  const fromConfig = configArgs(env)
  return Arr.isReadonlyArrayEmpty(fromConfig) ? cli : Cli.parseArgv([...fromConfig, ...env.argv], Cli.defaults())
}

const readPatternFile = (file: string, env: Environment): ReadonlyArray<string> => {
  const text =
    file === "-" ? new TextDecoder().decode(env.stdin.read()) : Fs.readFileSync(Path.resolve(env.cwd, file), "utf8")
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === "") lines.pop()
  return lines
}

const hostname = (args: Args): string => {
  if (args.hostnameBin === undefined) return Os.hostname()
  // Loaded on first use: most runs never start a process.
  const r = process.getBuiltinModule("node:child_process").spawnSync(args.hostnameBin, { encoding: "utf8" })
  return r.status === 0 ? r.stdout.trim() : Os.hostname()
}

/**
 * A printer and its output, with what goes between two files' output when
 * they are printed apart.
 *
 * @since 0.0.0
 */
export interface Plan {
  readonly printer: Printer
  readonly out: Output
  readonly separator: (separate: boolean) => string
}

const usesColor = (args: Args, env: Environment): boolean =>
  args.color === "always" ||
  args.color === "ansi" ||
  (args.color === "auto" && env.stdoutIsTty && env.env.TERM !== "dumb" && env.env.NO_COLOR === undefined)

type Colors = ReadonlyMap<Color.ColorTarget, Color.Spec> | undefined

/** What every printer needs to know about the run. */
interface PrintContext {
  readonly args: Args
  readonly env: Environment
  readonly colors: Colors
  readonly names: ReadonlyArray<string | undefined>
  readonly lineTerminator: number
  readonly withFilename: boolean
  readonly separateFiles: boolean
}

const summaryPrinter = (c: PrintContext, mode: Summary.SummaryOptions["mode"], out: Output): Printer => {
  const { args } = c
  return Summary.summaryPrinter(
    {
      mode,
      withFilename: c.withFilename,
      includeZero: args.includeZero,
      nullPath: args.nullPath,
      fieldMatchSeparator: args.fieldMatchSeparator,
      colors: c.colors,
      invert: args.invertMatch,
      quiet: args.quiet,
      stats: args.stats,
      lineTerminator: String.fromCharCode(c.lineTerminator)
    },
    out
  )
}

/** Whether context lines were asked for (`-A`, `-B`, `-C`). */
const hasContext = (args: Args): boolean =>
  (args.afterContext ?? args.context ?? 0) > 0 || (args.beforeContext ?? args.context ?? 0) > 0

const hyperlinkOf = (args: Args): { readonly format: string; readonly host: string } | undefined => {
  if (args.hyperlinkFormat === undefined) return undefined
  return { format: Color.hyperlinkAliases.get(args.hyperlinkFormat) ?? args.hyperlinkFormat, host: hostname(args) }
}

const standardOptions = (c: PrintContext): Standard.StandardOptions => {
  const { args, env } = c
  const column = args.column ?? args.vimgrep
  return {
    withFilename: c.withFilename,
    heading: !args.vimgrep && (args.heading ?? env.stdoutIsTty),
    lineNumber: args.vimgrep || (args.lineNumber ?? (env.stdoutIsTty || column)),
    column,
    byteOffset: args.byteOffset,
    onlyMatching: args.onlyMatching,
    vimgrep: args.vimgrep,
    replace: args.replace === undefined ? undefined : Printers.parseTemplate(args.replace, c.names),
    trim: args.trim,
    maxColumns: args.maxColumns,
    maxColumnsPreview: args.maxColumnsPreview,
    nullPath: args.nullPath,
    contextSeparator: args.contextSeparator,
    context: !args.passthru && hasContext(args),
    fieldMatchSeparator: args.fieldMatchSeparator,
    fieldContextSeparator: args.fieldContextSeparator,
    colors: c.colors,
    hyperlink: hyperlinkOf(args),
    lineTerminator: c.lineTerminator,
    invert: args.invertMatch,
    stats: args.stats,
    quiet: args.quiet,
    separateFiles: c.separateFiles
  }
}

const noSeparator = () => ""

const makePrinter = (c: Omit<PrintContext, "colors">): Result.Result<Plan, string> => {
  const { args, env } = c
  // A worker (separateFiles off) keeps its output in memory for the main thread.
  const fd = c.separateFiles ? env.stdout : -1
  const out = new Output(fd, args.blockBuffered === false || (args.blockBuffered === undefined && env.stdoutIsTty))
  // ripgrep checks --colors even when colours are off.
  const specs = Color.parseSpecs(args.colors)
  if (Predicate.isString(specs)) return Result.fail(`error parsing flag --colors: ${specs}`)
  const context = { ...c, colors: usesColor(args, env) ? specs : undefined }
  const mode = args.onlyMatching && args.mode === "count" ? "countMatches" : args.mode
  if (mode === "json") {
    const printer = Json.jsonPrinter({ lineNumber: args.lineNumber !== false, quiet: args.quiet }, out)
    return Result.succeed({ out, printer, separator: noSeparator })
  }
  if (mode !== "standard")
    return Result.succeed({ out, printer: summaryPrinter(context, mode, out), separator: noSeparator })
  const options = standardOptions(context)
  return Result.succeed({
    out,
    printer: Standard.standardPrinter(options, out),
    separator: (separate) => Standard.separator(options, separate)
  })
}

const displayPath = (path: string, args: Args): string =>
  args.pathSeparator === undefined ? path : path.replaceAll("/", args.pathSeparator)

/**
 * Collects errors: they are printed (unless `--no-messages`) and make the
 * exit status 2.
 *
 * @since 0.0.0
 */
class Reporter {
  hadError = false
  private readonly args: Args
  private readonly env: Environment
  constructor(args: Args, env: Environment) {
    this.args = args
    this.env = env
  }
  readonly report = (message: string): void => {
    this.hadError = true
    if (!this.args.noMessages) this.env.stderr(`erg: ${message}\n`)
  }
  readonly reportIgnore = (message: string): void => {
    if (!this.args.noMessages && !this.args.noIgnoreMessages) this.env.stderr(`erg: ${message}\n`)
  }
}

const walkOptions = (args: Args, env: Environment, reporter: Reporter): Result.Result<Walk.WalkOptions, string> =>
  Types.definitions(args.types).pipe(
    Result.flatMap((defs) => Types.filter(defs, args.types)),
    Result.flatMap((types) =>
      Result.map(Walk.buildOverrides(args, env.cwd), (overrides) => ({
        args,
        overrides,
        types,
        cwd: env.cwd,
        onError: reporter.report,
        onIgnoreError: reporter.reportIgnore
      }))
    )
  )

/** A file's contents, through `--pre` or `-z`, as UTF-8 (throws Node's I/O errors). */
const readEntry = (
  entry: Walk.Entry,
  args: Args,
  preGlobs: ReadonlyArray<Glob.Glob>,
  env: Environment
): Result.Result<Uint8Array, string> => {
  if (entry.stdin) return Result.succeed(Input.decode(env.stdin.read(), args.encoding))
  const name = encoder.encode(Path.basename(entry.path))
  const pre = Arr.isReadonlyArrayEmpty(preGlobs) || preGlobs.some((g) => g.matches(name)) ? args.pre : undefined
  const raw =
    pre === undefined ? Result.succeed(Input.readFile(entry.absolute)) : Input.preprocess(pre, entry.absolute, env.cwd)
  const bytes = args.searchZip && pre === undefined ? Result.flatMap(raw, (b) => Input.decompress(entry.path, b)) : raw
  return Result.map(bytes, (b) => Input.decode(b, args.encoding))
}

/** `-h`, `--help`, `-V`, `--pcre2-version`, `--generate` and `--type-list`: their exit status, or `undefined` to search. */
const special = (args: Args, env: Environment): number | undefined => {
  const say = (text: string) => {
    const out = new Output(env.stdout, false)
    out.text(text)
    out.flush()
    return 0
  }
  switch (args.special) {
    case "shortHelp":
      return say(Help.shortHelp())
    case "longHelp":
      return say(Help.longHelp())
    case "version":
      return say(Help.versionText())
    case "generate":
      return say(Help.generate(args.generate ?? "man"))
    case "pcre2Version":
      env.stderr("PCRE2 is not available in this build of ripgrep.\n")
      return 1
    case "typeList":
      return Result.match(Types.definitions(args.types), {
        onFailure: (message) => fail(env, message),
        onSuccess: (defs) => say(Types.list(defs))
      })
    default:
      return undefined
  }
}

/** Prints an error and returns exit status 2. */
const fail = (env: Environment, message: string): number => {
  env.stderr(`erg: ${message}\n`)
  return 2
}

/** Flags this build cannot honour. */
const unsupported = (args: Args): string | undefined =>
  args.pcre2 || args.engine === "pcre2"
    ? "PCRE2 is not available in this build of ripgrep."
    : Input.checkEncoding(args.encoding)

/**
 * The patterns (`-e`, `-f`, or the first positional) and the paths to search.
 *
 * @since 0.0.0
 */
export interface Inputs {
  readonly sources: ReadonlyArray<string>
  readonly roots: ReadonlyArray<string>
}

const inputs = (args: Args, env: Environment): Result.Result<Inputs, string> => {
  const positional = [...args.positional]
  const sources = [...args.patterns]
  try {
    for (const f of args.patternFiles) sources.push(...readPatternFile(f, env))
  } catch (error) {
    return Result.fail(Walk.describeError(error))
  }
  const filesMode = args.special === "files"
  if (!filesMode && Arr.isReadonlyArrayEmpty(args.patterns) && Arr.isReadonlyArrayEmpty(args.patternFiles)) {
    const first = positional.shift()
    if (first === undefined) return Result.fail("ripgrep requires at least one pattern to execute a search")
    sources.push(first)
  }
  // With no path, ripgrep searches standard input if it is a file or pipe,
  // and the current directory ("", printed without "./") otherwise.
  if (Arr.isReadonlyArrayNonEmpty(positional)) return Result.succeed({ sources, roots: positional })
  return Result.succeed({ sources, roots: !filesMode && env.stdin.readable ? ["-"] : [""] })
}

/** `--files`: the paths that would be searched. */
const listFiles = (
  args: Args,
  env: Environment,
  roots: ReadonlyArray<string>,
  options: Walk.WalkOptions,
  reporter: Reporter
): number => {
  const out = new Output(env.stdout, env.stdoutIsTty)
  let any = false
  Walk.walk(roots, options, (entry) => {
    if (entry.stdin) return
    any = true
    if (args.quiet) return
    out.text(displayPath(entry.path, args))
    out.text(args.nullPath ? "\0" : "\n")
    out.endLine()
  })
  out.flush()
  return reporter.hadError ? 2 : any ? 0 : 1
}

/** Whether to print file names by default: for more than one path, or any directory. */
const defaultWithFilename = (args: Args, env: Environment, roots: ReadonlyArray<string>): boolean =>
  args.withFilename ??
  (args.vimgrep ||
    roots.length > 1 ||
    roots.some((r) => r === "" || (r !== "-" && Walk.isDirectoryPath(Path.resolve(env.cwd, r)))))

const compileGlobs = (globs: ReadonlyArray<string>): Result.Result<ReadonlyArray<Glob.Glob>, string> => {
  const compiled: Array<Glob.Glob> = []
  for (const g of globs) {
    const glob = Glob.compileGlob(g, false)
    if (Result.isFailure(glob)) return Result.fail(glob.failure)
    compiled.push(glob.success)
  }
  return Result.succeed(compiled)
}

/** The context lines a mode prints: `[before, after]`, none for the summary modes and `--passthru`. */
const contextOf = (args: Args): readonly [number, number] => {
  const lines = (args.mode === "standard" || args.mode === "json") && !args.passthru
  return lines ? [args.beforeContext ?? args.context ?? 0, args.afterContext ?? args.context ?? 0] : [0, 0]
}

/** The most matching lines to look for: one when only whether a file matches counts (`--stats` needs them all). */
const maxCountOf = (args: Args): number | undefined => {
  const summaryStop = args.mode === "filesWithMatches" || args.mode === "filesWithoutMatch"
  return (args.quiet || summaryStop) && !args.stats ? 1 : args.maxCount
}

/** Whether binary detection may wait for a match (see `SearchOptions.lazyBinary`). */
const lazyBinaryOf = (args: Args): boolean =>
  !args.invertMatch && !args.passthru && !args.stats && args.mode !== "json" && args.mode !== "filesWithoutMatch"

/** How binary files are handled: with --null-data, NUL ends lines, so no file is binary. */
const binaryOf = (args: Args, explicit: boolean): Searcher.BinaryMode =>
  args.text || args.nullData ? "none" : explicit || args.binary ? "convert" : "quit"

/** The searcher's settings for explicit (named) and implicit (walked) files. */
const searchOptions = (args: Args, patterns: Pattern.Patterns, allMatches: boolean, lineNumbers: boolean) => {
  const [before, after] = contextOf(args)
  const make = (explicit: boolean): Searcher.SearchOptions => ({
    matcher: patterns.matcher,
    lineTerminator: patterns.lineTerminator,
    invert: args.invertMatch,
    maxCount: maxCountOf(args),
    before,
    after,
    passthru: args.passthru && (args.mode === "standard" || args.mode === "json"),
    stopOnNonmatch: args.stopOnNonmatch,
    allMatches,
    lineNumbers,
    lazyBinary: lazyBinaryOf(args),
    multiline: args.multiline,
    binary: binaryOf(args, explicit)
  })
  return { explicit: make(true), implicit: make(false) }
}

/**
 * What searching one file came to.
 *
 * @since 0.0.0
 */
export interface FileOutcome {
  readonly end: FileEnd
  readonly matches: number
  readonly matchedLines: number
  readonly bytesSearched: number
  readonly nanos: number
}

/**
 * Searches files one at a time into one printer: the main thread's search,
 * or a worker's.
 *
 * @since 0.0.0
 */
export class FileSearch {
  readonly args: Args
  readonly plan: Plan
  readonly reporter: Reporter
  private readonly env: Environment
  private readonly options: { readonly explicit: Searcher.SearchOptions; readonly implicit: Searcher.SearchOptions }
  private readonly matcher: Compile.Matcher
  private readonly preGlobs: ReadonlyArray<Glob.Glob>
  /** How expensive the search is per byte. */
  readonly cost: Compile.Cost

  constructor(setup: Setup, plan: Plan, patterns: Pattern.Patterns, preGlobs: ReadonlyArray<Glob.Glob>) {
    this.args = setup.args
    this.env = setup.env
    this.reporter = setup.reporter
    this.plan = plan
    this.matcher = patterns.matcher
    this.cost = patterns.matcher.cost
    this.options = searchOptions(setup.args, patterns, plan.printer.allMatches, plan.printer.lineNumbers)
    this.preGlobs = preGlobs
  }

  /** Searches one file into the printer; `undefined` when it could not be read. */
  file(entry: Walk.Entry): FileOutcome | undefined {
    let read: Result.Result<Uint8Array, string>
    try {
      read = readEntry(entry, this.args, this.preGlobs, this.env)
    } catch (error) {
      this.reporter.report(`${entry.path}: ${Walk.describeError(error)}`)
      return undefined
    }
    if (Result.isFailure(read)) {
      this.reporter.report(`${entry.path}: ${read.failure}`)
      return undefined
    }
    const filePrinter = this.plan.printer.file({ path: displayPath(entry.path, this.args), absolute: entry.absolute })
    const started = process.hrtime.bigint()
    const options = entry.explicit ? this.options.explicit : this.options.implicit
    const result = Searcher.search(read.success, options, filePrinter.sink)
    const overflow = this.matcher.takeOverflow()
    if (overflow !== undefined) {
      this.reporter.report(`${entry.path}: the pattern nested too deeply at byte offset ${overflow}`)
    }
    const nanos = Number(process.hrtime.bigint() - started)
    const end = filePrinter.end(result, result.bytesSearched, nanos)
    return {
      end,
      matches: result.matches,
      matchedLines: result.matchedLines,
      bytesSearched: result.bytesSearched,
      nanos
    }
  }
}

/** Adds one file's outcome to the totals. */
const count = (t: Printers.Totals, o: FileOutcome): void => {
  t.filesSearched++
  t.bytesSearched += o.bytesSearched
  t.searchNanos += o.nanos
  t.matches += o.matches
  t.matchedLines += o.matchedLines
  t.printed += o.end.printed
  if (o.matchedLines > 0) t.filesWithMatches++
}

/** The checked command line: what the main thread and every worker start from. */
interface Setup {
  readonly args: Args
  readonly env: Environment
  readonly given: Inputs
  readonly walk: Walk.WalkOptions
  readonly reporter: Reporter
}

/** Builds the matcher and printer for a search; `separateFiles` is off in workers (see `Standard.separator`). */
const fileSearch = (setup: Setup, separateFiles: boolean): Result.Result<FileSearch, string> => {
  const { args, env, given } = setup
  return Pattern.build(args, given.sources, Pattern.backend(env.env.ERG_COMPILER)).pipe(
    Result.flatMap((patterns) =>
      makePrinter({
        args,
        env,
        names: patterns.names,
        lineTerminator: patterns.lineTerminator,
        withFilename: defaultWithFilename(args, env, given.roots),
        separateFiles
      }).pipe(
        Result.flatMap((plan) =>
          Result.map(compileGlobs(args.preGlobs), (globs) => new FileSearch(setup, plan, patterns, globs))
        )
      )
    )
  )
}

/** The exit status: 0 for a match, 1 for none, 2 after an error. */
const status = (args: Args, reporter: Reporter, matchedAny: boolean): number => {
  if (reporter.hadError) return args.quiet && matchedAny ? 0 : 2
  return matchedAny ? 0 : 1
}

/** Searches the files `each` produces on this thread, printing as it goes; returns the exit status. */
const sequential = (search: FileSearch, each: (visit: (entry: Walk.Entry) => void) => void): number => {
  const { args, plan, reporter } = search
  const totals = Printers.totals()
  let matchedAny = false
  each((entry) => {
    if ((args.quiet && matchedAny && !args.stats) || plan.out.closed) return
    const outcome = search.file(entry)
    if (outcome === undefined) return
    count(totals, outcome)
    if (outcome.end.matched) matchedAny = true
  })
  plan.printer.finish(totals)
  plan.out.flush()
  return status(args, reporter, matchedAny)
}

/**
 * Roughly how fast one thread searches, in bytes per millisecond, for each
 * kind of matcher (measured on the benchmark corpus).
 */
const throughput: Record<Compile.Cost, number> = { literal: 1_500_000, literals: 300_000, regex: 150_000 }

/** Workers pay off when a search would take longer than this on one thread. */
const PARALLEL_MS = 150

/** The files a search will visit, and the input's total size. */
interface Collected {
  readonly entries: ReadonlyArray<Walk.Entry>
  readonly bytes: number
}

/**
 * The files to search, with the input's total size; `large` runs once, as
 * soon as the files seen so far hold more than `threshold` bytes.
 */
const collect = (setup: Setup, threshold: number, large: () => void): Collected => {
  const entries: Array<Walk.Entry> = []
  let bytes = 0
  let pending = true
  Walk.walk(setup.given.roots, setup.walk, (entry) => {
    entries.push(entry)
    if (!entry.stdin) bytes += Walk.sizeOf(entry.absolute)
    if (pending && bytes > threshold) {
      pending = false
      large()
    }
  })
  return { entries, bytes }
}

/**
 * How many workers to search with: none when the search would be quick on
 * this thread (workers take tens of milliseconds to start), else up to
 * {@link maxWorkers}.
 */
const workerCount = (args: Args, files: number, bytes: number, cost: Compile.Cost): number => {
  const estimate = bytes / throughput[cost]
  if (files < 2 || (args.threads <= 1 && estimate < PARALLEL_MS)) return 0
  return Math.min(maxWorkers(args), files, Math.max(1, Math.ceil(estimate / (PARALLEL_MS / 2))))
}

/**
 * The most workers a search uses: with `-j`, one fewer than it (this thread
 * searches too); otherwise half the cores. Each worker is a V8 isolate with
 * its own garbage collector and compiler threads, and on a 4-core machine
 * two workers beat three on every benchmark case (by up to 20%).
 */
const maxWorkers = (args: Args): number =>
  args.threads > 1 ? args.threads - 1 : Math.floor(Os.availableParallelism() / 2)

/**
 * Whether a search may use workers at all, known before the walk: it has a
 * directory to walk, and is not on one thread, sorted, or reading standard
 * input.
 */
const mayParallel = (setup: Setup): boolean =>
  setup.env.workerUrl !== undefined &&
  setup.args.sort === undefined &&
  setup.args.threads !== 1 &&
  maxWorkers(setup.args) > 0 &&
  !setup.given.roots.some((root) => root === "-") &&
  setup.given.roots.some((root) => root === "" || Walk.isDirectoryPath(Path.resolve(setup.env.cwd, root)))

/** Searches `roots`: in parallel when it is worth it, otherwise on this thread. */
const search = (setup: Setup): number | Promise<number> => {
  const built = fileSearch(setup, true)
  if (Result.isFailure(built)) return fail(setup.env, built.failure)
  const workerUrl = setup.env.workerUrl
  if (workerUrl === undefined || !mayParallel(setup)) {
    return sequential(built.success, (visit) => Walk.walk(setup.given.roots, setup.walk, visit))
  }
  const { env, given } = setup
  const data = { argv: env.argv, env: env.env, cwd: env.cwd, stdoutIsTty: env.stdoutIsTty, ...given }
  const cost = built.success.cost
  // Workers start as soon as the walk has found enough to search, so they
  // load while it finishes; with `-j`, before it starts.
  let spawned: ReadonlyArray<Worker> = []
  const threshold = setup.args.threads > 1 ? -1 : PARALLEL_MS * throughput[cost]
  const { bytes, entries } = collect(setup, threshold, () => {
    spawned = Parallel.spawn(workerUrl, data, maxWorkers(setup.args))
  })
  // Standard input is read here, once: such a search stays on this thread.
  const n = entries.some((e) => e.stdin) ? 0 : workerCount(setup.args, entries.length, bytes, cost)
  Parallel.stop(spawned.slice(n))
  if (n === 0) return sequential(built.success, (visit) => entries.forEach(visit))
  // None have started when the input came to exactly the threshold.
  const pool = Arr.isReadonlyArrayNonEmpty(spawned) ? spawned.slice(0, n) : Parallel.spawn(workerUrl, data, n)
  // This thread's own share prints into memory, like a worker's.
  const local = fileSearch(setup, false)
  if (Result.isFailure(local)) {
    Parallel.stop(pool)
    return fail(env, local.failure)
  }
  return Parallel.run(
    built.success,
    local.success,
    entries,
    {
      stderr: env.stderr,
      count,
      status: (matchedAny) => status(setup.args, setup.reporter, matchedAny)
    },
    Printers.totals(),
    pool
  )
}

/**
 * The search a worker runs: the main thread's command line, printed into
 * memory without the separators between files.
 *
 * @since 0.0.0
 */
export const workerSearch = (env: Environment, given: Inputs): Result.Result<FileSearch, string> => {
  const args = parseArgs(env)
  if (args.error !== undefined) return Result.fail(args.error)
  const reporter = new Reporter(args, env)
  return Result.flatMap(walkOptions(args, env, reporter), (walk) =>
    fileSearch({ args, env, given, walk, reporter }, false)
  )
}

/**
 * Runs the program and returns its exit status.
 *
 * @example
 * ```ts
 * import { main } from "./main.ts"
 *
 * const status = main({
 *   argv: ["-n", "TODO", "src"],
 *   env: process.env,
 *   cwd: process.cwd(),
 *   stdoutIsTty: false,
 *   stdout: 1,
 *   stderr: (m) => process.stderr.write(m),
 *   stdin: { readable: false, read: () => new Uint8Array() }
 * })
 * ```
 *
 * @since 0.0.0
 */
export const main = (env: Environment): number | Promise<number> => {
  const args = parseArgs(env)
  if (args.error !== undefined) return fail(env, args.error)
  const done = special(args, env)
  if (done !== undefined) return done
  const problem = unsupported(args)
  if (problem !== undefined) return fail(env, problem)
  const given = inputs(args, env)
  if (Result.isFailure(given)) return fail(env, given.failure)
  const reporter = new Reporter(args, env)
  const options = walkOptions(args, env, reporter)
  if (Result.isFailure(options)) return fail(env, options.failure)
  if (args.special === "files") return listFiles(args, env, given.success.roots, options.success, reporter)
  return search({ args, env, given: given.success, walk: options.success, reporter })
}
