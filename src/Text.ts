/**
 * Unicode text parsers, generic over the input's encoding.
 *
 * `Text.make(encoding)` builds one set of parsers ({@link TextParsers}) for
 * an {@link Encoding.Encoding}, and ready-made sets are provided for
 * JavaScript strings and the common byte encodings:
 *
 * | Parsers | Input | Offsets |
 * |---|---|---|
 * | `Text.string` | `string` | UTF-16 code units |
 * | `Text.utf8` | `Uint8Array` of UTF-8 | bytes |
 * | `Text.utf16le`, `Text.utf16be` | `Uint8Array` of UTF-16 | bytes |
 * | `Text.latin1` | `Uint8Array` of ISO-8859-1 | bytes |
 *
 * Every set has the same members, and every parser returns `string`s, so a
 * grammar written against `TextParsers<I>` parses all of them:
 *
 * ```ts
 * import { Parser, Text } from "@thomasfosterau/effect-parse"
 *
 * const greeting = <I extends string | Uint8Array>(T: Text.TextParsers<I>) =>
 *   Parser.preceded(T.literal("¡hola "), T.identifier)
 *
 * Parser.parse(greeting(Text.string), "¡hola mundo")                           // "mundo"
 * Parser.parse(greeting(Text.utf8), new TextEncoder().encode("¡hola Zoë"))    // "Zoë"
 * ```
 *
 * Tokens are Unicode code points, and character classes follow Unicode
 * properties: `alpha1` matches `"Ωμέγα"`, `space1` matches a no-break space.
 * Use the `Ascii` module for the ASCII-only classes.
 *
 * Decoding is strict. Malformed input (invalid UTF-8, unpaired surrogates)
 * never matches, and error messages point at it. On partial input, a
 * character split across chunks reports `Incomplete`, so byte streams can be
 * parsed as text without decoding them first.
 *
 * @since 0.1.0
 */
import type { Encoding } from "./Encoding.js"
import * as Encodings from "./Encoding.js"
import type { Input, State } from "./Input.js"
import { Fail } from "./Input.js"
import { escapedImpl, overflow, takeEscapedImpl, toFloat } from "./Ascii.js"
import { codePointPredicate, compile, indexOf, matchLiteral } from "./internal/tokens.js"
import { floatText as markFloatText } from "./internal/numbers.js"
import * as internal from "./internal/text.js"
import type { Node } from "./internal/node.js"
import type { ErrorKind } from "./ParseError.js"
import type { Parser, Range } from "./Parser.js"
import * as P from "./Parser.js"
import type { StringTokenSet } from "./Token.js"

// -----------------------------------------------------------------------------
// Unicode predicates
// -----------------------------------------------------------------------------

/**
 * A predicate over characters. It accepts a one-character string or a code
 * point.
 *
 * @since 0.1.0
 * @category models
 */
export type CharPredicate = (char: string | number) => boolean

const toCodePoint = (c: string | number): number => (typeof c === "number" ? c : (c.codePointAt(0) ?? -1))

const makePredicate = (name: string, re: RegExp): CharPredicate => {
  // Results for the Basic Multilingual Plane are cached: a table lookup is
  // much faster than a regular expression test.
  let ascii: Uint8Array | undefined
  let bmp: Uint8Array | undefined
  return codePointPredicate(name, (c: string | number): boolean => {
    const x = toCodePoint(c)
    if (x < 0) return false
    let table: Uint8Array
    if (x < 128) table = ascii ??= new Uint8Array(128)
    else if (x < 0x10000) table = bmp ??= new Uint8Array(0x10000)
    else return re.test(String.fromCodePoint(x))
    let v = table[x]!
    if (v === 0) table[x] = v = re.test(String.fromCharCode(x)) ? 2 : 1
    return v === 2
  })
}

/**
 * A predicate testing a Unicode property, using the syntax of regular
 * expression property escapes (`\p{...}`): a general category (`"Lu"`,
 * `"Letter"`), a binary property (`"Emoji"`, `"Dash"`) or a script
 * (`"Script=Greek"`).
 *
 * @example
 * ```ts
 * import { Text } from "@thomasfosterau/effect-parse"
 *
 * const greek = Text.string.takeWhile(Text.property("Script=Greek"), { min: 1 })
 * ```
 *
 * @since 0.1.0
 * @category predicates
 */
