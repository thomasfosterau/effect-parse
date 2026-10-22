/**
 * JSON as a syntax tree, the way an editor would want it (see the `Syntax`
 * module).
 *
 * Every value is a node, object members are `pair` nodes with `key` and
 * `value` fields, and punctuation is anonymous tokens. Whitespace stays
 * outside the nodes. A malformed array element or object member becomes an
 * `ERROR` node, and the rest of the document still parses. The grammar's
 * output is the JSON value, without the elements that failed.
 */
import * as Option from "effect/Option"
import { Ascii, Parser, Syntax, Token } from "@thomasfosterau/effect-parse"
import type { Json } from "./json.js"

const ws = Token.takeWhile(" \t\r\n")

const lexeme = <A, E>(p: Parser.Parser<A, E>) => Parser.terminated(p, ws)

const punct = (s: string) => lexeme(Syntax.token(Token.literal(s)))

/** Skips a malformed element up to the next `,` or closing bracket at the same depth. */
const skip = Parser.make<void>((state) => {
  const input = state.input
  let depth = 0
  let i = state.pos
  for (; i < state.end; i++) {
    const c = input[i]
    if (c === "[" || c === "{") depth++
    else if (c === "]" || c === "}") {
      if (depth === 0) break
      depth--
    } else if (c === "," && depth === 0) break
  }
  state.pos = i
})

const recovering = <A>(p: Parser.Parser<A>) => Parser.resumeAfter(p, skip)

const somes = <A>(options: ReadonlyArray<Option.Option<A>>): Array<A> =>
  options.flatMap((o) => (Option.isSome(o) ? [o.value] : []))

// \uXXXX: the halves of a surrogate pair are escaped separately, and join up in the string
const unicodeEscape = Token.takeWhile(Ascii.isHexDigit, 4).pipe(
  Parser.map((digits) => String.fromCharCode(parseInt(digits, 16))),
  Parser.expected("4 hexadecimal digits")
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

const string = Syntax.node(
  Parser.preceded(
    Token.literal('"'),
    Parser.cut(
      Parser.terminated(
        Ascii.escaped(
          Token.takeTill((c: string) => c === '"' || c === "\\" || c < " "),
          "\\",
          Parser.cut(escapeChar)
        ),
        Token.literal('"')
      )
    )
  ),
  "string"
)

const number = Syntax.node(Ascii.float.pipe(Parser.filter(Number.isFinite)), "number")

const keyword = <A>(s: string, value: A) => Syntax.node(Token.literal(s).pipe(Parser.as(value)), s)

const array: Parser.Parser<ReadonlyArray<Json>> = Syntax.node(
  Parser.preceded(
    punct("["),
    Parser.alt(
      Syntax.token(Token.literal("]")).pipe(Parser.as([])),
      Parser.terminated(
        Parser.separated(recovering(Parser.suspend(() => value)), punct(","), { min: 1 }).pipe(Parser.map(somes)),
        Syntax.token(Token.literal("]"))
      )
    )
  ),
  "array"
)

const pair = Syntax.node(
  Parser.separatedPair(
    Syntax.field(lexeme(string), "key"),
    punct(":"),
    Syntax.field(
      Parser.suspend(() => value),
      "value"
    )
  ),
  "pair"
)

const object: Parser.Parser<{ readonly [key: string]: Json }> = Syntax.node(
  Parser.preceded(
    punct("{"),
    Parser.alt(
      Syntax.token(Token.literal("}")).pipe(Parser.as([])),
      Parser.terminated(
        Parser.separated(recovering(pair), punct(","), { min: 1 }).pipe(Parser.map(somes)),
        Syntax.token(Token.literal("}"))
      )
    )
  ).pipe(Parser.map((members) => Object.fromEntries(members))),
  "object"
)

export const value: Parser.Parser<Json> = lexeme(
  Parser.dispatch(Parser.peek(Token.any), {
    n: keyword("null", null),
    t: keyword("true", true),
    f: keyword("false", false),
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

/** A JSON document; `Syntax.parse(json, text)` builds its tree, with a `document` root. */
export const json: Parser.Parser<Json> = Parser.preceded(ws, value)
