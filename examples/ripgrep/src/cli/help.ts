/**
 * `-h`, `--help`, `-V`, `--pcre2-version` and `--generate`, all derived from
 * the flag table so they list exactly the flags that parse.
 *
 * @since 0.0.0
 */
import type { Category, Flag } from "./args.ts"
import { flags } from "./args.ts"
import * as Arr from "effect/Array"

/**
 * The version this tool reports, and the ripgrep release whose interface
 * it implements.
 *
 * @since 0.0.0
 */
const version = "erg 0.0.0 (ripgrep 14.1.0 compatible, built on effect-parse)"

const categories: ReadonlyArray<readonly [Category, string]> = [
  ["input", "INPUT OPTIONS"],
  ["search", "SEARCH OPTIONS"],
  ["filter", "FILTER OPTIONS"],
  ["output", "OUTPUT OPTIONS"],
  ["modes", "OUTPUT MODES"],
  ["logging", "LOGGING OPTIONS"],
  ["other", "OTHER BEHAVIORS"]
]

const usage = (flag: Flag): string => {
  const short = flag.short === undefined ? "" : `-${flag.short}, `
  const value = flag.value === undefined ? "" : `=${flag.value}`
  return `${short}--${flag.long}${value}`
}

/**
 * The `-h` text.
 *
 * @since 0.0.0
 */
export const shortHelp = (): string => {
  const lines = [
    version,
    "",
    "erg (an example program for effect-parse) recursively searches the current",
    "directory for lines matching a regex pattern, with ripgrep's command line.",
    "",
    "Use -h for short descriptions and --help for more details.",
    "",
    "USAGE:",
    "  erg [OPTIONS] PATTERN [PATH ...]",
    "  erg [OPTIONS] -e PATTERN ... [PATH ...]",
    "  erg [OPTIONS] -f PATTERNFILE ... [PATH ...]",
    "  erg [OPTIONS] --files [PATH ...]",
    "  erg [OPTIONS] --type-list",
    "",
    "POSITIONAL ARGUMENTS:",
    "  <PATTERN>   A regular expression used for searching.",
    "  <PATH>...   A file or directory to search.",
    ""
  ]
  for (const [category, title] of categories) {
    lines.push(`${title}:`)
    for (const flag of flags.filter((f) => f.category === category)) {
      lines.push(`  ${usage(flag).padEnd(32)}${flag.doc}`)
    }
    lines.push("")
  }
  return lines.join("\n")
}

/**
 * The `--help` text: the short help, plus each flag's negation and aliases.
 *
 * @since 0.0.0
 */
export const longHelp = (): string => {
  const lines = [shortHelp(), "NEGATIONS AND ALIASES:"]
  for (const flag of flags) {
    const extra = [
      ...(flag.negated === undefined ? [] : [`--${flag.negated}`]),
      ...(flag.aliases ?? []).map((a) => `--${a}`)
    ]
    if (Arr.isReadonlyArrayNonEmpty(extra)) lines.push(`  --${flag.long.padEnd(30)}${extra.join(", ")}`)
  }
  lines.push(
    "",
    "ENVIRONMENT:",
    "  RIPGREP_CONFIG_PATH   A file of default arguments, one per line.",
    "  ERG_COMPILER          The effect-parse compiler for the matcher: jit (default), closure, wasm or none.",
    ""
  )
  return lines.join("\n")
}

/**
 * The `-V` text.
 *
 * @since 0.0.0
 */
export const versionText = (): string =>
  `${version}\n\nfeatures:-simd-accel,-pcre2\n\nPCRE2 is not available in this build of ripgrep.\n`

const allNames = (): ReadonlyArray<string> =>
  flags.flatMap((f) => [
    `--${f.long}`,
    ...(f.short === undefined ? [] : [`-${f.short}`]),
    ...(f.negated === undefined ? [] : [`--${f.negated}`]),
    ...(f.aliases ?? []).map((a) => `--${a}`)
  ])

/**
 * The `--generate` output: a man page or a shell completion script.
 *
 * @since 0.0.0
 */
export const generate = (kind: string): string => {
  const names = allNames()
  switch (kind) {
    case "man":
      return [
        ".TH ERG 1 2026-11-06 0.0.0",
        ".SH NAME",
        "erg \\- recursively search for a regex pattern (ripgrep's interface, built on effect-parse)",
        ".SH SYNOPSIS",
        "\\fBerg\\fP [OPTIONS] PATTERN [PATH...]",
        ".SH OPTIONS",
        ...flags.flatMap((f) => [".TP", `\\fB${usage(f).replaceAll("-", "\\-")}\\fP`, f.doc]),
        ""
      ].join("\n")
    case "complete-bash":
      return `complete -W "${names.join(" ")}" -o default erg\n`
    case "complete-zsh":
      return `#compdef erg\n_arguments -s ${flags.map((f) => `'--${f.long}[${f.doc.replaceAll("'", "")}]'`).join(" ")} '*:file:_files'\n`
    case "complete-fish":
      return flags
        .map(
          (f) =>
            `complete -c erg -l ${f.long}${f.short === undefined ? "" : ` -s ${f.short}`} -d '${f.doc.replaceAll("'", "\\'")}'`
        )
        .join("\n")
        .concat("\n")
    default:
      return `Register-ArgumentCompleter -Native -CommandName erg -ScriptBlock {\n  param($word)\n  @(${names.map((n) => `'${n}'`).join(", ")}) | Where-Object { $_ -like "$word*" }\n}\n`
  }
}
