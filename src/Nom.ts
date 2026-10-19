/**
 * nom-flavoured names for effect-parse's parsers and combinators.
 *
 * effect-parse's main API follows winnow's naming (in camelCase). This module
 * offers the names, and argument orders, that nom users know, so grammars
 * can be ported with minimal changes:
 *
 * | nom | effect-parse |
 * |---|---|
 * | `tag("abc")` | `Token.literal("abc")` |
 * | `many0(p)` | `Parser.repeat(p)` |
 * | `separated_list1(sep, p)` | `Parser.separated(p, sep, { min: 1 })` |
 * | `map_res(p, f)` | `Parser.tryMap(p, f)` |
 * | `recognize(p)` | `Parser.taken(p)` |
 * | `value(v, p)` | `Parser.as(p, v)` |
 *
 * nom's `streaming` and `complete` variants are not separate functions here.
 * Whether input is partial is decided by the runner (`Parser.parsePartial`
 * vs `Parser.parse`).
 *
 * @example
 * ```ts
 * import { Result } from "effect"
 * import { Nom, Parser } from "@thomasfosterau/effect-parse"
 *
 * const hexPrimary = Nom.mapRes(
 *   Nom.takeWhileMN(2, 2, (c: string) => /[0-9a-fA-F]/.test(c)),
 *   (s) => Result.succeed(parseInt(s, 16))
 * )
 * const hexColor = Nom.preceded(
 *   Nom.tag("#"),
 *   Nom.tuple(hexPrimary, hexPrimary, hexPrimary)
 * )
 *
 * Parser.parse(hexColor, "#2F14DF") // Result.succeed([47, 20, 223])
 * ```
 *
 * @since 0.1.0
 */
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Ascii from "./Ascii.js"
import * as Binary from "./Binary.js"
import type { Input, Slice, Token as TokenOf } from "./Input.js"
import type { Parser } from "./Parser.js"
import * as P from "./Parser.js"
import * as Token from "./Token.js"
import type { TokenSet } from "./Token.js"

// -----------------------------------------------------------------------------
// bytes / character
// -----------------------------------------------------------------------------

/**
 * Matches a literal (nom's `tag`).
 *
 * @since 0.1.0
 * @category bytes
 */
export const tag = Token.literal

/**
 * Matches a literal, ignoring ASCII case (nom's `tag_no_case`).
 *
 * @since 0.1.0
 * @category bytes
 */
export const tagNoCase = Ascii.caseless

/**
 * Matches a single character (nom's `char`).
 *
 * @since 0.1.0
 * @category character
 */
export const char = <const C extends string>(c: C): Parser<C> => Token.literal(c)

/**
 * Matches any character (nom's `anychar`).
 *
 * @since 0.1.0
 * @category character
 */
export const anychar: Parser<string> = Token.any

/**
 * @since 0.1.0
 * @category character
 */
export const oneOf = Token.oneOf

/**
 * @since 0.1.0
 * @category character
 */
export const noneOf = Token.noneOf

/**
 * @since 0.1.0
 * @category character
 */
export const satisfy = Token.satisfy

/**
 * The longest non-empty run of tokens from a set (nom's `is_a`).
 *
 * @since 0.1.0
 * @category bytes
 */
export const isA = <I extends Input = string>(set: TokenSet<I>): Parser<Slice<NoInfer<I>>, never, never, NoInfer<I>> =>
  Token.takeWhile<I>(set, { min: 1 })

/**
 * The longest non-empty run of tokens *not* from a set (nom's `is_not`).
 *
 * @since 0.1.0
 * @category bytes
 */
export const isNot = <I extends Input = string>(set: TokenSet<I>): Parser<Slice<NoInfer<I>>, never, never, NoInfer<I>> =>
  Token.takeTill<I>(set, { min: 1 })

/**
 * @since 0.1.0
 * @category bytes
 */
export const take = Token.take

/**
 * @since 0.1.0
 * @category bytes
 */
export const takeWhile = <I extends Input = string>(
  predicate: (token: TokenOf<I>) => boolean
): Parser<Slice<NoInfer<I>>, never, never, NoInfer<I>> => Token.takeWhile<I>(predicate as any)

