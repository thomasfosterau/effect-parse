/**
 * Parsers for binary formats: fixed-width integers and floats in either
 * byte order, and length-prefixed data (winnow's `binary` module, nom's
 * `number` and `multi::length_*` parsers).
 *
 * Integers up to 32 bits are returned as `number`, wider integers as
 * `bigint`.
 *
 * @example
 * ```ts
 * import { Binary, Parser } from "@thomasfosterau/effect-parse"
 *
 * // A length-prefixed (u16 big-endian) payload
 * const frame = Binary.lengthTake(Binary.beU16)
 * Parser.parse(frame, new Uint8Array([0, 2, 0xca, 0xfe])) // Uint8Array [0xca, 0xfe]
 * ```
 *
 * @since 0.1.0
 */
import * as Predicate from "effect/Predicate"
import type { Input, Slice, State } from "./Input.js"
import { Fail } from "./Input.js"
import type { Parser } from "./Parser.js"
import * as P from "./Parser.js"
import * as Token from "./Token.js"

export {
  /**
   * Runs a bit-level parser on byte input. See the `Bits` module.
   *
   * @since 0.1.0
   * @category bits
   */
  bits
} from "./Bits.js"

/**
 * A byte order. `"native"` is the byte order of the current platform.
 *
 * @since 0.1.0
 * @category models
 */
export type Endianness = "big" | "little" | "native"

const nativeLittle = /*#__PURE__*/ new Uint8Array(/*#__PURE__*/ new Uint16Array([1]).buffer)[0] === 1

/** Reads a number at an offset of a state's bytes. */
type Read<A> = (bytes: Uint8Array, offset: number, state: State<Uint8Array>) => A

/**
 * A `DataView` of a state's bytes, for the numbers integer arithmetic can't
 * read: created once per state (whose input never changes), as one per
 * read cost most of a number's time.
 */
const viewOf = (state: State<Uint8Array>): DataView => {
  const b = state.input
  return (state.view ??= new DataView(b.buffer, b.byteOffset, b.byteLength))
}

/** A {@link Read} through the state's view. */
const viewed =
  <A>(read: (view: DataView, offset: number) => A): Read<A> =>
  (_, o, s) =>
    read(viewOf(s), o)

const fixed = <A>(size: number, name: string, read: Read<A>): Parser<A, never, never, Uint8Array> => {
  const expected = [`${size} byte${size === 1 ? "" : "s"}`]
  return P.described(
    (state: State<Uint8Array>) => {
      const pos = state.pos
      const avail = state.end - pos
      if (avail < size) return state.eoi("Token", expected, size - avail)
      state.pos = pos + size
      return read(state.input, pos, state)
    },
    name,
    { _tag: "Fixed", size, read }
  )
}

// Integers of up to 32 bits are read from the bytes; the rest through a view
const readU24 =
  (little: boolean): Read<number> =>
  (b, o) =>
    little ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) : (b[o] << 16) | (b[o + 1] << 8) | b[o + 2]

const readI24 = (little: boolean): Read<number> => {
  const u = readU24(little)
  return (b, o, s) => (u(b, o, s) << 8) >> 8
}

const readU128 = (little: boolean): Read<bigint> =>
  viewed((v, o) => {
    const a = v.getBigUint64(o, little)
    const b = v.getBigUint64(o + 8, little)
    return little ? (b << 64n) | a : (a << 64n) | b
  })

const readI128 = (little: boolean): Read<bigint> => {
  const u = readU128(little)
  return (b, o, s) => BigInt.asIntN(128, u(b, o, s))
}

/**
 * An unsigned byte.
 *
 * @since 0.1.0
 * @category integers
 */
export const u8: Parser<number, never, never, Uint8Array> = /*#__PURE__*/ fixed(1, "u8", (b, o) => b[o])

/**
 * A signed byte.
 *
 * @since 0.1.0
 * @category integers
 */
export const i8: Parser<number, never, never, Uint8Array> = /*#__PURE__*/ fixed(1, "i8", (b, o) => (b[o] << 24) >> 24)