export const property = (name: string): CharPredicate => makePredicate(name, new RegExp(`^\\p{${name}}$`, "u"))

/**
 * Letters and other alphabetic characters (the Unicode `Alphabetic`
 * property, Rust's `char::is_alphabetic`).
 *
 * @since 0.1.0
 * @category predicates
 */
export const isAlphabetic: CharPredicate = /*#__PURE__*/ makePredicate("isAlphabetic", /^\p{Alphabetic}$/u)

/**
 * Letters (general category `L`).
 *
 * @since 0.1.0
 * @category predicates
 */
export const isLetter: CharPredicate = /*#__PURE__*/ makePredicate("isLetter", /^\p{L}$/u)

/**
 * Uppercase characters (the Unicode `Uppercase` property).
 *
 * @since 0.1.0
 * @category predicates
 */
export const isUppercase: CharPredicate = /*#__PURE__*/ makePredicate("isUppercase", /^\p{Uppercase}$/u)

/**
 * Lowercase characters (the Unicode `Lowercase` property).
 *
 * @since 0.1.0
 * @category predicates
 */
export const isLowercase: CharPredicate = /*#__PURE__*/ makePredicate("isLowercase", /^\p{Lowercase}$/u)

/**
 * Decimal digits of any script (general category `Nd`): `0`–`9`, `٠`–`٩`,
 * `०`–`९`, ...
 *
 * @since 0.1.0
 * @category predicates
 */
export const isDecimalDigit: CharPredicate = /*#__PURE__*/ makePredicate("isDecimalDigit", /^\p{Nd}$/u)

/**
 * Numeric characters (general category `N`), including `½` and `Ⅻ` (Rust's
 * `char::is_numeric`).
 *
 * @since 0.1.0
 * @category predicates
 */
export const isNumeric: CharPredicate = /*#__PURE__*/ makePredicate("isNumeric", /^\p{N}$/u)

/**
 * Alphabetic or numeric characters (Rust's `char::is_alphanumeric`).
 *
 * @since 0.1.0
 * @category predicates
 */
export const isAlphanumeric: CharPredicate = /*#__PURE__*/ makePredicate("isAlphanumeric", /^[\p{Alphabetic}\p{N}]$/u)

/**
 * Whitespace, including line breaks (the Unicode `White_Space` property,
 * Rust's `char::is_whitespace`).
 *
 * @since 0.1.0
 * @category predicates
 */
export const isWhitespace: CharPredicate = /*#__PURE__*/ makePredicate("isWhitespace", /^\p{White_Space}$/u)

/**
 * Whitespace that does not break lines: `White_Space` except `\n`, `\v`,
 * `\f`, `\r`, U+0085, U+2028 and U+2029. Includes tabs and no-break spaces.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isSpace: CharPredicate = /*#__PURE__*/ makePredicate(
  "isSpace",
  /^(?![\n\v\f\r\u0085\u2028\u2029])\p{White_Space}$/u
)

/**
 * Characters that can start an identifier (the Unicode `ID_Start` property,
 * see UAX #31).
 *
 * @since 0.1.0
 * @category predicates
 */
export const isIdStart: CharPredicate = /*#__PURE__*/ makePredicate("isIdStart", /^\p{ID_Start}$/u)

/**
 * Characters that can continue an identifier (the Unicode `ID_Continue`
 * property, see UAX #31).
 *
 * @since 0.1.0
 * @category predicates
 */
export const isIdContinue: CharPredicate = /*#__PURE__*/ makePredicate("isIdContinue", /^\p{ID_Continue}$/u)

/**
 * Punctuation (general category `P`).
 *
 * @since 0.1.0
 * @category predicates
 */
export const isPunctuation: CharPredicate = /*#__PURE__*/ makePredicate("isPunctuation", /^\p{P}$/u)

/**
 * Control characters (general category `Cc`).
 *
 * @since 0.1.0
 * @category predicates
 */
export const isControl: CharPredicate = /*#__PURE__*/ makePredicate("isControl", /^\p{Cc}$/u)

