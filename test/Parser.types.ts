/**
 * Compile-time assertions for `Parser.combinator`: each expect-error
 * directive is the assertion (the statement below it must fail to
 * type-check). Checked by `vp run check`, never executed.
 */
import { Ascii, Input, Parser, Token } from "../src/index.js"

// Each step returns its own parser's output (or `Fail`), in order
export const typed: Parser.Parser<string> = Parser.combinator(
  [Ascii.digit1, Token.literal(",")],
  ([digits, comma]) =>
    (state) => {
      const d = digits(state)
      if (d === Input.Fail) return Input.Fail
      const c: "," | Input.Fail = comma(state)
      return c === Input.Fail ? Input.Fail : d
    }
)

Parser.combinator([Ascii.digit1], ([digits]) => (state) => {
  // @ts-expect-error: a string parser's step does not return a number
  const n: number | Input.Fail = digits(state)
  return n
})

// @ts-expect-error: a combinator over string parsers does not parse bytes
Parser.parse(typed, new Uint8Array(0))
