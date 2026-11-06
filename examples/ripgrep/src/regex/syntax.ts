/**
 * A parser for Rust's regex syntax (the `regex` crate, which ripgrep uses
 * by default), written with effect-parse.
 *
 * Flags change how the rest of a group is read: `(?x)` makes whitespace and
 * `#` comments insignificant, `(?i)` folds case, and so on. The grammar is
 * therefore a function of the active flags, built on first use for each
 * combination and cached; a flag directive switches the rest of its group to
 * the grammar for the new flags.
 *
 * @since 0.0.0
 */
import { Ascii, Parser, ParseError, Token } from "@thomasfosterau/effect-parse"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Ast from "./ast.ts"
import type { Regex } from "./ast.ts"
import * as CharSet from "./charset.ts"
import type { Ranges } from "./charset.ts"
import * as Arr from "effect/Array"

/**
 * Regex flags, as a bit set.
 *
 * @since 0.0.0
 */
export const Flags = {
  /** `i`: case-insensitive. */
  CaseInsensitive: 1,
  /** `m`: `^` and `$` match at line boundaries. */
  MultiLine: 2,
  /** `s`: `.` matches `\n`. */
  DotMatchesNewline: 4,
  /** `U`: swap the meaning of greedy and lazy quantifiers. */
  SwapGreed: 8,
  /** `x`: ignore whitespace and allow `#` comments. */
  IgnoreWhitespace: 16,
  /** `u`: Unicode-aware classes (on by default). */
  Unicode: 32,
  /** `R`: CRLF mode: `\r\n` ends a line for `^`, `$` and `.`. */
  Crlf: 64
} as const

const flagLetters: ReadonlyMap<string, number> = new Map([
  ["i", Flags.CaseInsensitive],
  ["m", Flags.MultiLine],
  ["s", Flags.DotMatchesNewline],
  ["U", Flags.SwapGreed],
  ["x", Flags.IgnoreWhitespace],
  ["u", Flags.Unicode],
  ["R", Flags.Crlf]
])

const on = (flags: number, flag: number): boolean => (flags & flag) !== 0

/** A flag group's change: flags to set and flags to clear. */
interface FlagChange {
  readonly set: number
  readonly clear: number
}

const applyFlags = (flags: number, change: FlagChange): number => (flags | change.set) & ~change.clear

/** What an escape sequence denotes. */
type Escape =
  | { readonly _tag: "Char"; readonly codePoint: number }
  | { readonly _tag: "Set"; readonly set: Ranges }
  | { readonly _tag: "Look"; readonly look: Ast.Look }

const char = (codePoint: number): Escape => ({ _tag: "Char", codePoint })
const set = (s: Ranges): Escape => ({ _tag: "Set", set: s })
const look = (l: Ast.Look): Escape => ({ _tag: "Look", look: l })

/** Fails without backtracking: the pattern is malformed here. */
const invalid = (message: string): Parser.Parser<never> => Parser.cut(Parser.failMessage(message))

const hexDigits = (max: number) => Token.takeWhile(Ascii.isHexDigit, { min: 1, max })

const scalarFrom = (hex: string): Parser.Parser<number> => {
  const c = Number.parseInt(hex, 16)
  return c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)
    ? invalid(`invalid Unicode scalar value \\x{${hex}}`)
    : Parser.succeed(c)
}

/** `\x7F`, `\x{10FFFF}`, `\u007F`, `\u{7F}`, `\U0000007F`, `\U{7F}`. */
const hexEscape = (fixed: number): Parser.Parser<number> =>
  Parser.alt(
    Parser.delimited(Token.literal("{"), hexDigits(8), Token.literal("}")),
    Token.take(fixed).pipe(Parser.filter((s) => /^[0-9a-fA-F]+$/.test(s)))
  ).pipe(
    Parser.flatMap(scalarFrom),
    Parser.orElse(() => invalid("invalid hexadecimal escape"))
  )

const unicodeClass = (negated: boolean): Parser.Parser<Ranges> =>
  Parser.alt(Parser.delimited(Token.literal("{"), Token.takeTill("}"), Token.literal("}")), Token.any).pipe(
    Parser.flatMap((name) => {
      const inverted = name.startsWith("^")
      const found = CharSet.unicodeProperty(inverted ? name.slice(1) : name)
      if (found === undefined) return invalid(`Unicode property not found: ${name}`)
      return Parser.succeed(negated !== inverted ? CharSet.negate(found) : found)
    })
  )

