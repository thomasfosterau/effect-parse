/**
 * The error type produced when running a parser.
 *
 * `ParseError` merges winnow's `ContextError`/`ParseError` and nom's
 * `VerboseError`. It records where parsing failed, what was expected there,
 * the context labels that were active, and an optional typed `cause`
 * produced by `Parser.fail`, `Parser.tryMap` and friends. Its `message`
 * shows the failing position in the input:
 *
 * ```text
 * Parse error at line 1, column 4:
 * 1 | [1,,2]
 *   |    ^
 * expected digit
 * ```
 *
 * `ParseError` is a `Data.TaggedError`, so it can be yielded directly inside
 * `Effect.gen`.
 *
 * @since 0.1.0
 */
import * as Arr from "effect/Array"
import * as Predicate from "effect/Predicate"
import * as Data from "effect/Data"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import type { Encoding } from "./Encoding.js"
import type { ErrMode, Failure, Input } from "./Input.js"
import * as text from "./internal/text.js"

/**
 * The kind of parser that produced an error, in the spirit of nom's
 * `ErrorKind`.
 *
 * `"TooDeep"` is not produced by a parser: the runners report it when
 * deeply nested input exhausts the call stack (see `Parser.suspend`).
 *
 * @since 0.1.0
 * @category models
 */
export type ErrorKind =
  | "Alpha"
  | "AlphaNumeric"
  | "Alt"
  | "Assert"
  | "Bits"
  | "Complete"
  | "CrLf"
  | "Digit"
  | "Dispatch"
  | "Eof"
  | "Escaped"
  | "Fail"
  | "Float"
  | "HexDigit"
  | "Incomplete"
  | "LineEnding"
  | "Literal"
  | "Many"
  | "MultiSpace"
  | "NoneOf"
  | "Not"
  | "OctDigit"
  | "OneOf"
  | "Permutation"
  | "Separated"
  | "Slice"
  | "Space"
  | "Take"
  | "TakeUntil"
  | "TakeWhile"
  | "Token"
  | "TooDeep"
  | "Verify"

/**
 * @since 0.1.0
 * @category type ids
 */
export const TypeId = "~effect-parse/ParseError" as const

/**
 * An error produced by running a parser.
 *
 * @since 0.1.0
 * @category models
 */
export class ParseError<out E = never>
  extends /*#__PURE__*/ Data.TaggedError("ParseError")<{
    /** The input that was being parsed. */
    readonly input: Input
    /** The offset of the failure in the input. */
    readonly offset: number
    /** The kind of parser that failed. */
    readonly kind: ErrorKind
    /** How the error propagated before parsing stopped. */
    readonly mode: ErrMode
    /** Descriptions of what was expected at `offset`. */
    readonly expected: ReadonlyArray<string>
    /** Context labels (`Parser.context`), innermost first. */
    readonly context: ReadonlyArray<string>
    /** The user supplied cause, if any. */
    readonly cause: E | undefined
    /** An optional free-form description. */
    readonly description: string | undefined
    /**
     * For byte inputs parsed by `Text` parsers, the text encoding. Errors
     * then show the input as text, with line and column numbers.
     */
    readonly encoding?: Encoding<Uint8Array> | undefined
  }>
{
  /**
   * @since 0.1.0
   */
  readonly [TypeId]: typeof TypeId = TypeId

  /**
   * The 1-based line and column of the failure (for strings and encoded
   * text; for other inputs the line is 1 and the column is `offset + 1`).
   *
   * @since 0.1.0
   */
  get position(): LineColumn {
    return lineColumn(this.input, this.offset, this.encoding)
  }

  /**
   * The rendered, human-readable error message.
   *
   * @since 0.1.0
   */
  override get message(): string {
    return render(this)
  }

  /**
   * @since 0.1.0
   */
  override toString(): string {
    return `ParseError: ${this.message}`
  }
}

/**
 * @since 0.1.0
 * @category guards
 */
export const isParseError = (u: unknown): u is ParseError<unknown> => Predicate.isObjectOrArray(u) && TypeId in u