/**
 * @since 0.1.0
 * @category bytes
 */
export const takeWhile1 = <I extends Input = string>(
  predicate: (token: TokenOf<I>) => boolean
): Parser<Slice<NoInfer<I>>, never, never, NoInfer<I>> => Token.takeWhile<I>(predicate as any, { min: 1 })

/**
 * @since 0.1.0
 * @category bytes
 */
export const takeWhileMN = <I extends Input = string>(
  m: number,
  n: number,
  predicate: (token: TokenOf<I>) => boolean
): Parser<Slice<NoInfer<I>>, never, never, NoInfer<I>> => Token.takeWhile<I>(predicate as any, { min: m, max: n })

/**
 * @since 0.1.0
 * @category bytes
 */
export const takeTill = <I extends Input = string>(
  predicate: (token: TokenOf<I>) => boolean
): Parser<Slice<NoInfer<I>>, never, never, NoInfer<I>> => Token.takeTill<I>(predicate as any)

/**
 * @since 0.1.0
 * @category bytes
 */
export const takeTill1 = <I extends Input = string>(
  predicate: (token: TokenOf<I>) => boolean
): Parser<Slice<NoInfer<I>>, never, never, NoInfer<I>> => Token.takeTill<I>(predicate as any, { min: 1 })

/**
 * @since 0.1.0
 * @category bytes
 */
export const takeUntil = Token.takeUntil

/**
 * Recognizes an escaped string (nom's `escaped`).
 *
 * @since 0.1.0
 * @category bytes
 */
export const escaped = Ascii.takeEscaped

/**
 * Unescapes an escaped string (nom's `escaped_transform`).
 *
 * @since 0.1.0
 * @category bytes
 */
export const escapedTransform = Ascii.escaped

/** @since 0.1.0 @category character */
export const alpha0 = Ascii.alpha0
/** @since 0.1.0 @category character */
export const alpha1 = Ascii.alpha1
/** @since 0.1.0 @category character */
export const digit0 = Ascii.digit0
/** @since 0.1.0 @category character */
export const digit1 = Ascii.digit1
/** @since 0.1.0 @category character */
export const hexDigit0 = Ascii.hexDigit0
/** @since 0.1.0 @category character */
export const hexDigit1 = Ascii.hexDigit1
/** @since 0.1.0 @category character */
export const octDigit0 = Ascii.octDigit0
/** @since 0.1.0 @category character */
export const octDigit1 = Ascii.octDigit1
/** @since 0.1.0 @category character */
export const alphanumeric0 = Ascii.alphanumeric0
/** @since 0.1.0 @category character */
export const alphanumeric1 = Ascii.alphanumeric1
/** @since 0.1.0 @category character */
export const space0 = Ascii.space0
/** @since 0.1.0 @category character */
export const space1 = Ascii.space1
/** @since 0.1.0 @category character */
export const multispace0 = Ascii.multispace0
/** @since 0.1.0 @category character */
export const multispace1 = Ascii.multispace1
/** @since 0.1.0 @category character */
export const lineEnding = Ascii.lineEnding
/** @since 0.1.0 @category character */
export const newline = Ascii.newline
/** @since 0.1.0 @category character */
export const tab = Ascii.tab
/** @since 0.1.0 @category character */
export const crlf = Ascii.crlf
/**
 * nom's `not_line_ending`.
 *
 * @since 0.1.0
 * @category character
 */
export const notLineEnding = Ascii.tillLineEnding
/**
 * A decimal unsigned integer (nom's `character::complete::u64` and friends).
 *
 * @since 0.1.0
 * @category character
 */
export const u64 = Ascii.decUint
/**
 * A decimal signed integer (nom's `character::complete::i64` and friends).
 *
 * @since 0.1.0
 * @category character
 */
export const i64 = Ascii.decInt

// -----------------------------------------------------------------------------
// number
// -----------------------------------------------------------------------------

/**
 * nom's `double` (and `float`).
 *
 * @since 0.1.0
 * @category number
 */
