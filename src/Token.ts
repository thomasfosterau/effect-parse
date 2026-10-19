/**
 * Parsers for individual tokens and slices of tokens (winnow's `token`
 * module, nom's `bytes` module).
 *
 * Parsers here work on every input kind: `string` (tokens are code points),
 * `Uint8Array` (tokens are bytes) and arrays (tokens are elements). Parsers
 * whose input type cannot be inferred from their arguments take a type
 * parameter that defaults to `string`:
 *
 * ```ts
 * import { Token } from "@thomasfosterau/effect-parse"
 *
 * Token.take(4)              // Parser<string, never, never, string>
 * Token.take<Uint8Array>(4)  // Parser<Uint8Array, never, never, Uint8Array>
 * ```
 *
 * On partial input (see `Parser.parsePartial`), parsers that reach the end
 * of the available data report `Incomplete` rather than succeeding early or
 * failing.
 *
 * @since 0.1.0
 */
import type { Input, Slice, State, Token } from "./Input.js"
import {
  advance,
  compileAny,
  countTokens,
  describeBytes,
  End,
  indexOf,
  matchLiteral,
  nextIf,
  NoMatch,
  scan,
  splitSurrogate
} from "./internal/tokens.js"
import type { ErrorKind } from "./ParseError.js"
import { bounds } from "./internal/node.js"
import type { Parser, Range } from "./Parser.js"
import { described } from "./Parser.js"

export type {
  /**
   * @since 0.1.0
   * @category models
   */
  Token
}

/**
 * An inclusive range of tokens, e.g. `Token.range("a", "z")`.
 *
 * @since 0.1.0
 * @category models
 */
export interface TokenRange<T> {
  readonly _tag: "TokenRange"
  readonly from: T
  readonly to: T
}

/**
 * Creates an inclusive token range (winnow's `'a'..='z'`).
 *
 * @since 0.1.0
 * @category constructors
 */
export const range = <T extends string | number>(from: T, to: T): TokenRange<T> => ({ _tag: "TokenRange", from, to })

/**
 * A set of string tokens: the characters of a string, a range, a predicate,
 * or an array of these.
 *
 * @since 0.1.0
 * @category models
 */
export type StringTokenSet =
  | string
  | TokenRange<string>
  | ((char: string) => boolean)
  | ReadonlyArray<StringTokenSet>

/**
 * A set of byte tokens: a byte, the (ASCII) characters of a string, a
 * `Uint8Array` of bytes, a range, a predicate, or an array of these.
 *
 * @since 0.1.0
 * @category models
 */
export type ByteTokenSet =
  | number
  | string
  | Uint8Array
  | TokenRange<number>
  | ((byte: number) => boolean)
  | ReadonlyArray<ByteTokenSet>

/**
 * A set of tokens (winnow's `ContainsToken`). For array inputs, a set is a
 * predicate or an array of allowed elements (compared with `===`).
 *
 * @since 0.1.0
 * @category models
 */
export type TokenSet<I> = I extends string ? StringTokenSet
  : I extends Uint8Array ? ByteTokenSet
  : I extends ReadonlyArray<infer T> ? ((token: T) => boolean) | ReadonlyArray<T>
  : never

const expectedAny = ["any token"]

const anyStep = (state: State<Input>): unknown => {
  const pos = state.pos
  if (pos >= state.end) return state.eoi("Token", expectedAny, 1)
  switch (state.inputKind) {
    case 0: {
      const s = state.input as string
      if (splitSurrogate(state, pos)) return state.incomplete(1, expectedAny)
      const c = s.charCodeAt(pos)
      if (c >= 0xd800 && c <= 0xdbff && pos + 1 < s.length && (s.charCodeAt(pos + 1) & 0xfc00) === 0xdc00) {
        state.pos = pos + 2
        return s.slice(pos, pos + 2)
      }
      state.pos = pos + 1
      return s[pos]
    }
    case 1:
      state.pos = pos + 1
      return (state.input as Uint8Array)[pos]
    default:
      state.pos = pos + 1
      return (state.input as ReadonlyArray<unknown>)[pos]
  }
}

/**
 * Matches any single token: a character of a string (winnow's `any`, nom's
 * `anychar`).
 *
 * @since 0.1.0
 * @category tokens
 */
export const any: Parser<string> = /*#__PURE__*/ described(anyStep as any, "any", { _tag: "Any", encoding: undefined })

/**
 * Matches any single token of an input of type `I`.
 *
 * @example
 * ```ts
 * import { Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * const byte = Token.anyToken<Uint8Array>()
 * Parser.parse(byte, new Uint8Array([7])) // Result.succeed(7)
 * ```
 *
 * @since 0.1.0
 * @category tokens
 */
export const anyToken = <I extends Input = string>(): Parser<Token<NoInfer<I>>, never, never, NoInfer<I>> => any as any