/**
 * Builds a `ParseError` from the failure details recorded while parsing.
 *
 * @since 0.1.0
 * @category constructors
 */
export const fromFailure = <E = never>(
  input: Input,
  failure: Failure,
  mode: ErrMode,
  encoding?: Encoding<any>
): ParseError<E> =>
  new ParseError<E>({
    input,
    offset: failure.offset,
    kind: failure.kind,
    mode,
    expected: failure.expected,
    context: failure.context,
    cause: failure.hasCause ? (failure.cause as E) : undefined,
    description: failure.message,
    encoding: input instanceof Uint8Array ? encoding : undefined
  })

/**
 * The user supplied cause of an error, if any.
 *
 * @since 0.1.0
 * @category getters
 */
export const getCause = <E>(self: ParseError<E>): Option.Option<E> =>
  self.cause === undefined ? Option.none() : Option.some(self.cause)

/**
 * A 1-based line/column position.
 *
 * @since 0.1.0
 * @category models
 */
export interface LineColumn {
  readonly line: number
  readonly column: number
}

/**
 * Computes the 1-based line and column (in code points) of an offset. Lines
 * are separated by `\n`. Byte inputs are read as text when an `encoding`
 * is given. For other inputs the line is always 1 and the column is
 * `offset + 1`.
 *
 * @since 0.1.0
 * @category utils
 */
export const lineColumn = (input: Input, offset: number, encoding?: Encoding<any>): LineColumn => {
  if (encoding !== undefined && input instanceof Uint8Array) {
    let line = 1
    let column = 1
    text.walk(encoding, input, 0, Math.min(offset, input.length), (cp) => {
      if (cp === 10) {
        line++
        column = 1
      } else {
        column++
      }
    })
    return { line, column }
  }
  if (!Predicate.isString(input)) return { line: 1, column: offset + 1 }
  let line = 1
  let lineStart = 0
  for (let i = 0; i < offset && i < input.length; i++) {
    if (input.charCodeAt(i) === 10) {
      line++
      lineStart = i + 1
    }
  }
  return { line, column: codePointCount(input, lineStart, Math.min(offset, input.length)) + 1 }
}

const codePointCount = (s: string, start: number, end: number): number => {
  let n = 0
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < end) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) i++
    }
    n++
  }
  return n
}

/**
 * Formats a list of expectations: `a`, `a or b`, `a, b or c`.
 *
 * @since 0.1.0
 * @category utils
 */
export const formatExpected = (expected: ReadonlyArray<string>): string => {
  if (Arr.isReadonlyArrayEmpty(expected)) return ""
  if (expected.length === 1) return expected[0]
  return `${expected.slice(0, -1).join(", ")} or ${expected[expected.length - 1]}`
}

const hexBytes = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => `0x${b.toString(16).padStart(2, "0")}`).join(" ")

const describeFound = (input: Input, offset: number, encoding: Encoding<any> | undefined): string => {
  if (offset >= input.length) return "end of input"
  if (encoding !== undefined && input instanceof Uint8Array) {
    const cp = encoding.decode(input, offset, input.length)
    if (cp >= 0) return JSON.stringify(String.fromCodePoint(cp))
    const bad = input.subarray(offset, Math.min(input.length, offset + Math.max(encoding.unit, 1)))
    return cp === text.Truncated
      ? `incomplete ${encoding.name} sequence ${hexBytes(input.subarray(offset))}`
      : `invalid ${encoding.name} ${hexBytes(bad)}`
  }
  if (Predicate.isString(input)) {
    const cp = input.codePointAt(offset) ?? Number.NaN
    return JSON.stringify(String.fromCodePoint(cp))
  }
  if (input instanceof Uint8Array) {
    return `0x${input[offset].toString(16).padStart(2, "0")}`
  }
  return inspectToken(input[offset])
}