// -----------------------------------------------------------------------------
// Parsers
// -----------------------------------------------------------------------------

/**
 * The text parsers for one encoding. Build a set with {@link make}, or use
 * {@link string}, {@link utf8}, {@link utf16le}, {@link utf16be} or
 * {@link latin1}.
 *
 * Every parser returns text as a `string`, whatever the input. To keep a
 * slice of a byte input as bytes instead, use `Parser.taken`.
 *
 * @since 0.1.0
 * @category models
 */
export interface TextParsers<I extends string | Uint8Array> {
  /** The encoding these parsers read. */
  readonly encoding: Encoding<I>

  // Tokens

  /** Any single character (code point). */
  readonly any: Parser<string, never, never, I>
  /**
   * A literal string, returned as written. On byte inputs it is matched in
   * its encoded form.
   */
  readonly literal: <const L extends string>(literal: L) => Parser<L, never, never, I>
  /**
   * A literal string, ignoring case (by simple Unicode case folding, so
   * `"straße"` matches `"STRAßE"` but not `"STRASSE"`). Returns the input as
   * written.
   */
  readonly caseless: (literal: string) => Parser<string, never, never, I>
  /** One character belonging to a set (the characters of a string, a range, a predicate, or an array of these). */
  readonly oneOf: (set: StringTokenSet) => Parser<string, never, never, I>
  /** One character *not* belonging to a set. */
  readonly noneOf: (set: StringTokenSet) => Parser<string, never, never, I>
  /** An optional byte order mark, U+FEFF. Returns whether one was present. */
  readonly bom: Parser<boolean, never, never, I>

  // Slices

  /** Exactly `count` characters. */
  readonly take: (count: number) => Parser<string, never, never, I>
  /** The longest run of characters belonging to a set, with a count in `range` (default: any). */
  readonly takeWhile: (set: StringTokenSet, range?: Range) => Parser<string, never, never, I>
  /** The longest run of characters *not* belonging to a set, with a count in `range`. */
  readonly takeTill: (set: StringTokenSet, range?: Range) => Parser<string, never, never, I>
  /** Characters up to (not including) the first occurrence of a literal. */
  readonly takeUntil: (literal: string, range?: Range) => Parser<string, never, never, I>
  /** The rest of the input. */
  readonly rest: Parser<string, never, never, I>
  /**
   * Runs a parser and returns the text it consumed (`Parser.taken`, decoded
   * to a `string`).
   */
  readonly taken: <A, E, R>(self: Parser<A, E, R, I>) => Parser<string, E, R, I>

  // Character classes

  /** Zero or more alphabetic characters ({@link isAlphabetic}). */
  readonly alpha0: Parser<string, never, never, I>
  /** One or more alphabetic characters ({@link isAlphabetic}). */
  readonly alpha1: Parser<string, never, never, I>
  /** Zero or more decimal digits of any script ({@link isDecimalDigit}). */
  readonly digit0: Parser<string, never, never, I>
  /** One or more decimal digits of any script ({@link isDecimalDigit}). */
  readonly digit1: Parser<string, never, never, I>
  /** Zero or more alphanumeric characters ({@link isAlphanumeric}). */
  readonly alphanumeric0: Parser<string, never, never, I>
  /** One or more alphanumeric characters ({@link isAlphanumeric}). */
  readonly alphanumeric1: Parser<string, never, never, I>
  /** Zero or more non-breaking whitespace characters ({@link isSpace}). */
  readonly space0: Parser<string, never, never, I>
  /** One or more non-breaking whitespace characters ({@link isSpace}). */
  readonly space1: Parser<string, never, never, I>
  /** Zero or more whitespace characters, including line breaks ({@link isWhitespace}). */
  readonly multispace0: Parser<string, never, never, I>
  /** One or more whitespace characters, including line breaks ({@link isWhitespace}). */
  readonly multispace1: Parser<string, never, never, I>
  /**
   * An identifier: an {@link isIdStart} character or `_`, then any
   * {@link isIdContinue} characters (UAX #31 default identifiers).
   */
  readonly identifier: Parser<string, never, never, I>

  // Line endings

