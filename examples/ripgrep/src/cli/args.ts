import * as Str from "effect/String"

/**
 * ripgrep's command line: every flag of ripgrep 14.1, with its short form,
 * negation (`--no-…`) and aliases, parsed into {@link Args}.
 *
 * Parsing follows ripgrep: short flags cluster (`-inw`), a short flag's
 * value may be attached (`-A3`, `-efoo`) or the next argument, a long flag's
 * value is `--flag=value` or the next argument, `--` ends the flags, and a
 * later flag overrides an earlier one. Flags that ripgrep accepts but that
 * cannot change this implementation's output (`--mmap`, `--threads`, the
 * regex size limits, ...) are accepted and recorded.
 *
 * @since 0.0.0
 */

/**
 * How case is handled.
 *
 * @since 0.0.0
 */
export type CaseMode = "sensitive" | "insensitive" | "smart"

/**
 * When to colour output.
 *
 * @since 0.0.0
 */
export type ColorChoice = "never" | "auto" | "always" | "ansi"

/**
 * The output mode: matching lines, or one of the summaries.
 *
 * @since 0.0.0
 */
export type OutputMode = "standard" | "count" | "countMatches" | "filesWithMatches" | "filesWithoutMatch" | "json"

/**
 * What `--sort` / `--sortr` sorts by.
 *
 * @since 0.0.0
 */
export type SortBy = "none" | "path" | "modified" | "accessed" | "created"

/**
 * A `-t`, `-T`, `--type-add` or `--type-clear` instruction, applied in order.
 *
 * @since 0.0.0
 */
export interface TypeRule {
  readonly kind: "select" | "negate" | "add" | "clear"
  readonly value: string
}

/**
 * A `-g` / `--iglob` glob.
 *
 * @since 0.0.0
 */
export interface GlobRule {
  readonly glob: string
  readonly caseInsensitive: boolean
}

/**
 * What the program was asked to do, other than search.
 *
 * @since 0.0.0
 */
export type Special = "none" | "shortHelp" | "longHelp" | "version" | "pcre2Version" | "typeList" | "files" | "generate"

/**
 * The parsed command line.
 *
 * @since 0.0.0
 */
export interface Args {
  // Input
  patterns: Array<string>
  patternFiles: Array<string>
  positional: Array<string>
  pre: string | undefined
  preGlobs: Array<string>
  searchZip: boolean
  // Search
  caseMode: CaseMode
  crlf: boolean
  dfaSizeLimit: string | undefined
  encoding: string | undefined
  engine: string
  fixedStrings: boolean
  invertMatch: boolean
  lineRegexp: boolean
  maxCount: number | undefined
  mmap: boolean
  multiline: boolean
  multilineDotall: boolean
  unicode: boolean
  nullData: boolean
  pcre2: boolean
  pcre2Unicode: boolean
  autoHybridRegex: boolean
  regexSizeLimit: string | undefined
  stopOnNonmatch: boolean
  text: boolean
  threads: number
  wordRegexp: boolean
  // Filter
  binary: boolean
  follow: boolean
  globs: Array<GlobRule>
  globCaseInsensitive: boolean
  hidden: boolean
  ignoreFiles: Array<string>
  ignoreFileCaseInsensitive: boolean
  maxDepth: number | undefined
  maxFilesize: number | undefined
  noIgnore: boolean
  noIgnoreDot: boolean
  noIgnoreExclude: boolean
  noIgnoreFiles: boolean
  noIgnoreGlobal: boolean
  noIgnoreParent: boolean
  noIgnoreVcs: boolean
  noRequireGit: boolean
  oneFileSystem: boolean
  types: Array<TypeRule>
  unrestricted: number
  // Output
  afterContext: number | undefined
  beforeContext: number | undefined
  context: number | undefined
  blockBuffered: boolean | undefined
  byteOffset: boolean
  color: ColorChoice
  colors: Array<string>
  column: boolean | undefined
  contextSeparator: string | undefined
  fieldContextSeparator: string
  fieldMatchSeparator: string
  heading: boolean | undefined
  hostnameBin: string | undefined
  hyperlinkFormat: string | undefined
  includeZero: boolean
  lineNumber: boolean | undefined
  maxColumns: number | undefined
  maxColumnsPreview: boolean
  nullPath: boolean
  onlyMatching: boolean
  pathSeparator: string | undefined
  passthru: boolean
  quiet: boolean
  replace: string | undefined
  sort: { readonly by: SortBy; readonly reverse: boolean } | undefined
  trim: boolean
  vimgrep: boolean
  withFilename: boolean | undefined
  // Modes
  mode: OutputMode
  // Logging
  debug: boolean
  trace: boolean
  noIgnoreMessages: boolean
  noMessages: boolean
  stats: boolean
  // Other
  special: Special
  generate: string | undefined
  noConfig: boolean
  /** The first problem with the command line, if any. */
  error: string | undefined
}