const wordBoundaryLooks: ReadonlyArray<readonly [string, Ast.Look, Ast.Look]> = [
  ["{start}", "WordStart", "WordStartAscii"],
  ["{end}", "WordEnd", "WordEndAscii"],
  ["{start-half}", "WordStartHalf", "WordStartHalfAscii"],
  ["{end-half}", "WordEndHalf", "WordEndHalfAscii"]
]

const perlClass = (letter: string, unicode: boolean): Ranges => {
  switch (letter.toLowerCase()) {
    case "d":
      return unicode ? CharSet.unicodeDigit() : CharSet.asciiDigit
    case "s":
      return unicode ? CharSet.unicodeSpace() : CharSet.asciiSpace
    default:
      return unicode ? CharSet.unicodeWord() : CharSet.asciiWord
  }
}

const simpleEscapes: ReadonlyMap<string, number> = new Map([
  ["a", 7],
  ["f", 12],
  ["t", 9],
  ["n", 10],
  ["r", 13],
  ["v", 11]
])

/** The escapes allowed in and out of classes: code points and character sets. */
const classEscapes = (unicode: boolean): ReadonlyMap<string, Parser.Parser<Escape>> =>
  new Map<string, Parser.Parser<Escape>>([
    ...[...simpleEscapes].map(([c, cp]) => [c, Parser.succeed(char(cp))] as const),
    ["x", Parser.map(hexEscape(2), char)],
    ["u", Parser.map(hexEscape(4), char)],
    ["U", Parser.map(hexEscape(8), char)],
    ...["d", "s", "w"].map((c) => [c, Parser.succeed(set(perlClass(c, unicode)))] as const),
    ...["D", "S", "W"].map((c) => [c, Parser.succeed(set(CharSet.negate(perlClass(c, unicode))))] as const),
    ["p", Parser.map(unicodeClass(false), set)],
    ["P", Parser.map(unicodeClass(true), set)]
  ])

/** The escapes allowed only outside classes: assertions. */
const lookEscapes = (unicode: boolean): ReadonlyMap<string, Parser.Parser<Escape>> => {
  const ascii = (u: Ast.Look, a: Ast.Look): Escape => look(unicode ? u : a)
  return new Map<string, Parser.Parser<Escape>>([
    [
      "b",
      Parser.alt(
        ...wordBoundaryLooks.map(([text, u, a]) => Parser.as(Token.literal(text), ascii(u, a))),
        Parser.succeed(ascii("WordBoundary", "WordBoundaryAscii"))
      )
    ],
    ["B", Parser.succeed(ascii("NotWordBoundary", "NotWordBoundaryAscii"))],
    ["A", Parser.succeed(look("StartText"))],
    ["z", Parser.succeed(look("EndText"))],
    ["<", Parser.succeed(ascii("WordStart", "WordStartAscii"))],
    [">", Parser.succeed(ascii("WordEnd", "WordEndAscii"))]
  ])
}

/** Any ASCII character that is not a letter or digit may be escaped to stand for itself. */
const escapedPunctuation = (c: string): Parser.Parser<Escape> =>
  c.length === 1 && c < "\x80" && !/[0-9A-Za-z]/.test(c)
    ? Parser.succeed(char(c.charCodeAt(0)))
    : invalid(`unrecognized escape sequence \\${c}`)

/** The escape sequences after a `\`, under the given flags. */
const escapeBody = (flags: number, inClass: boolean): Parser.Parser<Escape> => {
  const unicode = on(flags, Flags.Unicode)
  const classes = classEscapes(unicode)
  const looks: ReadonlyMap<string, Parser.Parser<Escape>> = inClass ? new Map() : lookEscapes(unicode)
  return Token.any.pipe(Parser.flatMap((c) => classes.get(c) ?? looks.get(c) ?? escapedPunctuation(c)))
}

/** One flag group body: `i-s`, `x`, `-U`. */
const flagChange: Parser.Parser<FlagChange> = Parser.gen(function* () {
  let setFlags = 0
  let clearFlags = 0
  let negated = false
  let any = false
  while (true) {
    const c = yield* Parser.optional(Token.oneOf("imsUxuR-"))
    if (c === undefined) break
    if (c === "-") {
      if (negated) return yield* invalid("repeated negation in flags")
      negated = true
      continue
    }
    any = true
    const bit = flagLetters.get(c) ?? 0
    if (negated) clearFlags |= bit
    else setFlags |= bit
  }
  // Backtracks: `(?P<name>` and `(?<name>` also start with `(?`.
  if (!any) return yield* Parser.failMessage("empty flag group")
  return { set: setFlags, clear: clearFlags }
})