/** @since 0.1.0 @category integers */
export const beU16: Parser<number, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  2,
  "beU16",
  (b, o) => (b[o] << 8) | b[o + 1]
)
/** @since 0.1.0 @category integers */
export const leU16: Parser<number, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  2,
  "leU16",
  (b, o) => b[o] | (b[o + 1] << 8)
)
/** @since 0.1.0 @category integers */
export const beI16: Parser<number, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  2,
  "beI16",
  (b, o) => (((b[o] << 8) | b[o + 1]) << 16) >> 16
)
/** @since 0.1.0 @category integers */
export const leI16: Parser<number, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  2,
  "leI16",
  (b, o) => ((b[o] | (b[o + 1] << 8)) << 16) >> 16
)
/** @since 0.1.0 @category integers */
export const beU24: Parser<number, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  3,
  "beU24",
  /*#__PURE__*/ readU24(false)
)
/** @since 0.1.0 @category integers */
export const leU24: Parser<number, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  3,
  "leU24",
  /*#__PURE__*/ readU24(true)
)
/** @since 0.1.0 @category integers */
export const beI24: Parser<number, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  3,
  "beI24",
  /*#__PURE__*/ readI24(false)
)
/** @since 0.1.0 @category integers */
export const leI24: Parser<number, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  3,
  "leI24",
  /*#__PURE__*/ readI24(true)
)
/** @since 0.1.0 @category integers */
export const beU32: Parser<number, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  4,
  "beU32",
  (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
)
/** @since 0.1.0 @category integers */
export const leU32: Parser<number, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  4,
  "leU32",
  (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
)
/** @since 0.1.0 @category integers */
export const beI32: Parser<number, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  4,
  "beI32",
  (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]
)
/** @since 0.1.0 @category integers */
export const leI32: Parser<number, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  4,
  "leI32",
  (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)
)
/** @since 0.1.0 @category integers */
export const beU64: Parser<bigint, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  8,
  "beU64",
  /*#__PURE__*/ viewed((v, o) => v.getBigUint64(o, false))
)
/** @since 0.1.0 @category integers */
export const leU64: Parser<bigint, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  8,
  "leU64",
  /*#__PURE__*/ viewed((v, o) => v.getBigUint64(o, true))
)
/** @since 0.1.0 @category integers */
export const beI64: Parser<bigint, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  8,
  "beI64",
  /*#__PURE__*/ viewed((v, o) => v.getBigInt64(o, false))
)
/** @since 0.1.0 @category integers */
export const leI64: Parser<bigint, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  8,
  "leI64",
  /*#__PURE__*/ viewed((v, o) => v.getBigInt64(o, true))
)
/** @since 0.1.0 @category integers */
export const beU128: Parser<bigint, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  16,
  "beU128",
  /*#__PURE__*/ readU128(false)
)
/** @since 0.1.0 @category integers */
export const leU128: Parser<bigint, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  16,
  "leU128",
  /*#__PURE__*/ readU128(true)
)
/** @since 0.1.0 @category integers */
export const beI128: Parser<bigint, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  16,
  "beI128",
  /*#__PURE__*/ readI128(false)
)
/** @since 0.1.0 @category integers */
export const leI128: Parser<bigint, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  16,
  "leI128",
  /*#__PURE__*/ readI128(true)
)

/** @since 0.1.0 @category floats */
export const beF32: Parser<number, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  4,
  "beF32",
  /*#__PURE__*/ viewed((v, o) => v.getFloat32(o, false))
)
/** @since 0.1.0 @category floats */
export const leF32: Parser<number, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  4,
  "leF32",
  /*#__PURE__*/ viewed((v, o) => v.getFloat32(o, true))
)
/** @since 0.1.0 @category floats */
export const beF64: Parser<number, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  8,
  "beF64",
  /*#__PURE__*/ viewed((v, o) => v.getFloat64(o, false))
)
/** @since 0.1.0 @category floats */
export const leF64: Parser<number, never, never, Uint8Array> = /*#__PURE__*/ fixed(
  8,
  "leF64",
  /*#__PURE__*/ viewed((v, o) => v.getFloat64(o, true))
)

const byEndian =
  <A>(big: A, little: A) =>
  (endian: Endianness): A =>
    endian === "big" ? big : endian === "little" ? little : nativeLittle ? little : big

/**
 * An unsigned 16-bit integer in the given byte order (winnow's `u16`).
 *
 * @since 0.1.0
 * @category integers
 */
