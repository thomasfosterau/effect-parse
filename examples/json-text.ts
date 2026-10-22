/**
 * The JSON parser of `json.ts`, written once against `Text.TextParsers<I>`
 * so that the same grammar parses JavaScript strings, UTF-8 bytes and
 * UTF-16 bytes.
 *
 * ```ts
 * Parser.parse(jsonGrammar(Text.string), '{"a": [1, "é"]}')
 * Parser.parse(jsonGrammar(Text.utf8), new TextEncoder().encode('{"a": [1, "é"]}'))
 * ```
 */
import { Ascii, Parser, Text, Token } from "@thomasfosterau/effect-parse"
import type { Json } from "./json.js"

export const jsonGrammar = <I extends string | Uint8Array>(
  T: Text.TextParsers<I>
): Parser.Parser<Json, never, never, I> => {
  const ws = T.takeWhile(" \t\r\n")

  const hex4 = T.takeWhile(Ascii.isHexDigit, 4).pipe(
    Parser.map((digits) => parseInt(digits, 16)),
    Parser.expected("4 hexadecimal digits")
  )

  // \uXXXX, combining UTF-16 surrogate pairs
  const unicodeEscape = hex4.pipe(
    Parser.flatMap((hi) =>
      hi >= 0xd800 && hi <= 0xdbff
        ? Parser.preceded(T.literal("\\u"), hex4).pipe(
            Parser.filter((lo) => lo >= 0xdc00 && lo <= 0xdfff),
            Parser.map((lo) => String.fromCharCode(hi, lo))
          )
        : Parser.succeed(String.fromCharCode(hi))
    )
  )

  const escapeChar = Parser.dispatch(T.any, {
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

  // A token set rather than a predicate: it is compiled to a lookup table
  const stringBody = T.escaped(T.takeTill(['"\\', Token.range("\u0000", "\u001f")]), "\\", Parser.cut(escapeChar))

  const string = Parser.preceded(T.literal('"'), Parser.cut(Parser.terminated(stringBody, T.literal('"')))).pipe(
    Parser.context("string")
  )

  const number = T.float.pipe(Parser.filter(Number.isFinite))

  const lexeme = <A, E>(p: Parser.Parser<A, E, never, I>) => Parser.terminated(p, ws)

  const comma = lexeme(T.literal(","))

  const array: Parser.Parser<ReadonlyArray<Json>, never, never, I> = Parser.preceded(
    lexeme(T.literal("[")),
    Parser.cut(
      Parser.terminated(
        Parser.separated(
          Parser.suspend(() => value),
          comma
        ),
        T.literal("]")
      )
    )
  ).pipe(Parser.context("array"))

  const member = Parser.separatedPair(
    lexeme(string),
    Parser.cut(lexeme(T.literal(":"))),
    Parser.suspend(() => value)
  )

  const object: Parser.Parser<{ readonly [key: string]: Json }, never, never, I> = Parser.preceded(
    lexeme(T.literal("{")),
    Parser.cut(Parser.terminated(Parser.separated(member, comma), T.literal("}")))
  ).pipe(
    Parser.map((members) => Object.fromEntries(members)),
    Parser.context("object")
  )

  const value: Parser.Parser<Json, never, never, I> = lexeme(
    Parser.dispatch(Parser.peek(T.any), {
      n: T.literal("null").pipe(Parser.as(null)),
      t: T.literal("true").pipe(Parser.as(true)),
      f: T.literal("false").pipe(Parser.as(false)),
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

  return Parser.preceded(ws, value)
}