/**
 * Matches a literal sequence of tokens (winnow's `literal`, nom's `tag`).
 * Strings are matched against string input, `Uint8Array`s against byte
 * input, and arrays element-wise (with `===`) against array input.
 *
 * @example
 * ```ts
 * import { Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * const keyword = Parser.alt(Token.literal("true"), Token.literal("false"))
 * //    ^? Parser<"true" | "false">
 * ```
 *
 * @since 0.1.0
 * @category tokens
 */
export const literal: {
  <const L extends string>(literal: L): Parser<L, never, never, string>
  (literal: Uint8Array): Parser<Uint8Array, never, never, Uint8Array>
  <const T>(literal: ReadonlyArray<T>): Parser<ReadonlyArray<T>, never, never, ReadonlyArray<T>>
} = (lit: Input): Parser<any, never, never, any> => literalImpl(lit, false)

/** @internal */
export const literalImpl = (lit: Input, caseless: boolean): Parser<any, never, never, any> => {
  const description = typeof lit === "string"
    ? JSON.stringify(lit)
    : lit instanceof Uint8Array
    ? describeBytes(lit)
    : `[${lit.map((t) => JSON.stringify(t)).join(", ")}]`
  const expected = [caseless ? `${description} (case insensitive)` : description]
  // A string literal may also be matched against byte input (as UTF-8)
  let asBytes: Uint8Array | undefined
  const literalKind = typeof lit === "string" ? 0 : lit instanceof Uint8Array ? 1 : 2
  return described((state: State<Input>) => {
    const pos = state.pos
    const l = literalKind === 0 && state.inputKind === 1 ? (asBytes ??= new TextEncoder().encode(lit as string)) : lit
    const len = l.length
    const r = matchLiteral(state, l, caseless)
    if (r === -1) return state.backtrack("Literal", expected)
    if (r === -2) {
      if (state.partial) return state.incomplete(len - (state.end - pos), expected)
      return state.backtrack("Literal", expected)
    }
    state.pos = pos + len
    return caseless || state.inputKind !== literalKind ? state.slice(pos, pos + len) : lit
  }, description, { _tag: "Literal", literal: lit, caseless, encoding: undefined })
}

/**
 * Matches one token belonging to a set, returning it (winnow's and nom's
 * `one_of`).
 *
 * @example
 * ```ts
 * import { Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * const sign = Token.oneOf("+-")
 * const lower = Token.oneOf(Token.range("a", "z"))
 * const hexByte = Token.oneOf<Uint8Array>([Token.range(0x30, 0x39), Token.range(0x61, 0x66)])
 * ```
 *
 * @since 0.1.0
 * @category tokens
 */
export const oneOf = <I extends Input = string>(set: TokenSet<I>): Parser<Token<NoInfer<I>>, never, never, NoInfer<I>> => {
  const m = compileAny(set)
  const expected = [m.description]
  return described((state) => {
    const t = nextIf(state, m, false)
    if (t === End) return state.eoi("OneOf", expected, 1)
    if (t === NoMatch) return state.backtrack("OneOf", expected)
    return t as Token<I>
  }, m.description, { _tag: "OneOf", set, negate: false, encoding: undefined })
}

/**
 * Matches one token *not* belonging to a set, returning it (winnow's and
 * nom's `none_of`).
 *
 * @since 0.1.0
 * @category tokens
 */
export const noneOf = <I extends Input = string>(set: TokenSet<I>): Parser<Token<NoInfer<I>>, never, never, NoInfer<I>> => {
  const m = compileAny(set)
  const expected = [`anything but ${m.description}`]
  return described((state) => {
    const t = nextIf(state, m, true)
    if (t === End) return state.eoi("NoneOf", expected, 1)
    if (t === NoMatch) return state.backtrack("NoneOf", expected)
    return t as Token<I>
  }, expected[0], { _tag: "OneOf", set, negate: true, encoding: undefined })
}

/**
 * Takes exactly `count` tokens (winnow's and nom's `take`).
 *
 * @since 0.1.0
 * @category slices
 */
export const take = <I extends Input = string>(count: number): Parser<Slice<NoInfer<I>>, never, never, NoInfer<I>> => {
  const expected = [count === 1 ? "1 token" : `${count} tokens`]
  return described((state) => {
    const start = state.pos
    const { count: got, offset } = advance(state, start, count)
    if (got < count) return state.eoi("Take", expected, count - got)
    state.pos = offset
    return state.slice(start, offset)
  }, "take", { _tag: "Take", count, encoding: undefined })
}

const normalize = (r: Range | undefined): [number, number] => {
  if (r === undefined) return [0, Infinity]
  if (typeof r === "number") return [r, r]
  return [r.min ?? 0, r.max ?? Infinity]
}