export const double = Ascii.float

/**
 * nom's `recognize_float`.
 *
 * @since 0.1.0
 * @category number
 */
export const recognizeFloat: Parser<string> = /*#__PURE__*/ P.taken(Ascii.float)

/**
 * nom's `hex_u32`.
 *
 * @since 0.1.0
 * @category number
 */
export const hexU32 = Ascii.hexUint

/** @since 0.1.0 @category number */
export const beU8 = Binary.u8
/** @since 0.1.0 @category number */
export const beI8 = Binary.i8
/** @since 0.1.0 @category number */
export const leU8 = Binary.u8
/** @since 0.1.0 @category number */
export const leI8 = Binary.i8
/** @since 0.1.0 @category number */
export const beU16 = Binary.beU16
/** @since 0.1.0 @category number */
export const leU16 = Binary.leU16
/** @since 0.1.0 @category number */
export const beI16 = Binary.beI16
/** @since 0.1.0 @category number */
export const leI16 = Binary.leI16
/** @since 0.1.0 @category number */
export const beU24 = Binary.beU24
/** @since 0.1.0 @category number */
export const leU24 = Binary.leU24
/** @since 0.1.0 @category number */
export const beI24 = Binary.beI24
/** @since 0.1.0 @category number */
export const leI24 = Binary.leI24
/** @since 0.1.0 @category number */
export const beU32 = Binary.beU32
/** @since 0.1.0 @category number */
export const leU32 = Binary.leU32
/** @since 0.1.0 @category number */
export const beI32 = Binary.beI32
/** @since 0.1.0 @category number */
export const leI32 = Binary.leI32
/** @since 0.1.0 @category number */
export const beU64 = Binary.beU64
/** @since 0.1.0 @category number */
export const leU64 = Binary.leU64
/** @since 0.1.0 @category number */
export const beI64 = Binary.beI64
/** @since 0.1.0 @category number */
export const leI64 = Binary.leI64
/** @since 0.1.0 @category number */
export const beU128 = Binary.beU128
/** @since 0.1.0 @category number */
export const leU128 = Binary.leU128
/** @since 0.1.0 @category number */
export const beI128 = Binary.beI128
/** @since 0.1.0 @category number */
export const leI128 = Binary.leI128
/** @since 0.1.0 @category number */
export const beF32 = Binary.beF32
/** @since 0.1.0 @category number */
export const leF32 = Binary.leF32
/** @since 0.1.0 @category number */
export const beF64 = Binary.beF64
/** @since 0.1.0 @category number */
export const leF64 = Binary.leF64

// -----------------------------------------------------------------------------
// multi
// -----------------------------------------------------------------------------

/**
 * Zero or more (nom's `many0`).
 *
 * @since 0.1.0
 * @category multi
 */
export const many0 = <A, E, R, I extends Input>(parser: Parser<A, E, R, I>): Parser<Array<A>, E, R, I> =>
  P.repeat(parser)

/**
 * One or more (nom's `many1`).
 *
 * @since 0.1.0
 * @category multi
 */
export const many1 = <A, E, R, I extends Input>(parser: Parser<A, E, R, I>): Parser<[A, ...Array<A>], E, R, I> =>
  P.repeat(parser, { min: 1 })

/**
 * Between `m` and `n` times (nom's `many_m_n`).
 *
 * @since 0.1.0
 * @category multi
 */
export const manyMN = <A, E, R, I extends Input>(
  m: number,
  n: number,
  parser: Parser<A, E, R, I>
): Parser<Array<A>, E, R, I> => P.repeat(parser, { min: m, max: n })

/**
 * Exactly `count` times (nom's `count`).
 *
 * @since 0.1.0
 * @category multi
 */
export const count = <A, E, R, I extends Input>(parser: Parser<A, E, R, I>, count: number): Parser<Array<A>, E, R, I> =>
  P.repeat(parser, count)

/**
 * Repeats `parser` until `end` succeeds (nom's `many_till`).
 *
 * @since 0.1.0
 * @category multi
 */
