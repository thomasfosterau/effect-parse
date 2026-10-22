/**
 * The JSON grammar of `json-text.ts`, written for compiled parsers: it
 * accepts the same documents and returns the same values, but builds what
 * compiled code can build without intermediate values.
 *
 * - Objects use `Parser.fromEntries` on the repetition of members, which
 *   compiled parsers turn into property assignments: no `[key, value]`
 *   pairs, no array of them.
 * - `\uXXXX` escapes use `alt` and `cut` rather than `flatMap`, whose
 *   continuation would run interpreted.
 * - The string body is a token set (a lookup table), not a predicate.
 *
 * ```ts
 * Parser.parse(Compiler.jit(json), '{"a": [1, "é"]}')
 * Parser.parse(Compiler.jit(jsonGrammar(Text.utf8)), new TextEncoder().encode('{"a": [1, "é"]}'))
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
  const isHighSurrogate = (n: number) => n >= 0xd800 && n <= 0xdbff
  const isLowSurrogate = (n: number) => n >= 0xdc00 && n <= 0xdfff

  // \uXXXX: a high surrogate must be followed by an escaped low surrogate
  const unicodeEscape = Parser.alt(
    hex4.pipe(
      Parser.filter((n) => !isHighSurrogate(n)),
      Parser.map((n) => String.fromCharCode(n))
    ),
    Parser.zipWith(
      hex4,
      Parser.cut(Parser.preceded(T.literal("\\u"), hex4.pipe(Parser.filter(isLowSurrogate)))),
      (hi, lo) => String.fromCharCode(hi, lo)
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
  ).pipe(Parser.fromEntries, Parser.context("object"))

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

/** A complete JSON document in a string, surrounded by optional whitespace. */
export const json: Parser.Parser<Json> = jsonGrammar(Text.string)