/** @internal */
export const inspectToken = (u: unknown): string => {
  if (Predicate.isString(u)) return JSON.stringify(u)
  if (Predicate.isObjectOrArray(u)) {
    // `JSON.stringify` throws on cycles and `BigInt`s. Fall back to what
    // `String` gives an array (its elements joined) or an object's tag
    // (`[object Map]`), never a user `toString` that might throw in turn.
    return Result.getOrElse(
      Result.try(() => JSON.stringify(u)),
      () => (Array.isArray(u) ? u.join(",") : Object.prototype.toString.call(u))
    )
  }
  return String(u)
}

const causeMessage = (cause: unknown): string | undefined => {
  if (cause === undefined) return undefined
  if (Predicate.isString(cause)) return cause
  // An `Error`'s message, or any other object's string `message`
  if (Predicate.isObjectOrArray(cause) && "message" in cause && Predicate.isString(cause.message)) {
    return cause.message
  }
  return inspectToken(cause)
}

const renderSnippet = (input: Input, offset: number, encoding: Encoding<any> | undefined): Array<string> => {
  if (encoding !== undefined && input instanceof Uint8Array) {
    // Find the line containing `offset`, then decode it
    let lineStart = 0
    let end = input.length
    let column = 1
    text.walk(encoding, input, 0, input.length, (cp, i, w) => {
      if (i >= offset && cp === 10) {
        end = i
        return false
      }
      if (i < offset) {
        if (cp === 10) {
          lineStart = i + w
          column = 1
        } else {
          column++
        }
      }
    })
    let line = text.lenientText(encoding, input, lineStart, end)
    if (line.endsWith("\r")) line = line.slice(0, -1)
    const gutter = String(lineColumn(input, offset, encoding).line)
    const pad = " ".repeat(gutter.length)
    return [`${gutter} | ${line}`, `${pad} | ${" ".repeat(column - 1)}^`]
  }
  if (Predicate.isString(input)) {
    const { column, line } = lineColumn(input, offset)
    let start = offset
    while (start > 0 && input.charCodeAt(start - 1) !== 10) start--
    let end = offset
    while (end < input.length && input.charCodeAt(end) !== 10) end++
    let text = input.slice(start, end)
    if (text.endsWith("\r")) text = text.slice(0, -1)
    const gutter = String(line)
    const pad = " ".repeat(gutter.length)
    return [`${gutter} | ${text}`, `${pad} | ${" ".repeat(column - 1)}^`]
  }
  if (input instanceof Uint8Array) {
    const start = Math.max(0, offset - 8)
    const end = Math.min(input.length, offset + 8)
    const bytes: Array<string> = []
    for (let i = start; i < end; i++) bytes.push(input[i].toString(16).padStart(2, "0"))
    const caret = (offset - start) * 3
    return [`${start.toString(16).padStart(8, "0")} | ${bytes.join(" ")}`, `${" ".repeat(8)} | ${" ".repeat(caret)}^`]
  }
  return []
}

const render = (error: ParseError<unknown>): string => {
  const { encoding, input, offset } = error
  const lines: Array<string> = []
  if (Predicate.isString(input)) {
    const { column, line } = lineColumn(input, offset)
    lines.push(`Parse error at line ${line}, column ${column}:`)
  } else if (encoding !== undefined) {
    const { column, line } = lineColumn(input, offset, encoding)
    lines.push(`Parse error at line ${line}, column ${column} (byte ${offset}):`)
  } else {
    lines.push(`Parse error at offset ${offset}:`)
  }
  lines.push(...renderSnippet(input, offset, encoding))
  for (let i = error.context.length - 1; i >= 0; i--) {
    lines.push(`while parsing ${error.context[i]}`)
  }
  const cause = causeMessage(error.cause)
  if (cause !== undefined) lines.push(cause)
  if (error.description !== undefined) lines.push(error.description)
  if (error.mode === "Incomplete") {
    lines.push("unexpected end of input (incomplete)")
  } else if (Arr.isReadonlyArrayNonEmpty(error.expected)) {
    lines.push(`expected ${formatExpected(error.expected)}, found ${describeFound(input, offset, encoding)}`)
  } else if (cause === undefined && error.description === undefined) {
    lines.push(`unexpected ${describeFound(input, offset, encoding)} (${error.kind})`)
  }
  return lines.join("\n")
}