/**
 * The defaults: ripgrep's behaviour with no flags.
 *
 * @since 0.0.0
 */
export const defaults = (): Args => ({
  patterns: [],
  patternFiles: [],
  positional: [],
  pre: undefined,
  preGlobs: [],
  searchZip: false,
  caseMode: "sensitive",
  crlf: false,
  dfaSizeLimit: undefined,
  encoding: undefined,
  engine: "default",
  fixedStrings: false,
  invertMatch: false,
  lineRegexp: false,
  maxCount: undefined,
  mmap: false,
  multiline: false,
  multilineDotall: false,
  unicode: true,
  nullData: false,
  pcre2: false,
  pcre2Unicode: true,
  autoHybridRegex: false,
  regexSizeLimit: undefined,
  stopOnNonmatch: false,
  text: false,
  threads: 0,
  wordRegexp: false,
  binary: false,
  follow: false,
  globs: [],
  globCaseInsensitive: false,
  hidden: false,
  ignoreFiles: [],
  ignoreFileCaseInsensitive: false,
  maxDepth: undefined,
  maxFilesize: undefined,
  noIgnore: false,
  noIgnoreDot: false,
  noIgnoreExclude: false,
  noIgnoreFiles: false,
  noIgnoreGlobal: false,
  noIgnoreParent: false,
  noIgnoreVcs: false,
  noRequireGit: false,
  oneFileSystem: false,
  types: [],
  unrestricted: 0,
  afterContext: undefined,
  beforeContext: undefined,
  context: undefined,
  blockBuffered: undefined,
  byteOffset: false,
  color: "auto",
  colors: [],
  column: undefined,
  contextSeparator: "--",
  fieldContextSeparator: "-",
  fieldMatchSeparator: ":",
  heading: undefined,
  hostnameBin: undefined,
  hyperlinkFormat: undefined,
  includeZero: false,
  lineNumber: undefined,
  maxColumns: undefined,
  maxColumnsPreview: false,
  nullPath: false,
  onlyMatching: false,
  pathSeparator: undefined,
  passthru: false,
  quiet: false,
  replace: undefined,
  sort: undefined,
  trim: false,
  vimgrep: false,
  withFilename: undefined,
  mode: "standard",
  debug: false,
  trace: false,
  noIgnoreMessages: false,
  noMessages: false,
  stats: false,
  special: "none",
  generate: undefined,
  noConfig: false,
  error: undefined
})

/**
 * Records a malformed command line on `args` (the first problem wins, in
 * ripgrep's wording); the parser stops at it.
 */
const usage = (args: Args, message: string): void => {
  args.error ??= message
}

/**
 * The help category a flag is listed under.
 *
 * @since 0.0.0
 */
export type Category = "input" | "search" | "filter" | "output" | "modes" | "logging" | "other"

/**
 * A flag definition.
 *
 * @since 0.0.0
 */
export interface Flag {
  readonly long: string
  readonly short?: string | undefined
  /** The value's name in help output; absent for a switch. */
  readonly value?: string | undefined
  /** The `--no-…` (or positive) flag that undoes this one. */
  readonly negated?: string | undefined
  readonly aliases?: ReadonlyArray<string> | undefined
  readonly category: Category
  readonly doc: string
  /** Applies the flag (`value` is `""` for a switch). */
  readonly apply: (args: Args, value: string) => void
  /** Applies the negation. */
  readonly negate?: ((args: Args) => void) | undefined
}

const number = (args: Args, flag: string, value: string): number => {
  if (!/^\d+$/.test(value)) usage(args, `failed to parse ${flag} value '${value}' as a number`)
  return Number(value)
}

const sizeSuffixes: ReadonlyMap<string, number> = new Map([
  ["", 1],
  ["K", 1024],
  ["M", 1024 ** 2],
  ["G", 1024 ** 3]
])

const size = (args: Args, flag: string, value: string): number => {
  const m = /^(\d+)([KMG]?)$/i.exec(value)
  if (m === null) {
    usage(args, `invalid ${flag} value '${value}'`)
    return 0
  }
  return Number(m[1]) * (sizeSuffixes.get((m[2] ?? "").toUpperCase()) ?? 1)
}

const oneOf = <T extends string>(args: Args, flag: string, value: string, choices: readonly [T, ...Array<T>]): T => {
  const found = choices.find((c) => c === value)
  if (found === undefined) {
    usage(args, `invalid value '${value}' for ${flag}: choose from ${choices.join(", ")}`)
    return choices[0]
  }
  return found
}

const sorts: readonly [SortBy, ...Array<SortBy>] = ["none", "path", "modified", "accessed", "created"]