/** @internal */
export const takeWhileImpl = <I extends Input>(
  set: unknown,
  r: Range | undefined,
  negate: boolean,
  name: string,
  description?: string,
  kind: ErrorKind = "TakeWhile",
  hint = false
): Parser<Slice<NoInfer<I>>, never, never, NoInfer<I>> => {
  const m = compileAny(set)
  const [min, max] = normalize(r)
  const expected = [description ?? (negate ? `anything but ${m.description}` : m.description)]
  return described((state) => {
    const start = state.pos
    const { count, hitEnd, offset } = scan(state, m, negate, max)
    if (hitEnd && state.partial) return state.incomplete(1, expected)
    if (count < min) return state.backtrack(kind, expected, offset)
    // More matching tokens would have been accepted where we stopped
    if (hint && count < max) state.setHint(offset, expected)
    state.pos = offset
    return state.slice(start, offset)
  }, name, { _tag: "TakeWhile", set, negate, min, max, encoding: undefined })
}

/**
 * Takes the longest run of tokens belonging to a set, with the number of
 * tokens constrained by `range` (default: zero or more). This is winnow's
 * `take_while(range, set)`, and nom's `take_while`, `take_while1` and
 * `take_while_m_n`.
 *
 * @example
 * ```ts
 * import { Parser, Token } from "@thomasfosterau/effect-parse"
 *
 * const identifier = Token.takeWhile(
 *   [Token.range("a", "z"), Token.range("A", "Z"), "_"],
 *   { min: 1 }
 * )
 * ```
 *
 * @since 0.1.0
 * @category slices
 */
export const takeWhile = <I extends Input = string>(
  set: TokenSet<I>,
  range?: Range
): Parser<Slice<NoInfer<I>>, never, never, NoInfer<I>> => takeWhileImpl(set, range, false, "takeWhile")

/**
 * Takes the longest run of tokens *not* belonging to a set (winnow's
 * `take_till`, nom's `take_till` and `take_till1`).
 *
 * @since 0.1.0
 * @category slices
 */
export const takeTill = <I extends Input = string>(
  set: TokenSet<I>,
  range?: Range
): Parser<Slice<NoInfer<I>>, never, never, NoInfer<I>> => takeWhileImpl(set, range, true, "takeTill")

/**
 * Takes tokens up to (not including) the first occurrence of a literal
 * (winnow's `take_until`, nom's `take_until`). The literal is not
 * consumed. `range` constrains the number of tokens taken.
 *
 * @since 0.1.0
 * @category slices
 */
export const takeUntil: {
  (literal: string, range?: Range): Parser<string, never, never, string>
  (literal: Uint8Array, range?: Range): Parser<Uint8Array, never, never, Uint8Array>
  <T>(literal: ReadonlyArray<T>, range?: Range): Parser<ReadonlyArray<T>, never, never, ReadonlyArray<T>>
} = (lit: Input, r?: Range): Parser<any, never, never, any> => {
  const [min, max] = normalize(r)
  const description = typeof lit === "string"
    ? JSON.stringify(lit)
    : lit instanceof Uint8Array
    ? describeBytes(lit)
    : `[${lit.map((t) => JSON.stringify(t)).join(", ")}]`
  const expected = [description]
  return described((state: State<Input>) => {
    const start = state.pos
    const idx = indexOf(state, lit, start)
    if (idx < 0) {
      if (state.partial) return state.incomplete(0, expected)
      return state.backtrack("TakeUntil", expected, state.end)
    }
    // As in winnow, the first occurrence must lie within the range
    if (min > 0 || max !== Infinity) {
      const count = countTokens(state, start, idx)
      if (count < min) return state.backtrack("TakeUntil", expected, idx)
      if (count > max) return state.backtrack("TakeUntil", expected)
    }
    state.pos = idx
    return state.slice(start, idx)
  }, "takeUntil", { _tag: "TakeUntil", literal: lit, ...bounds(r), encoding: undefined })
}

/**
 * Takes the rest of the input (winnow's and nom's `rest`).
 *
 * @since 0.1.0
 * @category slices
 */
export const rest: Parser<string> = /*#__PURE__*/ described((state: State<any>) => {
  const start = state.pos
  state.pos = state.end
  return state.slice(start, state.end) as string
}, "rest", { _tag: "Rest", encoding: undefined })

/**
 * Takes the rest of an input of type `I`.
 *
 * @since 0.1.0
 * @category slices
 */
export const restOf = <I extends Input = string>(): Parser<Slice<NoInfer<I>>, never, never, NoInfer<I>> => rest as any

/**
 * Returns the length of the remaining input without consuming it (winnow's
 * and nom's `rest_len`).
 *
 * @since 0.1.0
 * @category slices
 */
export const restLen: Parser<number, never, never, Input> = /*#__PURE__*/ described((state) => state.end - state.pos, "restLen", {
  _tag: "RestLen"
})

/**
 * Matches a token satisfying a predicate (nom's `satisfy`). Equivalent to
 * `Token.oneOf(predicate)`.
 *
 * @since 0.1.0
 * @category tokens
 */
export const satisfy = <I extends Input = string>(
  predicate: (token: Token<I>) => boolean
): Parser<Token<NoInfer<I>>, never, never, NoInfer<I>> => oneOf<I>(predicate as any)