const groupName = Token.takeWhile(
  Token.codePoints("group name", (c) => /[\w.[\]]/.test(String.fromCodePoint(c))),
  {
    min: 1
  }
)

/** A quantifier: its range and whether it is greedy (before `U`). */
interface Quantifier {
  readonly min: number
  readonly max: number
  readonly greedy: boolean
}

interface Grammar {
  /** A whole group body: its alternatives. */
  readonly branches: Parser.Parser<ReadonlyArray<Regex>>
}

const grammars = new Map<number, Grammar>()

const grammar = (flags: number): Grammar => {
  const cached = grammars.get(flags)
  if (cached !== undefined) return cached
  const built = buildGrammar(flags)
  grammars.set(flags, built)
  return built
}

const flagDirective: Parser.Parser<FlagChange> = Parser.delimited(Token.literal("(?"), flagChange, Token.literal(")"))

const buildGrammar = (flags: number): Grammar => {
  const verbose = on(flags, Flags.IgnoreWhitespace)
  const fold = (s: Ranges): Ranges => (on(flags, Flags.CaseInsensitive) ? CharSet.caseFold(s) : s)
  const comment = Parser.preceded(Token.literal("#"), Token.takeTill("\n"))
  const ws: Parser.Parser<void> = verbose
    ? Parser.asVoid(Parser.repeat(Parser.alt(Ascii.multispace1, comment)))
    : Parser.void_
  const tok = <A>(p: Parser.Parser<A>) => Parser.preceded(ws, p)

  const literalChar = (codePoint: number): Regex => {
    if (on(flags, Flags.CaseInsensitive)) {
      const variants = CharSet.caseVariants(codePoint)
      if (variants.length > 1) return { _tag: "Class", set: CharSet.of(...variants) }
    }
    return { _tag: "Literal", text: String.fromCodePoint(codePoint) }
  }

  // ---- character classes -------------------------------------------------

  const classSpecial = verbose ? "[]\\ \t\n\r\f\v" : "[]\\"
  const classLiteral: Parser.Parser<number> = Parser.preceded(
    Parser.not(Parser.alt(Token.literal("&&"), Token.literal("--"), Token.literal("~~"))),
    Token.noneOf(classSpecial)
  ).pipe(Parser.map((c) => c.codePointAt(0) ?? 0))

  const classEscape = Parser.preceded(Token.literal("\\"), escapeBody(flags, true))

  /** A single character in a class, as an escape or a literal. */
  const classChar: Parser.Parser<number> = Parser.alt(
    classEscape.pipe(Parser.filterMap((e) => (e._tag === "Char" ? Option.some(e.codePoint) : Option.none()))),
    classLiteral
  )

  const range: Parser.Parser<Ranges> = Parser.gen(function* () {
    const from = yield* classChar
    const dash = yield* Parser.optional(Parser.terminated(Token.literal("-"), Parser.not(Token.literal("]"))))
    if (dash === undefined) return CharSet.of(from)
    const to = yield* Parser.cut(classChar)
    if (to < from) return yield* invalid("invalid character class range")
    return CharSet.normalize([[from, to]])
  })

  const posix: Parser.Parser<Ranges> = Parser.gen(function* () {
    yield* Token.literal("[:")
    const negated = yield* Parser.optional(Token.literal("^"))
    const name = yield* Ascii.alpha1
    yield* Token.literal(":]")
    const found = CharSet.posixClasses.get(name)
    if (found === undefined) return yield* invalid(`invalid ASCII character class: ${name}`)
    return negated === undefined ? found : CharSet.negate(found)
  })

  const classItem: Parser.Parser<Ranges> = Parser.alt(
    posix,
    Parser.suspend(() => bracketClass),
    classEscape.pipe(Parser.filterMap((e) => (e._tag === "Set" ? Option.some(e.set) : Option.none()))),
    range
  )

  const classUnion = (first: boolean): Parser.Parser<Ranges> =>
    Parser.gen(function* () {
      const items: Array<Ranges> = []
      if (first) {
        const bracket = yield* Parser.optional(Token.literal("]"))
        if (bracket !== undefined) items.push(CharSet.of(0x5d))
      }
      while (true) {
        yield* ws
        const item = yield* Parser.optional(classItem)
        if (item === undefined) break
        items.push(item)
      }
      if (Arr.isReadonlyArrayEmpty(items)) return yield* invalid("empty character class")
      return CharSet.union(...items)
    })

  const classOperator = Parser.alt(Token.literal("&&"), Token.literal("--"), Token.literal("~~"))

  const classBody: Parser.Parser<Ranges> = Parser.gen(function* () {
    let left = yield* classUnion(true)
    while (true) {
      yield* ws
      const op = yield* Parser.optional(classOperator)
      if (op === undefined) return left
      const right = yield* classUnion(false)
      left =
        op === "&&"
          ? CharSet.intersect(left, right)
          : op === "--"
            ? CharSet.difference(left, right)
            : CharSet.symmetricDifference(left, right)
    }
  })

  const bracketClass: Parser.Parser<Ranges> = Parser.gen(function* () {
    yield* Token.literal("[")
    const negated = yield* Parser.optional(Token.literal("^"))
    const body = yield* Parser.cut(classBody)
    yield* Parser.cut(Parser.expected(Token.literal("]"), "closing ]"))
    const folded = fold(body)
    return negated === undefined ? folded : CharSet.negate(folded)
  })

  // ---- atoms ---------------------------------------------------------------

  const dot: Parser.Parser<Regex> = Parser.as(Token.literal("."), {
    _tag: "Class",
    set: on(flags, Flags.DotMatchesNewline)
      ? CharSet.all
      : CharSet.negate(on(flags, Flags.Crlf) ? CharSet.of(0x0a, 0x0d) : CharSet.of(0x0a))
  })

  const multiLine = on(flags, Flags.MultiLine)
  const crlf = on(flags, Flags.Crlf)
  const caret: Parser.Parser<Regex> = Parser.as(Token.literal("^"), {
    _tag: "Look",
    look: multiLine ? (crlf ? "StartLineCrlf" : "StartLine") : "StartText"
  })
  const dollar: Parser.Parser<Regex> = Parser.as(Token.literal("$"), {
    _tag: "Look",
    look: multiLine ? (crlf ? "EndLineCrlf" : "EndLine") : "EndText"
  })

  const escapeAtom: Parser.Parser<Regex> = Parser.preceded(
    Token.literal("\\"),
    Parser.cut(escapeBody(flags, false))
  ).pipe(
    Parser.map((e): Regex => {
      switch (e._tag) {
        case "Char":
          return literalChar(e.codePoint)
        case "Set":
          return { _tag: "Class", set: fold(e.set) }
        case "Look":
          return { _tag: "Look", look: e.look }
      }
    })
  )

  const literalSpecial = verbose ? "\\.+*?()|[{^$# \t\n\r\f\v" : "\\.+*?()|[{^$"
  const literal: Parser.Parser<Regex> = Token.noneOf(literalSpecial).pipe(
    Parser.map((c) => literalChar(c.codePointAt(0) ?? 0))
  )

  const classAtom: Parser.Parser<Regex> = Parser.map(bracketClass, (s): Regex => ({ _tag: "Class", set: s }))

  const group: Parser.Parser<Regex> = Parser.gen(function* () {
    yield* Token.literal("(")
    const question = yield* Parser.optional(Token.literal("?"))
    if (question === undefined) {
      const body = yield* Parser.cut(grammar(flags).branches)
      yield* Parser.cut(Parser.expected(Token.literal(")"), "closing )"))
      return { _tag: "Capture", sub: Ast.alternate(body), index: 0, name: undefined } satisfies Regex
    }
    const named = yield* Parser.optional(
      Parser.delimited(Parser.alt(Token.literal("P<"), Token.literal("<")), Parser.cut(groupName), Token.literal(">"))
    )
    if (named !== undefined) {
      const body = yield* Parser.cut(grammar(flags).branches)
      yield* Parser.cut(Parser.expected(Token.literal(")"), "closing )"))
      return { _tag: "Capture", sub: Ast.alternate(body), index: 0, name: named } satisfies Regex
    }
    const change = yield* Parser.optional(flagChange)
    yield* Parser.cut(Token.literal(":"))
    const inner = change === undefined ? flags : applyFlags(flags, change)
    const body = yield* Parser.cut(grammar(inner).branches)
    yield* Parser.cut(Parser.expected(Token.literal(")"), "closing )"))
    return Ast.alternate(body)
  })

  const atom: Parser.Parser<Regex> = Parser.alt(group, classAtom, dot, caret, dollar, escapeAtom, literal)

  // ---- quantifiers -------------------------------------------------------

  const count = Parser.preceded(ws, Ascii.digit1).pipe(Parser.map(Number))
  const counted: Parser.Parser<Quantifier> = Parser.gen(function* () {
    yield* Token.literal("{")
    const min = yield* Parser.cut(count)
    yield* ws
    const comma = yield* Parser.optional(Token.literal(","))
    const max = comma === undefined ? min : ((yield* Parser.optional(count)) ?? Infinity)
    yield* ws
    yield* Parser.cut(Parser.expected(Token.literal("}"), "closing }"))
    if (max < min) return yield* invalid("invalid repetition range")
    return { min, max, greedy: true }
  })

  const quantifier: Parser.Parser<Quantifier> = Parser.seq(
    Parser.alt(
      Parser.as(Token.literal("*"), { min: 0, max: Infinity, greedy: true }),
      Parser.as(Token.literal("+"), { min: 1, max: Infinity, greedy: true }),
      Parser.as(Token.literal("?"), { min: 0, max: 1, greedy: true }),
      counted
    ),
    Parser.optional(tok(Token.literal("?")))
  ).pipe(
    Parser.map(([q, lazy]) => {
      const greedy = (lazy === undefined) !== on(flags, Flags.SwapGreed)
      return { ...q, greedy }
    })
  )

  const piece: Parser.Parser<Regex> = Parser.gen(function* () {
    let regex = yield* atom
    while (true) {
      const q = yield* Parser.optional(tok(quantifier))
      if (q === undefined) return regex
      regex = { _tag: "Repeat", sub: regex, min: q.min, max: q.max, greedy: q.greedy }
    }
  })

  const bar = tok(Token.literal("|"))

  const branches: Parser.Parser<ReadonlyArray<Regex>> = Parser.gen(function* () {
    const done: Array<Regex> = []
    let items: Array<Regex> = []
    while (true) {
      yield* ws
      const change = yield* Parser.optional(flagDirective)
      if (change !== undefined) {
        // The new flags apply to the rest of the group, alternatives included.
        const rest = yield* grammar(applyFlags(flags, change)).branches
        done.push(Ast.concat([...items, rest[0] ?? Ast.empty]), ...rest.slice(1))
        return done
      }
      const p = yield* Parser.optional(piece)
      if (p !== undefined) {
        items.push(p)
        continue
      }
      const alternative = yield* Parser.optional(bar)
      if (alternative === undefined) break
      done.push(Ast.concat(items))
      items = []
    }
    done.push(Ast.concat(items))
    return done
  })

  return { branches }
}