export const manyTill = <A, E, R, I extends Input, B, E2, R2, I2 extends Input>(
  parser: Parser<A, E, R, I>,
  end: Parser<B, E2, R2, I2>
): Parser<[Array<A>, B], E | E2, R | R2, I & I2> => P.repeatTill(parser, end)

/**
 * Zero or more `parser` separated by `separator` (nom's `separated_list0`;
 * note the separator comes first).
 *
 * @since 0.1.0
 * @category multi
 */
export const separatedList0 = <S, E2, R2, I2 extends Input, A, E, R, I extends Input>(
  separator: Parser<S, E2, R2, I2>,
  parser: Parser<A, E, R, I>
): Parser<Array<A>, E | E2, R | R2, I & I2> => P.separated(parser, separator)

/**
 * One or more `parser` separated by `separator` (nom's `separated_list1`;
 * note the separator comes first).
 *
 * @since 0.1.0
 * @category multi
 */
export const separatedList1 = <S, E2, R2, I2 extends Input, A, E, R, I extends Input>(
  separator: Parser<S, E2, R2, I2>,
  parser: Parser<A, E, R, I>
): Parser<[A, ...Array<A>], E | E2, R | R2, I & I2> => P.separated(parser, separator, { min: 1 })

/**
 * Folds zero or more (nom's `fold_many0`).
 *
 * @since 0.1.0
 * @category multi
 */
export const foldMany0 = <A, E, R, I extends Input, B>(
  parser: Parser<A, E, R, I>,
  init: () => B,
  f: (acc: B, a: A) => B
): Parser<B, E, R, I> => P.fold(parser, { init, f })

/**
 * Folds one or more (nom's `fold_many1`).
 *
 * @since 0.1.0
 * @category multi
 */
export const foldMany1 = <A, E, R, I extends Input, B>(
  parser: Parser<A, E, R, I>,
  init: () => B,
  f: (acc: B, a: A) => B
): Parser<B, E, R, I> => P.fold(parser, { init, f, range: { min: 1 } })

/**
 * Folds between `m` and `n` times (nom's `fold_many_m_n`).
 *
 * @since 0.1.0
 * @category multi
 */
export const foldManyMN = <A, E, R, I extends Input, B>(
  m: number,
  n: number,
  parser: Parser<A, E, R, I>,
  init: () => B,
  f: (acc: B, a: A) => B
): Parser<B, E, R, I> => P.fold(parser, { init, f, range: { min: m, max: n } })

/**
 * nom's `length_data`.
 *
 * @since 0.1.0
 * @category multi
 */
export const lengthData = Binary.lengthTake

/**
 * nom's `length_value`.
 *
 * @since 0.1.0
 * @category multi
 */
export const lengthValue = Binary.lengthAndThen

/**
 * nom's `length_count`.
 *
 * @since 0.1.0
 * @category multi
 */
export const lengthCount = Binary.lengthRepeat

// -----------------------------------------------------------------------------
// sequence / branch
// -----------------------------------------------------------------------------

/**
 * nom's `pair`.
 *
 * @since 0.1.0
 * @category sequence
 */
export const pair = <A, E, R, I extends Input, B, E2, R2, I2 extends Input>(
  first: Parser<A, E, R, I>,
  second: Parser<B, E2, R2, I2>
): Parser<[A, B], E | E2, R | R2, I & I2> => P.zip(first, second)

/**
 * nom's tuples of parsers (`(a, b, c)`, formerly `tuple`).
 *
 * @since 0.1.0
 * @category sequence
 */
export const tuple = P.seq

/** @since 0.1.0 @category sequence */
export const preceded = P.preceded
/** @since 0.1.0 @category sequence */
export const terminated = P.terminated
/** @since 0.1.0 @category sequence */
export const delimited = P.delimited
/** @since 0.1.0 @category sequence */
export const separatedPair = P.separatedPair
/** @since 0.1.0 @category branch */
export const alt = P.alt
/** @since 0.1.0 @category branch */
export const permutation = P.permutation

// -----------------------------------------------------------------------------
// combinator
// -----------------------------------------------------------------------------