export const u16: (endian: Endianness) => Parser<number, never, never, Uint8Array> = /*#__PURE__*/ byEndian(
  beU16,
  leU16
)
/** @since 0.1.0 @category integers */
export const i16: (endian: Endianness) => Parser<number, never, never, Uint8Array> = /*#__PURE__*/ byEndian(
  beI16,
  leI16
)
/** @since 0.1.0 @category integers */
export const u24: (endian: Endianness) => Parser<number, never, never, Uint8Array> = /*#__PURE__*/ byEndian(
  beU24,
  leU24
)
/** @since 0.1.0 @category integers */
export const i24: (endian: Endianness) => Parser<number, never, never, Uint8Array> = /*#__PURE__*/ byEndian(
  beI24,
  leI24
)
/** @since 0.1.0 @category integers */
export const u32: (endian: Endianness) => Parser<number, never, never, Uint8Array> = /*#__PURE__*/ byEndian(
  beU32,
  leU32
)
/** @since 0.1.0 @category integers */
export const i32: (endian: Endianness) => Parser<number, never, never, Uint8Array> = /*#__PURE__*/ byEndian(
  beI32,
  leI32
)
/** @since 0.1.0 @category integers */
export const u64: (endian: Endianness) => Parser<bigint, never, never, Uint8Array> = /*#__PURE__*/ byEndian(
  beU64,
  leU64
)
/** @since 0.1.0 @category integers */
export const i64: (endian: Endianness) => Parser<bigint, never, never, Uint8Array> = /*#__PURE__*/ byEndian(
  beI64,
  leI64
)
/** @since 0.1.0 @category integers */
export const u128: (endian: Endianness) => Parser<bigint, never, never, Uint8Array> = /*#__PURE__*/ byEndian(
  beU128,
  leU128
)
/** @since 0.1.0 @category integers */
export const i128: (endian: Endianness) => Parser<bigint, never, never, Uint8Array> = /*#__PURE__*/ byEndian(
  beI128,
  leI128
)
/** @since 0.1.0 @category floats */
export const f32: (endian: Endianness) => Parser<number, never, never, Uint8Array> = /*#__PURE__*/ byEndian(
  beF32,
  leF32
)
/** @since 0.1.0 @category floats */
export const f64: (endian: Endianness) => Parser<number, never, never, Uint8Array> = /*#__PURE__*/ byEndian(
  beF64,
  leF64
)

const toCount = (n: number | bigint): number => (Predicate.isBigInt(n) ? Number(n) : n)

/** How many counts {@link byCount} keeps the parsers of. */
const CountCache = 256

/**
 * `build`, keeping the parsers it built for the first {@link CountCache}
 * counts seen: length-prefixed data repeats a few lengths, and building a
 * parser per value cost several times the parse.
 */
const byCount = <A>(build: (n: number) => A): ((n: number | bigint) => A) => {
  const built = new Map<number, A>()
  return (n) => {
    const count = toCount(n)
    let a = built.get(count)
    if (a === undefined) {
      a = build(count)
      if (built.size < CountCache) built.set(count, a)
    }
    return a
  }
}

/**
 * Parses a length with `count`, then takes that many tokens (winnow's
 * `length_take`, nom's `length_data`).
 *
 * @since 0.1.0
 * @category length-prefixed
 */
export const lengthTake = <E, R, I extends Input = Uint8Array>(
  count: Parser<number | bigint, E, R, I>
): Parser<Slice<I>, E, R, I> => {
  const take = byCount((n) => Token.take<I>(n).step)
  // The count compiles with the grammar: the step is built from its (see `Parser.combinator`)
  return P.combinator(
    [count],
    ([countStep]) =>
      (state: State<I>) => {
        // SAFETY: the count parser's step, interpreted or compiled, returns its output (a number or bigint) or `Fail`
        const n = countStep(state) as number | bigint | Fail
        if (n === Fail) return Fail
        return take(n)(state)
      },
    "lengthTake"
  )
}

/**
 * Parses a length with `count`, then applies `parser` that many times
 * (winnow's `length_repeat`, nom's `length_count`).
 *
 * @since 0.1.0
 * @category length-prefixed
 */
export const lengthRepeat = <E, R, I extends Input, A, E2, R2, I2 extends Input>(
  count: Parser<number | bigint, E, R, I>,
  parser: Parser<A, E2, R2, I2>
): Parser<Array<A>, E | E2, R | R2, I & I2> =>
  P.flatMap(
    count,
    byCount((n) => P.repeat(parser, n))
  )

/**
 * Parses a length with `count`, takes that many tokens, and applies
 * `parser` to them (winnow's `length_and_then`, nom's `length_value`).
 * `parser` does not need to consume the whole slice.
 *
 * @since 0.1.0
 * @category length-prefixed
 */
export const lengthAndThen = <E, R, I extends Input, A, E2, R2>(
  count: Parser<number | bigint, E, R, I>,
  parser: Parser<A, E2, R2, Slice<I> & Input>
): Parser<A, E | E2, R | R2, I> =>
  // SAFETY: a slice of an input is itself an input (a string, a `Uint8Array` or an array), so `Slice<I>` is an `Input`
  P.mapParser(lengthTake(count) as Parser<Slice<I> & Input, E, R, I>, P.complete(parser))