/**
 * Every flag ripgrep 14.1 accepts.
 *
 * @since 0.0.0
 */
export const flags: ReadonlyArray<Flag> = [
  // ---- Input ----------------------------------------------------------------
  {
    long: "regexp",
    short: "e",
    value: "PATTERN",
    category: "input",
    doc: "A pattern to search for.",
    apply: (a, v) => a.patterns.push(v)
  },
  {
    long: "file",
    short: "f",
    value: "PATTERNFILE",
    category: "input",
    doc: "Search for patterns from the given file.",
    apply: (a, v) => a.patternFiles.push(v)
  },
  {
    long: "pre",
    value: "COMMAND",
    negated: "no-pre",
    category: "input",
    doc: "Search output of COMMAND for each PATH.",
    apply: (a, v) => (a.pre = v === "" ? undefined : v),
    negate: (a) => (a.pre = undefined)
  },
  {
    long: "pre-glob",
    value: "GLOB",
    category: "input",
    doc: "Include or exclude files from a preprocessor.",
    apply: (a, v) => a.preGlobs.push(v)
  },
  {
    long: "search-zip",
    short: "z",
    negated: "no-search-zip",
    category: "input",
    doc: "Search in compressed files.",
    apply: (a) => (a.searchZip = true),
    negate: (a) => (a.searchZip = false)
  },
  // ---- Search ---------------------------------------------------------------
  {
    long: "case-sensitive",
    short: "s",
    category: "search",
    doc: "Search case sensitively (default).",
    apply: (a) => (a.caseMode = "sensitive")
  },
  {
    long: "crlf",
    negated: "no-crlf",
    category: "search",
    doc: "Use CRLF line terminators (nice for Windows).",
    apply: (a) => (a.crlf = true),
    negate: (a) => (a.crlf = false)
  },
  {
    long: "dfa-size-limit",
    value: "NUM",
    category: "search",
    doc: "The upper size limit of the regex DFA.",
    apply: (a, v) => {
      size(a, "--dfa-size-limit", v)
      a.dfaSizeLimit = v
    }
  },
  {
    long: "encoding",
    short: "E",
    value: "ENCODING",
    negated: "no-encoding",
    category: "search",
    doc: "Specify the text encoding of files to search.",
    apply: (a, v) => (a.encoding = v),
    negate: (a) => (a.encoding = undefined)
  },
  {
    long: "engine",
    value: "ENGINE",
    category: "search",
    doc: "Specify which regex engine to use.",
    apply: (a, v) => (a.engine = oneOf(a, "--engine", v, ["default", "pcre2", "auto"]))
  },
  {
    long: "fixed-strings",
    short: "F",
    negated: "no-fixed-strings",
    category: "search",
    doc: "Treat all patterns as literals.",
    apply: (a) => (a.fixedStrings = true),
    negate: (a) => (a.fixedStrings = false)
  },
  {
    long: "ignore-case",
    short: "i",
    category: "search",
    doc: "Case insensitive search.",
    apply: (a) => (a.caseMode = "insensitive")
  },
  {
    long: "invert-match",
    short: "v",
    negated: "no-invert-match",
    category: "search",
    doc: "Invert matching.",
    apply: (a) => (a.invertMatch = true),
    negate: (a) => (a.invertMatch = false)
  },
  {
    long: "line-regexp",
    short: "x",
    category: "search",
    doc: "Show matches surrounded by line boundaries.",
    apply: (a) => {
      a.lineRegexp = true
      a.wordRegexp = false
    }
  },
  {
    long: "max-count",
    short: "m",
    value: "NUM",
    category: "search",
    doc: "Limit the number of matching lines.",
    apply: (a, v) => (a.maxCount = number(a, "--max-count", v))
  },
  {
    long: "mmap",
    negated: "no-mmap",
    category: "search",
    doc: "Search with memory maps when possible.",
    apply: (a) => (a.mmap = true),
    negate: (a) => (a.mmap = false)
  },
  {
    long: "multiline",
    short: "U",
    negated: "no-multiline",
    category: "search",
    doc: "Enable searching across multiple lines.",
    apply: (a) => (a.multiline = true),
    negate: (a) => (a.multiline = false)
  },
  {
    long: "multiline-dotall",
    negated: "no-multiline-dotall",
    category: "search",
    doc: "Make '.' match line terminators.",
    apply: (a) => (a.multilineDotall = true),
    negate: (a) => (a.multilineDotall = false)
  },
  {
    long: "no-unicode",
    negated: "unicode",
    category: "search",
    doc: "Disable Unicode mode.",
    apply: (a) => (a.unicode = false),
    negate: (a) => (a.unicode = true)
  },
  {
    long: "null-data",
    category: "search",
    doc: "Use NUL as a line terminator.",
    apply: (a) => (a.nullData = true)
  },
  {
    long: "pcre2",
    short: "P",
    negated: "no-pcre2",
    category: "search",
    doc: "Enable PCRE2 matching.",
    apply: (a) => (a.pcre2 = true),
    negate: (a) => (a.pcre2 = false)
  },
  {
    long: "regex-size-limit",
    value: "NUM",
    category: "search",
    doc: "The size limit of the compiled regex.",
    apply: (a, v) => {
      size(a, "--regex-size-limit", v)
      a.regexSizeLimit = v
    }
  },
  {
    long: "smart-case",
    short: "S",
    category: "search",
    doc: "Smart case search.",
    apply: (a) => (a.caseMode = "smart")
  },
  {
    long: "stop-on-nonmatch",
    category: "search",
    doc: "Stop searching after a non-match.",
    apply: (a) => (a.stopOnNonmatch = true)
  },
  {
    long: "text",
    short: "a",
    negated: "no-text",
    category: "search",
    doc: "Search binary files as if they were text.",
    apply: (a) => (a.text = true),
    negate: (a) => (a.text = false)
  },
  {
    long: "threads",
    short: "j",
    value: "NUM",
    category: "search",
    doc: "Set the approximate number of threads to use.",
    apply: (a, v) => (a.threads = number(a, "--threads", v))
  },
  {
    long: "word-regexp",
    short: "w",
    category: "search",
    doc: "Show matches surrounded by word boundaries.",
    apply: (a) => {
      a.wordRegexp = true
      a.lineRegexp = false
    }
  },
  {
    long: "auto-hybrid-regex",
    negated: "no-auto-hybrid-regex",
    category: "search",
    doc: "(DEPRECATED) Use PCRE2 if appropriate.",
    apply: (a) => (a.autoHybridRegex = true),
    negate: (a) => (a.autoHybridRegex = false)
  },
  {
    long: "no-pcre2-unicode",
    negated: "pcre2-unicode",
    category: "search",
    doc: "(DEPRECATED) Disable Unicode mode for PCRE2.",
    apply: (a) => (a.pcre2Unicode = false),
    negate: (a) => (a.pcre2Unicode = true)
  },
  // ---- Filter ---------------------------------------------------------------
  {
    long: "binary",
    negated: "no-binary",
    category: "filter",
    doc: "Search binary files.",
    apply: (a) => (a.binary = true),
    negate: (a) => (a.binary = false)
  },
  {
    long: "follow",
    short: "L",
    negated: "no-follow",
    category: "filter",
    doc: "Follow symbolic links.",
    apply: (a) => (a.follow = true),
    negate: (a) => (a.follow = false)
  },
  {
    long: "glob",
    short: "g",
    value: "GLOB",
    category: "filter",
    doc: "Include or exclude file paths.",
    apply: (a, v) => a.globs.push({ glob: v, caseInsensitive: false })
  },
  {
    long: "glob-case-insensitive",
    negated: "no-glob-case-insensitive",
    category: "filter",
    doc: "Process all glob patterns case insensitively.",
    apply: (a) => (a.globCaseInsensitive = true),
    negate: (a) => (a.globCaseInsensitive = false)
  },
  {
    long: "hidden",
    short: ".",
    negated: "no-hidden",
    category: "filter",
    doc: "Search hidden files and directories.",
    apply: (a) => (a.hidden = true),
    negate: (a) => (a.hidden = false)
  },
  {
    long: "iglob",
    value: "GLOB",
    category: "filter",
    doc: "Include/exclude paths case insensitively.",
    apply: (a, v) => a.globs.push({ glob: v, caseInsensitive: true })
  },
  {
    long: "ignore-file",
    value: "PATH",
    category: "filter",
    doc: "Specify additional ignore files.",
    apply: (a, v) => a.ignoreFiles.push(v)
  },
  {
    long: "ignore-file-case-insensitive",
    negated: "no-ignore-file-case-insensitive",
    category: "filter",
    doc: "Process ignore files case insensitively.",
    apply: (a) => (a.ignoreFileCaseInsensitive = true),
    negate: (a) => (a.ignoreFileCaseInsensitive = false)
  },
  {
    long: "max-depth",
    short: "d",
    value: "NUM",
    aliases: ["maxdepth"],
    category: "filter",
    doc: "Descend at most NUM directories.",
    apply: (a, v) => (a.maxDepth = number(a, "--max-depth", v))
  },
  {
    long: "max-filesize",
    value: "NUM",
    category: "filter",
    doc: "Ignore files larger than NUM in size.",
    apply: (a, v) => (a.maxFilesize = size(a, "--max-filesize", v))
  },
  {
    long: "no-ignore",
    negated: "ignore",
    category: "filter",
    doc: "Don't use ignore files.",
    apply: (a) => (a.noIgnore = true),
    negate: (a) => (a.noIgnore = false)
  },
  {
    long: "no-ignore-dot",
    negated: "ignore-dot",
    category: "filter",
    doc: "Don't use .ignore or .rgignore files.",
    apply: (a) => (a.noIgnoreDot = true),
    negate: (a) => (a.noIgnoreDot = false)
  },
  {
    long: "no-ignore-exclude",
    negated: "ignore-exclude",
    category: "filter",
    doc: "Don't use local exclusion files.",
    apply: (a) => (a.noIgnoreExclude = true),
    negate: (a) => (a.noIgnoreExclude = false)
  },
  {
    long: "no-ignore-files",
    negated: "ignore-files",
    category: "filter",
    doc: "Don't use --ignore-file arguments.",
    apply: (a) => (a.noIgnoreFiles = true),
    negate: (a) => (a.noIgnoreFiles = false)
  },
  {
    long: "no-ignore-global",
    negated: "ignore-global",
    category: "filter",
    doc: "Don't use global ignore files.",
    apply: (a) => (a.noIgnoreGlobal = true),
    negate: (a) => (a.noIgnoreGlobal = false)
  },
  {
    long: "no-ignore-parent",
    negated: "ignore-parent",
    category: "filter",
    doc: "Don't use ignore files in parent directories.",
    apply: (a) => (a.noIgnoreParent = true),
    negate: (a) => (a.noIgnoreParent = false)
  },
  {
    long: "no-ignore-vcs",
    negated: "ignore-vcs",
    category: "filter",
    doc: "Don't use ignore files from source control.",
    apply: (a) => (a.noIgnoreVcs = true),
    negate: (a) => (a.noIgnoreVcs = false)
  },
  {
    long: "no-require-git",
    negated: "require-git",
    category: "filter",
    doc: "Use .gitignore outside of git repositories.",
    apply: (a) => (a.noRequireGit = true),
    negate: (a) => (a.noRequireGit = false)
  },
  {
    long: "one-file-system",
    negated: "no-one-file-system",
    category: "filter",
    doc: "Skip directories on other file systems.",
    apply: (a) => (a.oneFileSystem = true),
    negate: (a) => (a.oneFileSystem = false)
  },
  {
    long: "type",
    short: "t",
    value: "TYPE",
    category: "filter",
    doc: "Only search files matching TYPE.",
    apply: (a, v) => a.types.push({ kind: "select", value: v })
  },
  {
    long: "type-not",
    short: "T",
    value: "TYPE",
    category: "filter",
    doc: "Do not search files matching TYPE.",
    apply: (a, v) => a.types.push({ kind: "negate", value: v })
  },
  {
    long: "type-add",
    value: "TYPESPEC",
    category: "filter",
    doc: "Add a new glob for a file type.",
    apply: (a, v) => a.types.push({ kind: "add", value: v })
  },
  {
    long: "type-clear",
    value: "TYPE",
    category: "filter",
    doc: "Clear globs for a file type.",
    apply: (a, v) => a.types.push({ kind: "clear", value: v })
  },
  {
    long: "unrestricted",
    short: "u",
    category: "filter",
    doc: 'Reduce the level of "smart" filtering.',
    apply: (a) => {
      a.unrestricted++
      if (a.unrestricted >= 1) a.noIgnore = true
      if (a.unrestricted >= 2) a.hidden = true
      if (a.unrestricted >= 3) a.binary = true
    }
  },
  // ---- Output ---------------------------------------------------------------
  {
    long: "after-context",
    short: "A",
    value: "NUM",
    category: "output",
    doc: "Show NUM lines after each match.",
    apply: (a, v) => (a.afterContext = number(a, "--after-context", v))
  },
  {
    long: "before-context",
    short: "B",
    value: "NUM",
    category: "output",
    doc: "Show NUM lines before each match.",
    apply: (a, v) => (a.beforeContext = number(a, "--before-context", v))
  },
  {
    long: "block-buffered",
    negated: "no-block-buffered",
    category: "output",
    doc: "Force block buffering.",
    apply: (a) => (a.blockBuffered = true),
    negate: (a) => (a.blockBuffered = undefined)
  },
  {
    long: "byte-offset",
    short: "b",
    negated: "no-byte-offset",
    category: "output",
    doc: "Print the byte offset for each matching line.",
    apply: (a) => (a.byteOffset = true),
    negate: (a) => (a.byteOffset = false)
  },
  {
    long: "color",
    value: "WHEN",
    category: "output",
    doc: "When to use color.",
    apply: (a, v) => (a.color = oneOf(a, "--color", v, ["never", "auto", "always", "ansi"]))
  },
  {
    long: "colors",
    value: "COLOR_SPEC",
    category: "output",
    doc: "Configure color settings and styles.",
    apply: (a, v) => a.colors.push(v)
  },
  {
    long: "column",
    negated: "no-column",
    category: "output",
    doc: "Show column numbers.",
    apply: (a) => (a.column = true),
    negate: (a) => (a.column = false)
  },
  {
    long: "context",
    short: "C",
    value: "NUM",
    category: "output",
    doc: "Show NUM lines before and after each match.",
    apply: (a, v) => (a.context = number(a, "--context", v))
  },
  {
    long: "context-separator",
    value: "SEP",
    negated: "no-context-separator",
    category: "output",
    doc: "Set the separator for contextual chunks.",
    apply: (a, v) => (a.contextSeparator = unescape(v)),
    negate: (a) => (a.contextSeparator = undefined)
  },
  {
    long: "field-context-separator",
    value: "SEP",
    category: "output",
    doc: "Set the field context separator.",
    apply: (a, v) => (a.fieldContextSeparator = unescape(v))
  },
  {
    long: "field-match-separator",
    value: "SEP",
    category: "output",
    doc: "Set the field match separator.",
    apply: (a, v) => (a.fieldMatchSeparator = unescape(v))
  },
  {
    long: "heading",
    negated: "no-heading",
    category: "output",
    doc: "Print matches grouped by each file.",
    apply: (a) => (a.heading = true),
    negate: (a) => (a.heading = false)
  },
  {
    long: "help",
    short: "h",
    category: "output",
    doc: "Show help output.",
    apply: () => {}
  },
  {
    long: "hostname-bin",
    value: "COMMAND",
    category: "output",
    doc: "Run a program to get this system's hostname.",
    apply: (a, v) => (a.hostnameBin = v)
  },
  {
    long: "hyperlink-format",
    value: "FORMAT",
    category: "output",
    doc: "Set the format of hyperlinks.",
    apply: (a, v) => (a.hyperlinkFormat = v)
  },
  {
    long: "include-zero",
    negated: "no-include-zero",
    category: "output",
    doc: "Include zero matches in summary output.",
    apply: (a) => (a.includeZero = true),
    negate: (a) => (a.includeZero = false)
  },
  {
    long: "line-buffered",
    negated: "no-line-buffered",
    category: "output",
    doc: "Force line buffering.",
    apply: (a) => (a.blockBuffered = false),
    negate: (a) => (a.blockBuffered = undefined)
  },
  {
    long: "line-number",
    short: "n",
    category: "output",
    doc: "Show line numbers.",
    apply: (a) => (a.lineNumber = true)
  },
  {
    long: "no-line-number",
    short: "N",
    category: "output",
    doc: "Suppress line numbers.",
    apply: (a) => (a.lineNumber = false)
  },
  {
    long: "max-columns",
    short: "M",
    value: "NUM",
    category: "output",
    doc: "Omit lines longer than this limit.",
    apply: (a, v) => {
      const n = number(a, "--max-columns", v)
      a.maxColumns = n === 0 ? undefined : n
    }
  },
  {
    long: "max-columns-preview",
    negated: "no-max-columns-preview",
    category: "output",
    doc: "Show preview for lines exceeding the limit.",
    apply: (a) => (a.maxColumnsPreview = true),
    negate: (a) => (a.maxColumnsPreview = false)
  },
  {
    long: "null",
    short: "0",
    category: "output",
    doc: "Print a NUL byte after file paths.",
    apply: (a) => (a.nullPath = true)
  },
  {
    long: "only-matching",
    short: "o",
    category: "output",
    doc: "Print only matched parts of a line.",
    apply: (a) => (a.onlyMatching = true)
  },
  {
    long: "path-separator",
    value: "SEP",
    category: "output",
    doc: "Set the path separator for printing paths.",
    apply: (a, v) => {
      const sep = unescape(v)
      if (sep.length > 1)
        return usage(
          a,
          `A path separator must be exactly one byte, but the given separator is ${sep.length} bytes: ${v}`
        )
      a.pathSeparator = sep
    }
  },
  {
    long: "passthru",
    aliases: ["passthrough"],
    category: "output",
    doc: "Print both matching and non-matching lines.",
    apply: (a) => (a.passthru = true)
  },
  {
    long: "pretty",
    short: "p",
    category: "output",
    doc: "Alias for colors, headings and line numbers.",
    apply: (a) => {
      a.color = "always"
      a.heading = true
      a.lineNumber = true
    }
  },
  {
    long: "quiet",
    short: "q",
    category: "output",
    doc: "Do not print anything to stdout.",
    apply: (a) => (a.quiet = true)
  },
  {
    long: "replace",
    short: "r",
    value: "TEXT",
    category: "output",
    doc: "Replace matches with the given text.",
    apply: (a, v) => (a.replace = v)
  },
  {
    long: "sort",
    value: "SORTBY",
    category: "output",
    doc: "Sort results in ascending order.",
    apply: (a, v) => (a.sort = { by: oneOf(a, "--sort", v, sorts), reverse: false })
  },
  {
    long: "sortr",
    value: "SORTBY",
    category: "output",
    doc: "Sort results in descending order.",
    apply: (a, v) => (a.sort = { by: oneOf(a, "--sortr", v, sorts), reverse: true })
  },
  {
    long: "trim",
    negated: "no-trim",
    category: "output",
    doc: "Trim prefix whitespace from matches.",
    apply: (a) => (a.trim = true),
    negate: (a) => (a.trim = false)
  },
  {
    long: "vimgrep",
    category: "output",
    doc: "Print results im a vim compatible format.",
    apply: (a) => (a.vimgrep = true)
  },
  {
    long: "with-filename",
    short: "H",
    category: "output",
    doc: "Print the file path with each matching line.",
    apply: (a) => (a.withFilename = true)
  },
  {
    long: "no-filename",
    short: "I",
    category: "output",
    doc: "Never print the path with each matching line.",
    apply: (a) => (a.withFilename = false)
  },
  {
    long: "sort-files",
    negated: "no-sort-files",
    category: "output",
    doc: "(DEPRECATED) Sort results by file path.",
    apply: (a) => (a.sort = { by: "path", reverse: false }),
    negate: (a) => (a.sort = undefined)
  },
  // ---- Output modes ---------------------------------------------------------
  {
    long: "count",
    short: "c",
    category: "modes",
    doc: "Show count of matching lines for each file.",
    apply: (a) => (a.mode = "count")
  },
  {
    long: "count-matches",
    category: "modes",
    doc: "Show count of every match for each file.",
    apply: (a) => (a.mode = "countMatches")
  },
  {
    long: "files-with-matches",
    short: "l",
    category: "modes",
    doc: "Print the paths with at least one match.",
    apply: (a) => (a.mode = "filesWithMatches")
  },
  {
    long: "files-without-match",
    category: "modes",
    doc: "Print the paths that contain zero matches.",
    apply: (a) => (a.mode = "filesWithoutMatch")
  },
  {
    long: "json",
    negated: "no-json",
    category: "modes",
    doc: "Show search results in a JSON Lines format.",
    apply: (a) => (a.mode = "json"),
    negate: (a) => {
      if (a.mode === "json") a.mode = "standard"
    }
  },
  // ---- Logging --------------------------------------------------------------
  {
    long: "debug",
    category: "logging",
    doc: "Show debug messages.",
    apply: (a) => (a.debug = true)
  },
  {
    long: "no-ignore-messages",
    negated: "ignore-messages",
    category: "logging",
    doc: "Suppress gitignore parse error messages.",
    apply: (a) => (a.noIgnoreMessages = true),
    negate: (a) => (a.noIgnoreMessages = false)
  },
  {
    long: "no-messages",
    negated: "messages",
    category: "logging",
    doc: "Suppress some error messages.",
    apply: (a) => (a.noMessages = true),
    negate: (a) => (a.noMessages = false)
  },
  {
    long: "stats",
    negated: "no-stats",
    category: "logging",
    doc: "Print statistics about the search.",
    apply: (a) => (a.stats = true),
    negate: (a) => (a.stats = false)
  },
  {
    long: "trace",
    category: "logging",
    doc: "Show trace messages.",
    apply: (a) => {
      a.trace = true
      a.debug = true
    }
  },
  // ---- Other behaviors ------------------------------------------------------
  {
    long: "files",
    category: "other",
    doc: "Print each file that would be searched.",
    apply: (a) => (a.special = "files")
  },
  {
    long: "generate",
    value: "KIND",
    category: "other",
    doc: "Generate man pages and completion scripts.",
    apply: (a, v) => {
      a.generate = oneOf(a, "--generate", v, [
        "man",
        "complete-bash",
        "complete-zsh",
        "complete-fish",
        "complete-powershell"
      ])
      a.special = "generate"
    }
  },
  {
    long: "no-config",
    category: "other",
    doc: "Never read configuration files.",
    apply: (a) => (a.noConfig = true)
  },
  {
    long: "pcre2-version",
    category: "other",
    doc: "Print the version of PCRE2 that ripgrep uses.",
    apply: (a) => (a.special = "pcre2Version")
  },
  {
    long: "type-list",
    category: "other",
    doc: "Show all supported file types.",
    apply: (a) => (a.special = "typeList")
  },
  {
    long: "version",
    short: "V",
    category: "other",
    doc: "Print ripgrep's version.",
    apply: (a) => (a.special = "version")
  }
]

