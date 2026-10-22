/**
 * An HTTP request parser over bytes, after winnow's `examples/http`.
 *
 * The same parser handles complete input (`Parser.parse`) and streamed
 * input (`ParserStream.parseMany`), since partiality is a property of how
 * it is run, as in winnow's `parser_streaming.rs`.
 */
import { Ascii, Parser, Token } from "@thomasfosterau/effect-parse"

export interface Request {
  readonly method: string
  readonly uri: string
  readonly version: string
}

export interface Header {
  readonly name: string
  readonly value: ReadonlyArray<string>
}

type Bytes = Uint8Array
const decoder = new TextDecoder()
const text = (b: Uint8Array) => decoder.decode(b)

const isToken = (c: number): boolean => c > 31 && c < 128 && !'()<>@,;:\\"/[]?={} '.includes(String.fromCharCode(c))
const isSpace = (c: number) => c === 0x20
const isNotSpace = (c: number) => c !== 0x20
const isVersion = (c: number) => (c >= 0x30 && c <= 0x39) || c === 0x2e
const isHorizontalSpace = (c: number) => c === 0x20 || c === 0x09
const isNotLineEnding = (c: number) => c !== 0x0d && c !== 0x0a

const takeWhile1 = (pred: (b: number) => boolean) => Token.takeWhile<Bytes>(pred, { min: 1 }).pipe(Parser.map(text))

const lineEnding = Ascii.bytes.lineEnding

const httpVersion = Parser.preceded(Token.literal(new TextEncoder().encode("HTTP/")), takeWhile1(isVersion))

const requestLine: Parser.Parser<Request, never, never, Bytes> = Parser.struct({
  method: Parser.terminated(takeWhile1(isToken), takeWhile1(isSpace)),
  uri: Parser.terminated(takeWhile1(isNotSpace), takeWhile1(isSpace)),
  version: Parser.terminated(httpVersion, lineEnding)
})

const headerValue = Parser.delimited(takeWhile1(isHorizontalSpace), takeWhile1(isNotLineEnding), lineEnding)

const header: Parser.Parser<Header, never, never, Bytes> = Parser.struct({
  name: Parser.terminated(takeWhile1(isToken), Token.literal(new Uint8Array([0x3a]))),
  value: Parser.repeat(headerValue, { min: 1 })
})

export const request: Parser.Parser<readonly [Request, ReadonlyArray<Header>], never, never, Bytes> = Parser.seq(
  requestLine,
  Parser.terminated(Parser.repeat(header, { min: 1 }), lineEnding)
)