  /** `\n` */
  readonly newline: Parser<"\n", never, never, I>
  /** `\r\n` */
  readonly crlf: Parser<"\r\n", never, never, I>
  /** `\t` */
  readonly tab: Parser<"\t", never, never, I>
  /** `\n` or `\r\n`. */
  readonly lineEnding: Parser<"\n" | "\r\n", never, never, I>
  /** Everything up to (not including) a line ending. A `\r` not followed by `\n` is an error. */
  readonly tillLineEnding: Parser<string, never, never, I>

  // Numbers (ASCII digits, as in most languages)

  /** An unsigned decimal integer of ASCII digits. Fails if it is not a safe integer. */
  readonly decUint: Parser<number, string, never, I>
  /** A signed decimal integer of ASCII digits. Fails if it is not a safe integer. */
  readonly decInt: Parser<number, string, never, I>
  /** An unsigned decimal integer of ASCII digits, as a `bigint`. */
  readonly decBigUint: Parser<bigint, never, never, I>
  /** A signed decimal integer of ASCII digits, as a `bigint`. */
  readonly decBigInt: Parser<bigint, never, never, I>
  /** A hexadecimal unsigned integer, without prefix. Fails if it is not a safe integer. */
  readonly hexUint: Parser<number, string, never, I>
  /** A floating point number, as accepted by `Ascii.float`. */
  readonly float: Parser<number, never, never, I>

  // Escapes

  /**
   * Recognizes text containing escape sequences, returning it raw (see
   * `Ascii.takeEscaped`). `control` is the escape character.
   */
  readonly takeEscaped: <A, E, R, B, E2, R2>(
    normal: Parser<A, E, R, I>,
    control: string,
    escapable: Parser<B, E2, R2, I>
  ) => Parser<string, E | E2, R | R2, I>
  /**
   * Parses text containing escape sequences, returning it unescaped (see
   * `Ascii.escaped`). `control` is the escape character.
   */
  readonly escaped: <E, R, E2, R2>(
    normal: Parser<string, E, R, I>,
    control: string,
    escape: Parser<string, E2, R2, I>
  ) => Parser<string, E | E2, R | R2, I>
}

const normalize = (r: Range | undefined): [number, number] => {
  if (r === undefined) return [0, Infinity]
  if (typeof r === "number") return [r, r]
  return [r.min ?? 0, r.max ?? Infinity]
}

const isAsciiDigit = /*#__PURE__*/ codePointPredicate("isAsciiDigit", (c: number): boolean => c >= 48 && c <= 57, [
  [48, 57]
])
const isAsciiHexDigit = /*#__PURE__*/ codePointPredicate(
  "isAsciiHexDigit",
  (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102),
  [
    [48, 57],
    [65, 70],
    [97, 102]
  ]
)
const isLineBreak = (c: number): boolean => c === 10 || c === 13

const expectedAny = ["any character"]
const expectedLineEnding = ["line ending"]
const expectedIdentifier = ["identifier"]