/**
 * Interprets the escapes ripgrep allows in separators: `\t`, `\n`, `\r`,
 * `\0`, `\\` and `\xNN`.
 *
 * @since 0.0.0
 */
const unescape = (s: string): string =>
  s.replaceAll(/\\(x[0-9a-fA-F]{2}|.)/g, (_m, e: string) => {
    if (e.startsWith("x") && e.length === 3) return String.fromCharCode(Number.parseInt(e.slice(1), 16))
    switch (e) {
      case "t":
        return "\t"
      case "n":
        return "\n"
      case "r":
        return "\r"
      case "0":
        return "\0"
      case "\\":
        return "\\"
      default:
        return `\\${e}`
    }
  })

interface Lookup {
  readonly flag: Flag
  readonly negation: boolean
}

const byLong = new Map<string, Lookup>()
const byShort = new Map<string, Flag>()
for (const flag of flags) {
  byLong.set(flag.long, { flag, negation: false })
  for (const alias of flag.aliases ?? []) byLong.set(alias, { flag, negation: false })
  if (flag.negated !== undefined) byLong.set(flag.negated, { flag, negation: true })
  if (flag.short !== undefined) byShort.set(flag.short, flag)
}

const apply = (args: Args, lookup: Lookup, value: string, raw: string): void => {
  if (lookup.flag.long === "help") {
    args.special = raw.startsWith("--") || args.special === "longHelp" ? "longHelp" : "shortHelp"
    return
  }
  if (lookup.negation) lookup.flag.negate?.(args)
  else lookup.flag.apply(args, value)
}

