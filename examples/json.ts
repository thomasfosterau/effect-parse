/**
 * A JSON parser, after winnow's `examples/json/parser_dispatch.rs`.
 *
 * Shows `dispatch` on the next character, `cut` to commit once a value has
 * started (for precise errors), `escaped` for string escapes, and
 * `expected` to name grammar rules in error messages.
 */
import { Ascii, Parser, Token } from "@thomasfosterau/effect-parse"

export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

const ws = Token.takeWhile(" \t\r\n")

const literal = <const L extends string>(s: L) => Token.literal(s)

const hex4 = Token.takeWhile(Ascii.isHexDigit, 4).pipe(
  Parser.map((digits) => parseInt(digits, 16)),
  Parser.expected("4 hexadecimal digits")
)

// \uXXXX, combining UTF-16 surrogate pairs
const unicodeEscape = hex4.pipe(
  Parser.flatMap((hi) =>
    hi >= 0xd800 && hi <= 0xdbff
      ? Parser.preceded(literal("\\u"), hex4).pipe(
          Parser.filter((lo) => lo >= 0xdc00 && lo <= 0xdfff),
          Parser.map((lo) => String.fromCharCode(hi, lo))
        )
      : Parser.succeed(String.fromCharCode(hi))
  )
)

const escapeChar = Parser.dispatch(Token.any, {
  '"': Parser.succeed('"'),
  "\\": Parser.succeed("\\"),
  "/": Parser.succeed("/"),
  b: Parser.succeed("\b"),
  f: Parser.succeed("\f"),
  n: Parser.succeed("\n"),
  r: Parser.succeed("\r"),
  t: Parser.succeed("\t"),
  u: unicodeEscape
}).pipe(Parser.expected("escape sequence"))

const stringBody = Ascii.escaped(
  Token.takeTill((c: string) => c === '"' || c === "\\" || c < " "),
  "\\",
  Parser.cut(escapeChar)
)

export const string: Parser.Parser<string> = Parser.preceded(
  literal('"'),
  Parser.cut(Parser.terminated(stringBody, literal('"')))
).pipe(Parser.context("string"))

const number: Parser.Parser<number> = Ascii.float.pipe(Parser.filter(Number.isFinite))

const lexeme = <A, E>(p: Parser.Parser<A, E>) => Parser.terminated(p, ws)

const comma = lexeme(literal(","))

const array: Parser.Parser<ReadonlyArray<Json>> = Parser.preceded(
  lexeme(literal("[")),
  Parser.cut(
    Parser.terminated(
      Parser.separated(
        Parser.suspend(() => value),
        comma
      ),
      literal("]")
    )
  )
).pipe(Parser.context("array"))

const member = Parser.separatedPair(
  lexeme(string),
  Parser.cut(lexeme(literal(":"))),
  Parser.suspend(() => value)
)

const object: Parser.Parser<{ readonly [key: string]: Json }> = Parser.preceded(
  lexeme(literal("{")),
  Parser.cut(Parser.terminated(Parser.separated(member, comma), literal("}")))
).pipe(
  Parser.map((members) => Object.fromEntries(members)),
  Parser.context("object")
)

export const value: Parser.Parser<Json> = lexeme(
  Parser.dispatch(Parser.peek(Token.any), {
    n: literal("null").pipe(Parser.as(null)),
    t: literal("true").pipe(Parser.as(true)),
    f: literal("false").pipe(Parser.as(false)),
    '"': string,
    "[": Parser.suspend(() => array),
    "{": Parser.suspend(() => object),
    "-": number,
    0: number,
    1: number,
    2: number,
    3: number,
    4: number,
    5: number,
    6: number,
    7: number,
    8: number,
    9: number
  }).pipe(Parser.expected("value"))
)

/** A complete JSON document, surrounded by optional whitespace. */
export const json: Parser.Parser<Json> = Parser.preceded(ws, value)