/**
 * Builds the text parsers for an encoding.
 *
 * @example
 * ```ts
 * import { Encoding, Parser, Text } from "@thomasfosterau/effect-parse"
 *
 * const T = Text.make(Encoding.latin1)
 * Parser.parse(T.alpha1, new Uint8Array([0x63, 0x61, 0x66, 0xe9])) // "café"
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = <I extends string | Uint8Array>(encoding: Encoding<I>): TextParsers<I> => {
  const enc = encoding as Encoding<any>
  const fast = internal.fastLimit(enc)

  // Each parser records its encoding on byte input (`state.encoding`), so
  // that errors can show the input as text.
  const backtrack = (state: State<any>, kind: ErrorKind, expected: ReadonlyArray<string>, offset = state.pos): Fail =>
    state.backtrack(kind, expected, offset)

  /** The text `[start, end)` after checking it is well formed, or `Fail`. */
  const textOf = (
    state: State<any>,
    start: number,
    end: number,
    kind: ErrorKind,
    expected: ReadonlyArray<string>
  ): string | Fail => {
    const count = internal.validate(enc, state, start, end)
    if (count < 0) return backtrack(state, kind, expected, -1 - count)
    return enc.text(state.input, start, end)
  }

  const takeWhileText = (
    test: (cp: number) => boolean,
    r: Range | undefined,
    negate: boolean,
    name: string,
    expected: ReadonlyArray<string>,
    kind: ErrorKind,
    hint: boolean,
    set: unknown = test
  ): Parser<string, never, never, I> => {
    const [min, max] = normalize(r)
    return P.described<string, never, never, I>(
      (state: State<any>) => {
        if (state.inputKind === 1) state.encoding = enc
        const start = state.pos
        internal.scan(enc, state, test, negate, max, state.pos, fast)
        const offset = internal.scanOffset
        const count = internal.scanCount
        const stop = internal.scanStop
        if (state.partial && (stop === internal.End || stop === internal.Truncated))
          return state.incomplete(1, expected)
        if (count < min) return backtrack(state, kind, expected, offset)
        // More matching characters would have been accepted where we stopped
        if (hint && count < max) state.setHint(offset, expected)
        state.pos = offset
        return enc.text(state.input, start, offset)
      },
      name,
      { _tag: "TakeWhile", set, negate, min, max, encoding: enc }
    )
  }

  const any: Parser<string, never, never, I> = P.described<string, never, never, I>(
    (state: State<any>) => {
      if (state.inputKind === 1) state.encoding = enc
      const cp = internal.next(enc, state)
      if (cp < 0) return internal.failAt(state, cp, "Token", expectedAny)
      state.pos += internal.width
      return internal.charOf(cp)
    },
    "any",
    { _tag: "Any", encoding: enc }
  )

  const literal = <const L extends string>(lit: L): Parser<L, never, never, I> => {
    const encoded = enc.encode(lit)
    const len = encoded.length
    const expected = [JSON.stringify(lit)]
    const node: Node = { _tag: "Literal", literal: lit, caseless: false, encoding: enc }
    if (len === 1) {
      // Single unit literals (punctuation, mostly) are compared directly
      const unit = typeof encoded === "string" ? encoded.charCodeAt(0) : encoded[0]!
      return P.described<L, never, never, I>(
        (state: State<any>) => {
          const pos = state.pos
          if (state.inputKind === 1) state.encoding = enc
          if (pos >= state.end) return state.eoi("Literal", expected, 1)
          const input = state.input
          if ((state.inputKind === 0 ? (input as string).charCodeAt(pos) : (input as Uint8Array)[pos]) !== unit) {
            return backtrack(state, "Literal", expected)
          }
          state.pos = pos + 1
          return lit
        },
        expected[0],
        node
      )
    }
    return P.described<L, never, never, I>(
      (state: State<any>) => {
        if (state.inputKind === 1) state.encoding = enc
        const r = matchLiteral(state, encoded, false)
        if (r === -1) return backtrack(state, "Literal", expected)
        if (r === -2) {
          if (state.partial) return state.incomplete(len - (state.end - state.pos), expected)
          return backtrack(state, "Literal", expected)
        }
        state.pos += len
        return lit
      },
      expected[0],
      node
    )
  }

  const caseless = (lit: string): Parser<string, never, never, I> => {
    const folded = Array.from(lit, (c) => internal.fold(c.codePointAt(0)!))
    const expected = [`${JSON.stringify(lit)} (case insensitive)`]
    return P.described<string, never, never, I>(
      (state: State<any>) => {
        if (state.inputKind === 1) state.encoding = enc
        const start = state.pos
        let pos = start
        for (let i = 0; i < folded.length; i++) {
          const cp = internal.next(enc, state, pos)
          if (cp === internal.End || cp === internal.Truncated) {
            return state.partial ? state.incomplete(1, expected) : backtrack(state, "Literal", expected)
          }
          if (cp < 0 || internal.fold(cp) !== folded[i]) {
            state.syntax?.read(pos + Math.max(internal.width, 1))
            return backtrack(state, "Literal", expected)
          }
          pos += internal.width
        }
        state.pos = pos
        return enc.text(state.input, start, pos)
      },
      expected[0],
      { _tag: "Literal", literal: lit, caseless: true, encoding: enc }
    )
  }

  const oneOfImpl = (set: StringTokenSet, negate: boolean): Parser<string, never, never, I> => {
    const m = compile(set, "string")
    const test = m.code
    const expected = [negate ? `anything but ${m.description}` : m.description]
    const kind: ErrorKind = negate ? "NoneOf" : "OneOf"
    return P.described<string, never, never, I>(
      (state: State<any>) => {
        if (state.inputKind === 1) state.encoding = enc
        const cp = internal.next(enc, state)
        if (cp < 0) return internal.failAt(state, cp, kind, expected)
        const w = internal.width
        if (test(cp) === negate) return state.backtrack(kind, expected)
        state.pos += w
        return internal.charOf(cp)
      },
      expected[0],
      { _tag: "OneOf", set, negate, encoding: enc }
    )
  }

  const take = (count: number): Parser<string, never, never, I> => {
    const expected = [count === 1 ? "1 character" : `${count} characters`]
    return P.described<string, never, never, I>(
      (state: State<any>) => {
        if (state.inputKind === 1) state.encoding = enc
        const start = state.pos
        let pos = start
        for (let got = 0; got < count; got++) {
          const cp = internal.next(enc, state, pos)
          if (cp === internal.End) return state.eoi("Take", expected, count - got)
          if (cp < 0) return internal.failAt(state, cp, "Take", expected, pos)
          pos += internal.width
        }
        state.pos = pos
        return enc.text(state.input, start, pos)
      },
      "take",
      { _tag: "Take", count, encoding: enc }
    )
  }

  const takeUntil = (lit: string, r?: Range): Parser<string, never, never, I> => {
    const [min, max] = normalize(r)
    const needle = enc.encode(lit)
    const unit = enc.unit
    const expected = [JSON.stringify(lit)]
    return P.described<string, never, never, I>(
      (state: State<any>) => {
        if (state.inputKind === 1) state.encoding = enc
        const start = state.pos
        let idx = indexOf(state, needle as Input, start)
        // Multi-unit encodings: only accept matches on a character boundary
        while (unit > 1 && idx >= 0 && (idx - start) % unit !== 0) idx = indexOf(state, needle as Input, idx + 1)
        if (idx < 0) {
          if (state.partial) return state.incomplete(0, expected)
          return backtrack(state, "TakeUntil", expected, state.end)
        }
        // The literal was read but is not consumed
        state.syntax?.read(idx + needle.length)
        const count = internal.validate(enc, state, start, idx)
        if (count < 0) return backtrack(state, "TakeUntil", expected, -1 - count)
        // As in winnow, the first occurrence must lie within the range
        if (count < min) return backtrack(state, "TakeUntil", expected, idx)
        if (count > max) return backtrack(state, "TakeUntil", expected)
        state.pos = idx
        return enc.text(state.input, start, idx)
      },
      "takeUntil",
      { _tag: "TakeUntil", literal: lit, min, max, encoding: enc }
    )
  }

  const always = () => true
  const rest: Parser<string, never, never, I> = P.described<string, never, never, I>(
    (state: State<any>) => {
      if (state.inputKind === 1) state.encoding = enc
      const start = state.pos
      internal.scan(enc, state, always, false, Infinity, state.pos, fast)
      const offset = internal.scanOffset
      if (internal.scanStop === internal.Truncated) return state.incomplete(1, expectedAny)
      if (internal.scanStop === internal.Invalid) return backtrack(state, "Token", expectedAny, offset)
      state.pos = offset
      return enc.text(state.input, start, offset)
    },
    "rest",
    { _tag: "Rest", encoding: enc }
  )

  const taken = <A, E, R>(self: Parser<A, E, R, I>): Parser<string, E, R, I> => {
    const step = self.step
    return P.described<string, E, R, I>(
      (state: State<any>) => {
        if (state.inputKind === 1) state.encoding = enc
        const start = state.pos
        if (step(state) === Fail) return Fail
        return textOf(state, start, state.pos, "Slice", expectedAny)
      },
      self.name,
      { _tag: "Taken", self, encoding: enc }
    )
  }

  const cls = (test: CharPredicate, min: 0 | 1, description: string, kind: ErrorKind, hint = true) =>
    takeWhileText(test as any, { min }, false, `${kind.toLowerCase()}${min}`, [description], kind, hint)

  const identifierStart = (cp: number) => cp === 95 || isIdStart(cp)
  const identifier: Parser<string, never, never, I> = P.described<string, never, never, I>(
    (state: State<any>) => {
      if (state.inputKind === 1) state.encoding = enc
      const start = state.pos
      const cp = internal.next(enc, state)
      if (cp < 0) return internal.failAt(state, cp, "TakeWhile", expectedIdentifier)
      if (!identifierStart(cp)) return state.backtrack("TakeWhile", expectedIdentifier)
      internal.scan(enc, state, isIdContinue as any, false, Infinity, start + internal.width, fast)
      const stop = internal.scanStop
      if (state.partial && (stop === internal.End || stop === internal.Truncated)) {
        return state.incomplete(1, expectedIdentifier)
      }
      state.pos = internal.scanOffset
      return enc.text(state.input, start, state.pos)
    },
    "identifier",
    { _tag: "Identifier", encoding: enc }
  )

  // Decoded rather than matched as a literal, as not every encoding can encode it
  const bom: Parser<boolean, never, never, I> = P.described<boolean, never, never, I>(
    (state: State<any>) => {
      if (state.inputKind === 1) state.encoding = enc
      const cp = internal.next(enc, state)
      if (cp === 0xfeff) {
        state.pos += internal.width
        return true
      }
      if (cp === internal.Truncated || (cp === internal.End && state.partial)) {
        return state.incomplete(1, ["byte order mark"])
      }
      return false
    },
    "bom",
    { _tag: "Bom", encoding: enc }
  )

  const newline = literal("\n")
  const crlf = literal("\r\n")

  const tillLineEnding: Parser<string, never, never, I> = P.described<string, never, never, I>(
    (state: State<any>) => {
      if (state.inputKind === 1) state.encoding = enc
      const start = state.pos
      internal.scan(enc, state, isLineBreak, true, Infinity, state.pos, fast)
      const offset = internal.scanOffset
      const stop = internal.scanStop
      if (stop === internal.Truncated || (stop === internal.End && state.partial)) {
        return state.incomplete(1, expectedLineEnding)
      }
      if (stop === internal.Invalid) return backtrack(state, "LineEnding", expectedLineEnding, offset)
      if (stop === 0 && internal.next(enc, state, offset) === 13) {
        const cr = internal.width
        // The line feed after it is read, not consumed
        state.syntax?.read(offset + 2 * cr)
        const after = internal.next(enc, state, offset + cr)
        if (after === internal.End && state.partial) return state.incomplete(1, expectedLineEnding)
        if (after !== 10) return backtrack(state, "LineEnding", expectedLineEnding, offset)
      }
      state.pos = offset
      return enc.text(state.input, start, offset)
    },
    "tillLineEnding",
    { _tag: "TillLineEnding", encoding: enc }
  )

  const asciiDigits = takeWhileText(isAsciiDigit, { min: 1 }, false, "digit1", ["digit"], "Digit", true)
  const hexDigits = takeWhileText(
    isAsciiHexDigit,
    { min: 1 },
    false,
    "hexDigit1",
    ["hexadecimal digit"],
    "HexDigit",
    true
  )
  const sign = P.opt(oneOfImpl("+-", false))
  const signed = taken(P.seq(sign, asciiDigits))

  const exponent = P.opt(P.seq(oneOfImpl("eE", false), sign, asciiDigits))
  const unsignedFloat = P.alt(
    P.seq(caseless("inf"), P.opt(caseless("inity"))),
    P.seq(literal("."), asciiDigits, exponent),
    P.seq(asciiDigits, P.opt(P.seq(literal("."), P.opt(asciiDigits))), exponent)
  )
  const floatText = markFloatText(taken(P.alt(caseless("nan"), P.seq(sign, unsignedFloat))).pipe(P.expected("number")))

  const matchControl = (control: string) => {
    const ctrl = control.codePointAt(0)!
    return (state: State<any>): boolean => {
      if (internal.next(enc, state) !== ctrl) return false
      state.pos += internal.width
      return true
    }
  }

  return {
    encoding,
    any,
    literal,
    caseless,
    oneOf: (set) => oneOfImpl(set, false),
    noneOf: (set) => oneOfImpl(set, true),
    bom,
    take,
    takeWhile: (set, r) => {
      const m = compile(set, "string")
      return takeWhileText(m.code, r, false, "takeWhile", [m.description], "TakeWhile", false, set)
    },
    takeTill: (set, r) => {
      const m = compile(set, "string")
      return takeWhileText(m.code, r, true, "takeTill", [`anything but ${m.description}`], "TakeWhile", false, set)
    },
    takeUntil,
    rest,
    taken,
    alpha0: cls(isAlphabetic, 0, "letter", "Alpha"),
    alpha1: cls(isAlphabetic, 1, "letter", "Alpha"),
    digit0: cls(isDecimalDigit, 0, "digit", "Digit"),
    digit1: cls(isDecimalDigit, 1, "digit", "Digit"),
    alphanumeric0: cls(isAlphanumeric, 0, "letter or digit", "AlphaNumeric"),
    alphanumeric1: cls(isAlphanumeric, 1, "letter or digit", "AlphaNumeric"),
    space0: cls(isSpace, 0, "space", "Space", false),
    space1: cls(isSpace, 1, "space", "Space", false),
    multispace0: cls(isWhitespace, 0, "whitespace", "MultiSpace", false),
    multispace1: cls(isWhitespace, 1, "whitespace", "MultiSpace", false),
    identifier,
    newline,
    crlf,
    tab: literal("\t"),
    lineEnding: P.alt(newline, crlf).pipe(P.expected("line ending")),
    tillLineEnding,
    decUint: asciiDigits.pipe(
      P.tryMap((s) => overflow(Number(s))),
      P.named("decUint")
    ),
    decInt: signed.pipe(
      P.tryMap((s) => overflow(Number(s))),
      P.named("decInt")
    ),
    decBigUint: asciiDigits.pipe(P.map((s) => BigInt(s))),
    decBigInt: signed.pipe(P.map((s) => BigInt(s.startsWith("+") ? s.slice(1) : s))),
    hexUint: hexDigits.pipe(
      P.tryMap((s) => overflow(parseInt(s, 16))),
      P.named("hexUint")
    ),
    float: floatText.pipe(P.map(toFloat), P.named("float")),
    takeEscaped: (normal, control, escapable) =>
      takeEscapedImpl(
        normal,
        matchControl(control),
        escapable,
        (state, start) => enc.text(state.input, start, state.pos),
        control.codePointAt(0)!,
        enc
      ),
    escaped: (normal, control, escape) =>
      escapedImpl(normal, matchControl(control), escape, control.codePointAt(0)!, enc)
  }
}

