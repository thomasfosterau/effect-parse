/**
 * Bit-level parsing (winnow's `binary::bits`, nom's `bits` module).
 *
 * Bit parsers run inside {@link bits}, which switches a byte parser into
 * bit mode. Bits are read most-significant first. When `bits` finishes, any
 * remaining bits of a partly consumed byte are skipped.
 *
 * Inside `bits`, offsets count bits, so the general combinators (`alt`,
 * `repeat`, `opt`, ...) backtrack at bit granularity.
 *
 * @example
 * ```ts
 * import { Binary, Bits, Parser } from "@thomasfosterau/effect-parse"
 *
 * // An IPv4 header starts with a 4-bit version and a 4-bit header length
 * const versionAndLength = Bits.bits(Parser.seq(Bits.take(4), Bits.take(4)))
 *
 * Parser.parse(versionAndLength, new Uint8Array([0x45])) // Result.succeed([4, 5])
 * ```
 *
 * @since 0.1.0
 */
import type { State } from "./Input.js"
import { Fail, Failure } from "./Input.js"
import type { Parser } from "./Parser.js"
import { make } from "./Parser.js"

declare const BitInputBrand: unique symbol

/**
 * The input type of bit-level parsers. A `Parser<A, E, R, BitInput>` can
 * only be run inside {@link bits}.
 *
 * @since 0.1.0
 * @category models
 */
export interface BitInput extends ReadonlyArray<never> {
  readonly [BitInputBrand]: true
}

const scale = (f: Failure, factor: number): Failure =>
  new Failure(
    factor < 1 ? Math.floor(f.offset * factor) : f.offset * factor,
    f.kind,
    f.expected,
    f.context,
    f.hasCause,
    f.cause,
    f.message,
    factor < 1 ? Math.ceil(f.needed * factor) : f.needed * factor
  )

/**
 * Runs `step` with offsets measured in different units (bits vs bytes),
 * converting failure offsets back to the outer units afterwards.
 */
const inUnits = <A>(state: State<any>, factor: number, step: (state: State<any>) => A | Fail): A | Fail => {
  const end = state.end
  const deepest = state.deepest
  state.deepest = undefined
  state.pos = factor > 1 ? state.pos * factor : Math.ceil(state.pos * factor)
  state.end = end * factor
  const a = step(state)
  state.end = end
  const inner = state.deepest
  state.deepest = deepest
  if (a === Fail) {
    state.pos = factor > 1 ? Math.floor(state.pos / factor) : state.pos / factor
    const f = state.failure
    state.failure = scale(f, 1 / factor)
    if (inner !== undefined) {
      const d = inner === f ? state.failure : scale(inner, 1 / factor)
      if (deepest === undefined || d.offset >= deepest.offset) state.deepest = d
    }
    return Fail
  }
  state.pos = factor > 1 ? Math.ceil(state.pos / factor) : state.pos / factor
  if (inner !== undefined) {
    const d = scale(inner, 1 / factor)
    if (deepest === undefined || d.offset >= deepest.offset) state.deepest = d
  }
  return a
}

/**
 * Runs a bit-level parser on byte input (winnow's and nom's `bits`). After
 * success, the input advances to the next byte boundary.
 *
 * @since 0.1.0
 * @category combinators
 */
export const bits = <A, E, R>(self: Parser<A, E, R, BitInput>): Parser<A, E, R, Uint8Array> => {
  const step = self.step as unknown as (state: State<any>) => A | Fail
  return make((state) => inUnits(state, 8, step), "bits")
}

/**
 * Runs a byte-level parser from within a bit-level parser (winnow's and
 * nom's `bytes`). The partly consumed byte, if any, is skipped first.
 *
 * @since 0.1.0
 * @category combinators
 */
export const bytes = <A, E, R>(self: Parser<A, E, R, Uint8Array>): Parser<A, E, R, BitInput> => {
  const step = self.step as (state: State<any>) => A | Fail
  return make((state: State<any>) => inUnits(state, 1 / 8, step), "bytes")
}

const readBits = (state: State<any>, count: number): number => {
  const input = state.input as Uint8Array
  let pos = state.pos
  let value = 0
  for (let i = 0; i < count; i++) {
    const byte = input[pos >>> 3]!
    value = value * 2 + ((byte >>> (7 - (pos & 7))) & 1)
    pos++
  }
  state.pos = pos
  return value
}

/**
 * Takes `count` bits (at most 53) as an unsigned number (winnow's and nom's
 * bit-level `take`).
 *
 * @since 0.1.0
 * @category parsers
 */
export const take = (count: number): Parser<number, never, never, BitInput> => {
  if (count > 53) throw new RangeError("Bits.take: use Bits.takeBig for more than 53 bits")
  const expected = [`${count} bits`]
  return make((state: State<any>) => {
    const avail = state.end - state.pos
    if (avail < count) return state.eoi("Bits", expected, count - avail)
    return readBits(state, count)
  }, "take")
}

/**
 * Takes `count` bits as an unsigned `bigint`.
 *
 * @since 0.1.0
 * @category parsers
 */
export const takeBig = (count: number): Parser<bigint, never, never, BitInput> => {
  const expected = [`${count} bits`]
  return make((state: State<any>) => {
    const avail = state.end - state.pos
    if (avail < count) return state.eoi("Bits", expected, count - avail)
    let value = 0n
    let remaining = count
    while (remaining > 0) {
      const n = Math.min(remaining, 32)
      value = (value << BigInt(n)) | BigInt(readBits(state, n))
      remaining -= n
    }
    return value
  }, "takeBig")
}

/**
 * Matches `count` bits equal to `pattern` (winnow's `pattern`, nom's bit
 * `tag`).
 *
 * @since 0.1.0
 * @category parsers
 */
export const pattern = (pattern: number, count: number): Parser<number, never, never, BitInput> => {
  const expected = [`bit pattern ${pattern.toString(2).padStart(count, "0")}`]
  return make((state: State<any>) => {
    const start = state.pos
    const avail = state.end - start
    if (avail < count) return state.eoi("Bits", expected, count - avail)
    const value = readBits(state, count)
    if (value !== pattern) {
      state.pos = start
      return state.backtrack("Bits", expected)
    }
    return value
  }, "pattern")
}

/**
 * Takes one bit as a boolean (winnow's and nom's `bool`).
 *
 * @since 0.1.0
 * @category parsers
 */
export const bool: Parser<boolean, never, never, BitInput> = /*#__PURE__*/ make((state: State<any>) => {
  if (state.pos >= state.end) return state.eoi("Bits", ["1 bit"], 1)
  return readBits(state, 1) === 1
}, "bool")