/** The arguments still to read. */
class Cursor {
  private index = 0
  private readonly argv: ReadonlyArray<string>
  private readonly args: Args
  constructor(argv: ReadonlyArray<string>, args: Args) {
    this.argv = argv
    this.args = args
  }
  /** The next argument, or `undefined` at the end. */
  take(): string | undefined {
    return this.argv[this.index++]
  }
  /** A flag's value: the next argument, which must exist. */
  value(flag: string): string {
    const v = this.take()
    if (v === undefined) usage(this.args, `flag '${flag}' requires a value`)
    return v ?? ""
  }
  /** Every remaining argument. */
  rest(): ReadonlyArray<string> {
    const rest = this.argv.slice(this.index)
    this.index = this.argv.length
    return rest
  }
}

/** `--flag`, `--flag=value` or `--flag value`. */
const parseLong = (args: Args, arg: string, cursor: Cursor): void => {
  const eq = arg.indexOf("=")
  const name = arg.slice(2, eq < 0 ? undefined : eq)
  const lookup = byLong.get(name)
  if (lookup === undefined) return usage(args, `unrecognized flag --${name}`)
  const takesValue = lookup.flag.value !== undefined && !lookup.negation
  if (!takesValue && eq >= 0) return usage(args, `flag '--${name}' does not take a value`)
  const value = !takesValue ? "" : eq >= 0 ? arg.slice(eq + 1) : cursor.value(`--${name}`)
  apply(args, lookup, value, arg)
}

