/**
 * Globs, as ripgrep reads them in `-g`, `--iglob`, `--type-add` and ignore
 * files: `*`, `?`, `[...]`, `{a,b}`, `**` and `\` escapes. A glob is parsed
 * with effect-parse into the regex syntax tree and compiled with the same
 * matcher as search patterns.
 *
 * @since 0.0.0
 */
import { Input, Parser, Token } from "@thomasfosterau/effect-parse"
import * as Result from "effect/Result"
import * as Ast from "../regex/ast.ts"
import type { Regex } from "../regex/ast.ts"
import * as CharSet from "../regex/charset.ts"
import type { Ranges } from "../regex/charset.ts"
import * as Compile from "../regex/compile.ts"

const SLASH = 0x2f
const notSlash: Ranges = CharSet.negate(CharSet.of(SLASH))
const anyChar: Regex = { _tag: "Class", set: CharSet.all }
const anyRun: Regex = { _tag: "Repeat", sub: anyChar, min: 0, max: Infinity, greedy: true }
const segmentChar: Regex = { _tag: "Class", set: notSlash }
const segmentRun: Regex = { _tag: "Repeat", sub: segmentChar, min: 0, max: Infinity, greedy: true }
const slash: Regex = { _tag: "Literal", text: "/" }

/** A `**`: any leading directories when a `/` follows it, otherwise any run of characters at either end and one path segment elsewhere (gitignore's rules). */
const doubleStar: Parser.Parser<Regex> = Parser.gen(function* () {
  const start = yield* Parser.location
  yield* Token.literal("**")
  const sep = yield* Parser.optional(Token.literal("/"))
  const end = yield* Parser.optional(Parser.as(Parser.peek(Parser.eof), true))
  if (sep !== undefined) {
    // `**/` matches any number of leading directories, none included.
    return { _tag: "Repeat", sub: Ast.concat([anyRun, slash]), min: 0, max: 1, greedy: true } satisfies Regex
  }
  return start === 0 || end !== undefined ? anyRun : segmentRun
})

const escapeChar: Parser.Parser<string> = Parser.preceded(Token.literal("\\"), Token.any)

const classChar: Parser.Parser<number> = Parser.alt(escapeChar, Token.noneOf("]")).pipe(
  Parser.map((c) => c.codePointAt(0) ?? 0)
)

const bracket: Parser.Parser<Regex> = Parser.gen(function* () {
  yield* Token.literal("[")
  const negated = yield* Parser.optional(Token.oneOf("!^"))
  const ranges: Array<readonly [number, number]> = []
  const first = yield* Parser.optional(Token.literal("]"))
  if (first !== undefined) ranges.push([0x5d, 0x5d])
  while (true) {
    const from = yield* Parser.optional(classChar)
    if (from === undefined) break
    const dash = yield* Parser.optional(Parser.terminated(Token.literal("-"), Parser.not(Token.literal("]"))))
    const to = dash === undefined ? from : yield* classChar
    ranges.push([Math.min(from, to), Math.max(from, to)])
  }
  yield* Token.literal("]")
  const set = CharSet.normalize(ranges)
  return {
    _tag: "Class",
    set: negated === undefined ? set : CharSet.intersect(CharSet.negate(set), notSlash)
  } satisfies Regex
})

const literalChar = (inBraces: boolean): Parser.Parser<Regex> =>
  Parser.alt(escapeChar, Token.noneOf(inBraces ? "*?[{},\\" : "*?[{\\")).pipe(
    Parser.map((c): Regex => ({ _tag: "Literal", text: c }))
  )

const sequence = (inBraces: boolean): Parser.Parser<Regex> =>
  Parser.repeat(
    Parser.alt(
      doubleStar,
      Parser.as(Token.literal("*"), segmentRun),
      Parser.as(Token.literal("?"), segmentChar),
      bracket,
      Parser.suspend(() => braces),
      literalChar(inBraces)
    )
  ).pipe(Parser.map(Ast.concat))

