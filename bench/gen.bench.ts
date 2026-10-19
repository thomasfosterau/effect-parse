/**
 * The cost of building parsers inside a `Parser.gen` body, which happens on
 * every run, against the same parsers hoisted out of it.
 *
 * Each case runs many times, interleaved with the others, and the best
 * time is reported.
 *
 * Run with `pnpm build && pnpm bench:gen`.
 */
import { Ascii, Parser, Token } from "@thomasfosterau/effect-parse"

const inline = Parser.gen(function*() {
  yield* Token.literal("(")
  const x = yield* Ascii.decInt
  yield* Token.literal(",")
  const y = yield* Ascii.decInt
  yield* Token.literal(")")
  return { x, y }
})

const open = Token.literal("(")
const comma = Token.literal(",")
const close = Token.literal(")")
const hoisted = Parser.gen(function*() {
  yield* open
  const x = yield* Ascii.decInt
  yield* comma
  const y = yield* Ascii.decInt
  yield* close
  return { x, y }
})

const inlineSets = Parser.gen(function*() {
  const sign = yield* Parser.opt(Token.oneOf("+-"))
  const digits = yield* Token.takeWhile("0123456789", { min: 1 })
  yield* Token.takeWhile(" \t")
  return sign === undefined ? digits : sign + digits
})

const sign = Parser.opt(Token.oneOf("+-"))
const digits = Token.takeWhile("0123456789", { min: 1 })
const space = Token.takeWhile(" \t")
const hoistedSets = Parser.gen(function*() {
  const s = yield* sign
  const d = yield* digits
  yield* space
  return s === undefined ? d : s + d
})

const cases: Array<[string, Parser.Parser<any>, string]> = [
  ["literals, inline", inline, "(12,-34)"],
  ["literals, hoisted", hoisted, "(12,-34)"],
  ["sets, inline", inlineSets, "-1234 "],
  ["sets, hoisted", hoistedSets, "-1234 "]
]

const n = 200_000
const best = cases.map(() => Infinity)
for (let round = 0; round < 15; round++) {
  cases.forEach(([, p, input], i) => {
    const t = performance.now()
    for (let j = 0; j < n; j++) Parser.parse(p, input)
    best[i] = Math.min(best[i]!, performance.now() - t)
  })
}
cases.forEach(([name], i) => console.log(`${name.padEnd(18)} ${(best[i]! * 1e6 / n).toFixed(0).padStart(6)} ns/parse`))