/**
 * Text parsers for JavaScript strings.
 *
 * @since 0.1.0
 * @category instances
 */
export const string: TextParsers<string> = /*#__PURE__*/ make(Encodings.string)

/**
 * Text parsers for UTF-8 encoded bytes.
 *
 * @example
 * ```ts
 * import { Parser, Text } from "@thomasfosterau/effect-parse"
 *
 * const bytes = new TextEncoder().encode("naïve café")
 * Parser.parse(Parser.separatedPair(Text.utf8.alpha1, Text.utf8.space1, Text.utf8.alpha1), bytes)
 * // Result.succeed(["naïve", "café"])
 * ```
 *
 * @since 0.1.0
 * @category instances
 */
export const utf8: TextParsers<Uint8Array> = /*#__PURE__*/ make(Encodings.utf8)

/**
 * Text parsers for UTF-16 little endian bytes.
 *
 * @since 0.1.0
 * @category instances
 */
export const utf16le: TextParsers<Uint8Array> = /*#__PURE__*/ make(Encodings.utf16le)

/**
 * Text parsers for UTF-16 big endian bytes.
 *
 * @since 0.1.0
 * @category instances
 */
export const utf16be: TextParsers<Uint8Array> = /*#__PURE__*/ make(Encodings.utf16be)

/**
 * Text parsers for ISO-8859-1 (Latin-1) bytes.
 *
 * @since 0.1.0
 * @category instances
 */
export const latin1: TextParsers<Uint8Array> = /*#__PURE__*/ make(Encodings.latin1)