const braces: Parser.Parser<Regex> = Parser.delimited(
  Token.literal("{"),
  Parser.separated(sequence(true), Token.literal(",")),
  Token.literal("}")
).pipe(Parser.map(Ast.alternate))

const glob: Parser.Parser<Regex> = sequence(false)

/**
 * A compiled glob, matched against a whole path.
 *
 * @since 0.0.0
 */
export interface Glob {
  readonly source: string
  readonly matches: (path: Uint8Array) => boolean
}

const fold = (regex: Regex): Regex => {
  switch (regex._tag) {
    case "Literal":
      return Ast.concat(
        Array.from(regex.text, (c) => c).map(
          (c) => ({ _tag: "Class", set: CharSet.caseFold(CharSet.of(c.codePointAt(0) ?? 0)) }) satisfies Regex
        )
      )
    case "Class":
      return { _tag: "Class", set: CharSet.caseFold(regex.set) }
    case "Repeat":
    case "Capture":
      return { ...regex, sub: fold(regex.sub) }
    case "Concat":
      return Ast.concat(regex.subs.map(fold))
    case "Alternate":
      return Ast.alternate(regex.subs.map(fold))
    default:
      return regex
  }
}

const plain = /^[^*?[\]{}\\]+$/
const extension = /^(\*\*\/)?\*([^*?[\]{}\\/]+)$/
const basename = /^\*\*\/([^*?[\]{}\\/]+)$/

const endsWith = (path: Uint8Array, suffix: Uint8Array): boolean => {
  const offset = path.length - suffix.length
  if (offset < 0) return false
  for (let i = 0; i < suffix.length; i++) if (path[offset + i] !== suffix[i]) return false
  return true
}

const equals = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && endsWith(a, b)

/**
 * The common globs without the regex engine, as ripgrep's globset matches
 * them: a literal path, a file extension (`*.rs`, at any depth after a
 * leading `**` and slash) and a name at any depth (`Makefile` after them).
 */
const quickMatcher = (source: string): ((path: Uint8Array) => boolean) | undefined => {
  const encoder = new TextEncoder()
  if (plain.test(source)) {
    const literal = encoder.encode(source)
    return (path) => equals(path, literal)
  }
  const ext = extension.exec(source)
  if (ext !== null) {
    const suffix = encoder.encode(ext[2] ?? "")
    // Without `**/`, the `*` cannot cross a `/`.
    const anyDepth = ext[1] !== undefined
    return (path) => endsWith(path, suffix) && (anyDepth || path.indexOf(0x2f) < 0)
  }
  const name = basename.exec(source)
  if (name !== null) {
    const literal = encoder.encode(name[1] ?? "")
    const slashed = encoder.encode(`/${name[1] ?? ""}`)
    return (path) => equals(path, literal) || endsWith(path, slashed)
  }
  return undefined
}

/**
 * Compiles a glob, or returns an error message for a malformed one. With
 * `caseInsensitive`, letters match either case.
 *
 * @example
 * ```ts
 * import * as Glob from "./glob.ts"
 *
 * const g = Glob.compileGlob("src/*.rs", false)
 * ```
 *
 * @since 0.0.0
 */
export const compileGlob = (source: string, caseInsensitive: boolean): Result.Result<Glob, string> => {
  const quick = caseInsensitive ? undefined : quickMatcher(source)
  if (quick !== undefined) return Result.succeed({ source, matches: quick })
  const parsed = Parser.parse(glob, source)
  if (Result.isFailure(parsed)) return Result.fail(`error parsing glob '${source}': ${parsed.failure.message}`)
  const body = caseInsensitive ? fold(parsed.success) : parsed.success
  const regex = Ast.concat([body, { _tag: "Look", look: "EndText" }])
  const matcher = Compile.compile(regex, 1, 0x0a, { captures: false, backend: "none", multiline: true })
  return Result.succeed({
    source,
    matches: (path) => matcher.matchAt(new Input.State(path), 0) >= 0
  })
}
