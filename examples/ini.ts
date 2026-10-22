/**
 * An INI parser, after winnow's `examples/ini/parser_str.rs`.
 *
 * Shows a `Parser.gen` generator-style parser next to combinator style.
 */
import { Ascii, Parser, Token } from "@thomasfosterau/effect-parse"

export type Ini = ReadonlyMap<string, ReadonlyMap<string, string>>

const blank = Parser.repeat(
  Parser.alt(Ascii.multispace1, Parser.taken(Parser.seq(Token.literal(";"), Ascii.tillLineEnding)))
).pipe(Parser.asVoid)

const category = Parser.delimited(
  Token.literal("["),
  Token.takeTill("]\r\n", { min: 1 }),
  Parser.cut(Token.literal("]"))
).pipe(Parser.context("category"))

const keyValue = Parser.gen(function* () {
  const key = yield* Ascii.alphanumeric1
  yield* Ascii.space0
  yield* Parser.cut(Token.literal("="))
  yield* Ascii.space0
  const value = yield* Token.takeTill(";\r\n")
  yield* Parser.opt(Parser.seq(Token.literal(";"), Ascii.tillLineEnding))
  yield* blank
  return [key, value.trimEnd()] as const
}).pipe(Parser.context("key-value pair"))

const section = Parser.seq(
  Parser.terminated(category, blank),
  Parser.repeat(keyValue).pipe(Parser.map((entries) => new Map(entries)))
)

export const ini: Parser.Parser<Ini> = Parser.preceded(blank, Parser.repeat(section)).pipe(
  Parser.map((sections) => new Map(sections))
)