/**
 * nom's `map`.
 *
 * @since 0.1.0
 * @category combinator
 */
export const map = <A, E, R, I extends Input, B>(parser: Parser<A, E, R, I>, f: (a: A) => B): Parser<B, E, R, I> =>
  P.map(parser, f)

/**
 * nom's `map_res`: the function returns a `Result`.
 *
 * @since 0.1.0
 * @category combinator
 */
export const mapRes = <A, E, R, I extends Input, B, E2>(
  parser: Parser<A, E, R, I>,
  f: (a: A) => Result.Result<B, E2>
): Parser<B, E | E2, R, I> => P.tryMap(parser, f)

/**
 * nom's `map_opt`: the function returns an `Option`.
 *
 * @since 0.1.0
 * @category combinator
 */
export const mapOpt = <A, E, R, I extends Input, B>(
  parser: Parser<A, E, R, I>,
  f: (a: A) => Option.Option<B>
): Parser<B, E, R, I> => P.filterMap(parser, f)

/**
 * nom's `map_parser`.
 *
 * @since 0.1.0
 * @category combinator
 */
export const mapParser = <A extends Input, E, R, I extends Input, B, E2, R2>(
  parser: Parser<A, E, R, I>,
  applied: Parser<B, E2, R2, A>
): Parser<B, E | E2, R | R2, I> => P.mapParser(parser, applied)

/**
 * nom's `flat_map`.
 *
 * @since 0.1.0
 * @category combinator
 */
export const flatMap = <A, E, R, I extends Input, B, E2, R2, I2 extends Input>(
  parser: Parser<A, E, R, I>,
  f: (a: A) => Parser<B, E2, R2, I2>
): Parser<B, E | E2, R | R2, I & I2> => P.flatMap(parser, f)

/**
 * nom's `value` (note the value comes first).
 *
 * @since 0.1.0
 * @category combinator
 */
export const value = <B, A, E, R, I extends Input>(val: B, parser: Parser<A, E, R, I>): Parser<B, E, R, I> =>
  P.as(parser, val)

/**
 * nom's `verify`.
 *
 * @since 0.1.0
 * @category combinator
 */
export const verify = <A, E, R, I extends Input>(
  parser: Parser<A, E, R, I>,
  predicate: (a: A) => boolean
): Parser<A, E, R, I> => P.filter(parser, predicate)

/**
 * nom's `recognize`.
 *
 * @since 0.1.0
 * @category combinator
 */
export const recognize = P.taken

/**
 * nom's `consumed`: returns `[consumed, output]`.
 *
 * @since 0.1.0
 * @category combinator
 */
export const consumed = <A, E, R, I extends Input>(parser: Parser<A, E, R, I>): Parser<[Slice<I>, A], E, R, I> =>
  P.map(P.withTaken(parser), ([a, s]) => [s, a])

/** @since 0.1.0 @category combinator */
export const opt = P.opt
/** @since 0.1.0 @category combinator */
export const cond = P.cond
/** @since 0.1.0 @category combinator */
export const peek = P.peek
/** @since 0.1.0 @category combinator */
export const not = P.not
/** @since 0.1.0 @category combinator */
export const eof = P.eof
/** @since 0.1.0 @category combinator */
export const allConsuming = P.allConsuming
/** @since 0.1.0 @category combinator */
export const complete = P.complete
/** @since 0.1.0 @category combinator */
export const cut = P.cut
/** @since 0.1.0 @category combinator */
export const success = P.succeed
/**
 * nom's `fail()`.
 *
 * @since 0.1.0
 * @category combinator
 */
export const fail = P.reject
/** @since 0.1.0 @category combinator */
export const rest = Token.rest
/** @since 0.1.0 @category combinator */
export const restLen = Token.restLen

/**
 * nom's `context` (note the label comes first).
 *
 * @since 0.1.0
 * @category error
 */
export const context = <A, E, R, I extends Input>(label: string, parser: Parser<A, E, R, I>): Parser<A, E, R, I> =>
  P.context(parser, label)