/** A cluster of short flags (`-inw`), the last of which may take a value (`-A3`, `-A 3`). */
const parseShort = (args: Args, arg: string, cursor: Cursor): void => {
  for (let j = 1; j < arg.length; j++) {
    const c = arg[j]
    const flag = byShort.get(c)
    if (flag === undefined) return usage(args, `unrecognized flag -${c}`)
    if (flag.value === undefined) {
      apply(args, { flag, negation: false }, "", `-${c}`)
      continue
    }
    const attached = arg.slice(j + 1).replace(/^=/, "")
    apply(args, { flag, negation: false }, Str.isNonEmpty(attached) ? attached : cursor.value(`-${c}`), `-${c}`)
    return
  }
}

/**
 * Parses a command line (without the program name) onto `args`. A
 * malformed one sets `args.error`.
 *
 * @example
 * ```ts
 * import * as Args from "./args.ts"
 *
 * const args = Args.parseArgv(["-in", "foo", "src"], Args.defaults())
 * args.caseMode // "insensitive"
 * ```
 *
 * @since 0.0.0
 */
export const parseArgv = (argv: ReadonlyArray<string>, args: Args): Args => {
  const cursor = new Cursor(argv, args)
  for (let arg = cursor.take(); arg !== undefined && args.error === undefined; arg = cursor.take()) {
    if (arg === "--") args.positional.push(...cursor.rest())
    else if (arg.startsWith("--")) parseLong(args, arg, cursor)
    else if (arg.startsWith("-") && arg !== "-") parseShort(args, arg, cursor)
    else args.positional.push(arg)
  }
  return args
}

/**
 * Splits a ripgrep configuration file into arguments: one per line, blank
 * lines and lines starting with `#` ignored.
 *
 * @since 0.0.0
 */
export const configArguments = (text: string): ReadonlyArray<string> =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => Str.isNonEmpty(line) && !line.startsWith("#"))