/**
 * A parsed pattern: the tree, with capture groups numbered, and the names
 * of the groups by index (group 0 is the whole match).
 *
 * @since 0.0.0
 */
export interface Parsed {
  readonly regex: Regex
  readonly names: ReadonlyArray<string | undefined>
}

/**
 * Parses a pattern under the given initial flags. Fails with the
 * `ParseError`, whose message points at the problem.
 *
 * @example
 * ```ts
 * import * as Syntax from "./syntax.ts"
 *
 * Syntax.parse("fo+|ba[rz]", Syntax.Flags.Unicode)
 * ```
 *
 * @since 0.0.0
 */
export const parse = (pattern: string, flags: number): Result.Result<Parsed, ParseError.ParseError<string>> =>
  Parser.parse(grammar(flags).branches, pattern).pipe(
    Result.map((branches) => Ast.numberCaptures(Ast.alternate(branches)))
  )

/**
 * Escapes every regex metacharacter in a string, for `-F` / `--fixed-strings`.
 *
 * @since 0.0.0
 */
export const escape = (text: string): string => text.replaceAll(/[\\.+*?()|[\]{}^$#&\-~ \t\n]/g, (c) => `\\${c}`)

/**
 * Whether a pattern contains an uppercase literal character (escapes
 * skipped), which turns smart case off.
 *
 * @since 0.0.0
 */
export const hasUppercaseLiteral = (pattern: string): boolean =>
  CharSet.hasUppercase(pattern.replaceAll(/\\(?:[pP]\{[^}]*\}|[pP].|x\{[^}]*\}|.)/gu, ""))
