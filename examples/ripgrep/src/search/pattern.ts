/**
 * Builds the matcher from the command line's patterns, as ripgrep does:
 * every `-e` / `-f` / positional pattern is one alternative, `-F` escapes
 * them, `-w` and `-x` wrap them, case is folded per `-i` / `-S`, and outside
 * multiline mode the line terminator can never match.
 *
 * @since 0.0.0
 */
import * as Result from "effect/Result"
import type { Args } from "../cli/args.ts"
import * as Ast from "../regex/ast.ts"
import type { Regex } from "../regex/ast.ts"
import * as CharSet from "../regex/charset.ts"
import * as Compile from "../regex/compile.ts"
import * as Syntax from "../regex/syntax.ts"

/**
 * The compiled patterns.
 *
 * @since 0.0.0
 */
export interface Patterns {
  readonly matcher: Compile.Matcher
  /** Capture group names by index, for `--replace`. */
  readonly names: ReadonlyArray<string | undefined>
  readonly lineTerminator: number
}

const parseError = (pattern: string, offset: number, message: string): string => {
  const reason = message.split("\n").at(-1) ?? message
  return `regex parse error:\n    ${pattern}\n    ${" ".repeat(offset)}^\nerror: ${reason}`
}

const backends: ReadonlyArray<Compile.Backend> = ["jit", "closure", "wasm", "none"]

/**
 * The effect-parse compiler to run the matcher with (`ERG_COMPILER`).
 *
 * @since 0.0.0
 */
export const backend = (value: string | undefined): Compile.Backend => backends.find((b) => b === value) ?? "jit"

/**
 * Compiles the patterns, or returns ripgrep's error message.
 *
 * @example
 * ```ts
 * import * as Args from "../cli/args.ts"
 * import * as Pattern from "./pattern.ts"
 *
 * const patterns = Pattern.build(Args.defaults(), ["fo+"], "jit")
 * ```
 *
 * @since 0.0.0
 */
export const build = (
  args: Args,
  sources: ReadonlyArray<string>,
  compiler: Compile.Backend
): Result.Result<Patterns, string> => {
  const lineTerminator = args.nullData ? 0x00 : 0x0a
  const patterns = args.multiline ? sources : sources.flatMap((p) => p.split("\n"))
  return parseAll(args, patterns).pipe(
    Result.map((branches) => wrap(args, Ast.alternate(branches))),
    Result.flatMap((regex) => (args.multiline ? Result.succeed(regex) : banTerminator(regex, lineTerminator))),
    Result.map((regex) => {
      const numbered = Ast.numberCaptures(regex)
      const matcher = Compile.compile(numbered.regex, numbered.names.length, lineTerminator, {
        captures: args.replace !== undefined,
        backend: compiler
      })
      return { matcher, names: numbered.names, lineTerminator }
    })
  )
}

const sourceOf = (args: Args, pattern: string): string => (args.fixedStrings ? Syntax.escape(pattern) : pattern)

/** The regex flags for the command line: `-i` / `-S`, `--no-unicode`, `--multiline-dotall`, `--crlf`. */
const flagsFor = (args: Args, patterns: ReadonlyArray<string>): number => {
  const smartInsensitive =
    args.caseMode === "smart" && !patterns.some((p) => Syntax.hasUppercaseLiteral(sourceOf(args, p)))
  return (
    Syntax.Flags.MultiLine |
    (args.unicode ? Syntax.Flags.Unicode : 0) |
    (args.caseMode === "insensitive" || smartInsensitive ? Syntax.Flags.CaseInsensitive : 0) |
    (args.multiline && args.multilineDotall ? Syntax.Flags.DotMatchesNewline : 0) |
    (args.crlf ? Syntax.Flags.Crlf : 0)
  )
}

/**
 * Parses every pattern. ripgrep wraps each pattern in a group before
 * joining them, so a pattern is parsed (and its errors are reported) as
 * `(?:pattern)`.
 */
const parseAll = (args: Args, patterns: ReadonlyArray<string>): Result.Result<ReadonlyArray<Regex>, string> => {
  const flags = flagsFor(args, patterns)
  const branches: Array<Regex> = []
  for (const pattern of patterns) {
    const source = `(?:${sourceOf(args, pattern)})`
    const parsed = Syntax.parse(source, flags)
    if (Result.isFailure(parsed)) return Result.fail(parseError(source, parsed.failure.offset, parsed.failure.message))
    branches.push(parsed.success.regex)
  }
  return Result.succeed(branches)
}

/** `-w` and `-x`. */
const wrap = (args: Args, regex: Regex): Regex => {
  if (args.wordRegexp) {
    return Ast.concat([{ _tag: "Look", look: "WordStartHalf" }, regex, { _tag: "Look", look: "WordEndHalf" }])
  }
  if (args.lineRegexp)
    return Ast.concat([{ _tag: "Look", look: "StartLine" }, regex, { _tag: "Look", look: "EndLine" }])
  return regex
}

/** Outside multiline mode: no literal may contain the line terminator, and no class matches it. */
const banTerminator = (regex: Regex, lineTerminator: number): Result.Result<Regex, string> => {
  const terminator = String.fromCharCode(lineTerminator)
  if (Ast.literalContains(regex, terminator)) {
    return Result.fail(
      `the literal '${JSON.stringify(terminator)}' is not allowed in a regex\n\nConsider enabling multiline mode with the --multiline flag (or -U for short).\nWhen multiline mode is enabled, new line characters can be matched.`
    )
  }
  const banned = CharSet.of(lineTerminator)
  return Result.succeed(Ast.mapClasses(regex, (set) => CharSet.difference(set, banned)))
}
