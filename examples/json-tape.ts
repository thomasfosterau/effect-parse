/**
 * A zero-copy JSON parser: UTF-8 bytes in, a _tape_ of fixed-size records
 * out, in memory handed out by effect-ext's `Allocator`. No JavaScript value
 * is built for the document: no objects, no arrays, no strings.
 *
 * ```ts
 * const program = Effect.gen(function* () {
 *   const parser = yield* makeParser()
 *   const doc = yield* parser.parse(new TextEncoder().encode('{"name": "Zoë", "tags": ["a", "b"]}'))
 *   const name = Option.getOrThrow(get(doc, root(doc), "name"))
 *   return String(str(doc, name)) // "Zoë": a view of the input's bytes until it is printed
 * })
 * // One arena for the tape, reused by every parse: no garbage at all
 * Effect.runSync(program.pipe(Effect.provide(Allocator.layerArena(1 << 20))))
 * ```
 *
 * The grammar is `json-fast.ts`'s, with every value-building step replaced
 * by a callback that appends a record. It is written with ordinary
 * combinators, so `Compiler.jit` compiles it whole:
 *
 * - `Parser.asVoid` over a token parser recognises it without slicing it.
 * - `Parser.mapSpan` hands a callback the offsets a parser consumed, and
 *   `Parser.tap` makes compiled code run it although its result is unused.
 * - A custom combinator (`Parser.combinator`) would also work, but the JIT
 *   hands those, and every parser inside them, to the closure compiler.
 *
 * A record is 16 bytes, described twice with `Layout.struct`: as a node
 * (`kind`, `next`, and the byte offsets `start` and `end` of its text in the
 * input) and, for numbers, as a value (`kind`, `next`, and the `f64`).
 * `next` is the index of the record after the node's last descendant, so a
 * reader steps over a subtree without visiting it. Strings are read as
 * effect-ext `Str`s over the input's own bytes (`Str.fromUtf8Unsafe` of a
 * `subarray`: `Text.utf8` has already validated them); only a string with
 * escapes is decoded into bytes of its own. A record can also be read as a
 * `BufferStruct` view (`node`).
 *
 * Records are appended only on paths the grammar has committed to (after a
 * `dispatch` on the next character, inside `cut`), so a failure is always
 * the document's failure, and the tape is cleared when a parse starts. A
 * grammar that backtracks over records must truncate the tape itself.
 */
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as R from "effect/Record"
import * as Result from "effect/Result"
import * as Allocator from "@thomasfosterau/effect-ext/Allocator"
import * as BufferStruct from "@thomasfosterau/effect-ext/BufferStruct"
import * as Layout from "@thomasfosterau/effect-ext/Layout"
import * as Str from "@thomasfosterau/effect-ext/Str"
import { Ascii, Compiler, type ParseError, Parser, Text, Token } from "@thomasfosterau/effect-parse"
import type { Json } from "./json.js"

// -----------------------------------------------------------------------------
// The tape
// -----------------------------------------------------------------------------

/** A record as a node: what it is, where its subtree ends, and its text in the input. */
export const Node = /*#__PURE__*/ Layout.struct({
  kind: Layout.u32,
  next: Layout.u32,
  start: Layout.u32,
  end: Layout.u32
})

/** The same record as a number: its value in place of the offsets. */
export const NumberNode = /*#__PURE__*/ Layout.struct({ kind: Layout.u32, next: Layout.u32, value: Layout.f64 })

/** What a record is. */
export const Kind = {
  Null: 0,
  False: 1,
  True: 2,
  Number: 3,
  /** A string whose text is the input's bytes from `start` to `end`. */
  String: 4,
  /** A string with escapes: its bytes in the input are its JSON source. */
  EscapedString: 5,
  /** An array: its elements are the records from the next one up to `next`. */
  Array: 6,
  /** An object: its members are (string, value) pairs of records, up to `next`. */
  Object: 7
} as const

/** The size of a record in bytes, and in 32-bit words. */
const RECORD = Node.size
const WORDS = RECORD / 4
// Where each field of a record is, in words (`value` in doubles)
const NEXT = Node.offsets.next / 4
const START = Node.offsets.start / 4
const END = Node.offsets.end / 4
const VALUE = NumberNode.offsets.value / 8
/** Marks the outermost container's parent. */
const NONE = 0xffffffff

/**
 * A growable run of records in one `Allocator` block.
 *
 * `Layout`'s fields are little-endian and the typed arrays that write them
 * here are in the platform's byte order: the same thing on every platform
 * JavaScript commonly runs on.
 */
export class Tape {
  /** The allocator the block came from, and goes back to. */
  readonly allocator: Allocator.Allocator
  block: Allocator.Block
  /** The records, as 32-bit words and as doubles, over `block`. */
  words: Uint32Array
  doubles: Float64Array
  /** How many records are written, and how many the block holds. */
  length = 0
  capacity: number
  /** The innermost open container, whose `next` holds its parent until it closes. */
  open = NONE
  /** Why the tape could not grow, if it could not: records are dropped from then on. */
  failure: Option.Option<Allocator.AllocationError> = Option.none()

  constructor(allocator: Allocator.Allocator, block: Allocator.Block) {
    this.allocator = allocator
    this.block = block
    this.capacity = Math.floor(block.byteLength / RECORD)
    this.words = new Uint32Array(block.buffer, block.byteOffset, this.capacity * WORDS)
    this.doubles = new Float64Array(block.buffer, block.byteOffset, this.capacity * (RECORD / 8))
  }

  /** Forgets every record, keeping the memory. */
  clear(): void {
    this.length = 0
    this.open = NONE
    this.failure = Option.none()
  }

  /** Doubles the block. Returns whether it could. */
  grow(): boolean {
    if (Option.isSome(this.failure)) return false
    const grown = this.allocator.reallocate(this.block, this.capacity * 2 * RECORD, NumberNode.align)
    if (Result.isFailure(grown)) {
      this.failure = Option.some(grown.failure)
      return false
    }
    const block = grown.success
    this.block = block
    this.capacity *= 2
    this.words = new Uint32Array(block.buffer, block.byteOffset, this.capacity * WORDS)
    this.doubles = new Float64Array(block.buffer, block.byteOffset, this.capacity * (RECORD / 8))
    return true
  }

  /** Appends a record with offsets. */
  push(kind: number, start: number, end: number): void {
    const index = this.length
    if (index === this.capacity && !this.grow()) return
    const words = this.words
    const at = index * WORDS
    words[at] = kind
    words[at + NEXT] = index + 1
    words[at + START] = start
    words[at + END] = end
    this.length = index + 1
  }

  /** Appends a number. */
  number(value: number): void {
    const index = this.length
    if (index === this.capacity && !this.grow()) return
    const at = index * WORDS
    this.words[at] = Kind.Number
    this.words[at + NEXT] = index + 1
    this.doubles[index * (RECORD / 8) + VALUE] = value
    this.length = index + 1
  }

  /** Opens a container: the records up to its `close` are inside it. */
  enter(kind: number, start: number): void {
    const index = this.length
    if (index === this.capacity && !this.grow()) return
    const words = this.words
    const at = index * WORDS
    words[at] = kind
    words[at + NEXT] = this.open
    words[at + START] = start
    this.open = index
    this.length = index + 1
  }

  /** Closes the innermost open container at the offset after its bracket. */
  leave(end: number): void {
    const index = this.open
    if (index === NONE) return
    const words = this.words
    const at = index * WORDS
    this.open = words[at + NEXT] ?? NONE
    words[at + NEXT] = this.length
    words[at + END] = end
  }

  /** The latest record's text went on past an escape: it ends at `end` and needs decoding. */
  escaped(end: number): void {
    const at = (this.length - 1) * WORDS
    this.words[at] = Kind.EscapedString
    this.words[at + END] = end
  }
}

/** Allocates an empty tape with room for `capacity` records, from the current `Allocator`. */
export const makeTape = (capacity = 1024): Effect.Effect<Tape, Allocator.AllocationError> =>
  Effect.gen(function* () {
    const allocator = yield* Allocator.Allocator
    const block = yield* Effect.fromResult(allocator.allocate(Math.max(capacity, 1) * RECORD, NumberNode.align))
    return new Tape(allocator, block)
  })

/** Returns a tape's memory to its allocator. The tape, and documents on it, must not be used again. */
export const freeTape = (tape: Tape): Effect.Effect<void> => Effect.sync(() => tape.allocator.deallocate(tape.block))

// -----------------------------------------------------------------------------
// The grammar
// -----------------------------------------------------------------------------

const ignore = (): void => {}

const T = Text.utf8

const hex4 = /*#__PURE__*/ T.takeWhile(Ascii.isHexDigit, 4).pipe(
  /*#__PURE__*/ Parser.map((digits) => parseInt(digits, 16)),
  /*#__PURE__*/ Parser.expected("4 hexadecimal digits")
)
const isHighSurrogate = (n: number) => n >= 0xd800 && n <= 0xdbff
const isLowSurrogate = (n: number) => n >= 0xdc00 && n <= 0xdfff

// \uXXXX: a high surrogate must be followed by an escaped low surrogate
const unicodeEscape = /*#__PURE__*/ Parser.alt(
  /*#__PURE__*/ hex4.pipe(
    /*#__PURE__*/ Parser.filter((n) => !isHighSurrogate(n)),
    /*#__PURE__*/ Parser.map((n) => String.fromCharCode(n))
  ),
  /*#__PURE__*/ Parser.zipWith(
    hex4,
    /*#__PURE__*/ Parser.cut(
      /*#__PURE__*/ Parser.preceded(
        /*#__PURE__*/ T.literal("\\u"),
        /*#__PURE__*/ hex4.pipe(/*#__PURE__*/ Parser.filter(isLowSurrogate))
      )
    ),
    (hi, lo) => String.fromCharCode(hi, lo)
  )
)

const escapeChar = /*#__PURE__*/ Parser.dispatch(T.any, {
  '"': /*#__PURE__*/ Parser.succeed('"'),
  "\\": /*#__PURE__*/ Parser.succeed("\\"),
  "/": /*#__PURE__*/ Parser.succeed("/"),
  b: /*#__PURE__*/ Parser.succeed("\b"),
  f: /*#__PURE__*/ Parser.succeed("\f"),
  n: /*#__PURE__*/ Parser.succeed("\n"),
  r: /*#__PURE__*/ Parser.succeed("\r"),
  t: /*#__PURE__*/ Parser.succeed("\t"),
  u: unicodeEscape
}).pipe(/*#__PURE__*/ Parser.expected("escape sequence"))

/** A run of a string's characters that need no decoding beyond UTF-8. */
const stringRun = /*#__PURE__*/ T.takeTill(['"\\', /*#__PURE__*/ Token.range("\u0000", "\u001f")])

/**
 * A string's text, between its quotes. The grammar recognises it without
 * building it (compiled code drops the strings nothing uses); a reader that
 * wants an escaped string's text runs this same parser on the string's
 * bytes, for its output.
 */
const stringText = /*#__PURE__*/ T.escaped(stringRun, "\\", /*#__PURE__*/ Parser.cut(escapeChar))
const compiledStringText = /*#__PURE__*/ Compiler.jit(/*#__PURE__*/ Parser.named(stringText, "stringText"))

/** The JSON grammar over UTF-8 bytes, appending a record to `tape` for each value. */
export const jsonTape = (tape: Tape): Parser.Parser<void, Allocator.AllocationError, never, Uint8Array> => {
  type P<A> = Parser.Parser<A, never, never, Uint8Array>

  /** Runs `f` with the offsets `p` consumed, without building `p`'s output. */
  const spanned = <A>(p: P<A>, f: (_: void, start: number, end: number) => void): P<void> =>
    Parser.tap(Parser.mapSpan(Parser.asVoid(p), f), ignore)
  const record = <A>(kind: number, p: P<A>): P<void> => spanned(p, (_, start, end) => tape.push(kind, start, end))

  const ws = Parser.asVoid(T.takeWhile(" \t\r\n"))
  const lexeme = <A>(p: P<A>): P<A> => Parser.terminated(p, ws)

  // A string's text up to its first escape is one record; the rest, if there
  // is any, extends it and marks it as escaped
  const escapes = Parser.preceded(Parser.peek(T.literal("\\")), stringText)
  const stringBody = Parser.terminated(
    record(Kind.String, stringRun),
    Parser.opt(spanned(escapes, (_, _start, end) => tape.escaped(end)))
  )
  const string = Parser.preceded(T.literal('"'), Parser.cut(Parser.terminated(stringBody, T.literal('"')))).pipe(
    Parser.context("string")
  )

  const number = Parser.asVoid(
    T.float.pipe(
      Parser.filter(Number.isFinite),
      Parser.tap((value) => tape.number(value))
    )
  )

  const comma = lexeme(T.literal(","))
  const enter = (kind: number, bracket: string) =>
    lexeme(spanned(T.literal(bracket), (_, start) => tape.enter(kind, start)))
  const leave = (bracket: string) => spanned(T.literal(bracket), (_, _start, end) => tape.leave(end))

  const array: P<void> = Parser.preceded(
    enter(Kind.Array, "["),
    Parser.cut(
      Parser.terminated(
        Parser.asVoid(
          Parser.separated(
            Parser.suspend(() => value),
            comma
          )
        ),
        leave("]")
      )
    )
  ).pipe(Parser.context("array"))

  const member = Parser.asVoid(
    Parser.separatedPair(
      lexeme(string),
      Parser.cut(lexeme(T.literal(":"))),
      Parser.suspend(() => value)
    )
  )

  const object: P<void> = Parser.preceded(
    enter(Kind.Object, "{"),
    Parser.cut(Parser.terminated(Parser.asVoid(Parser.separated(member, comma)), leave("}")))
  ).pipe(Parser.context("object"))

  const value: P<void> = lexeme(
    Parser.dispatch(Parser.peek(T.any), {
      n: record(Kind.Null, T.literal("null")),
      t: record(Kind.True, T.literal("true")),
      f: record(Kind.False, T.literal("false")),
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

  const start = Parser.tap(Parser.void, () => tape.clear())
  return Parser.preceded(start, Parser.preceded(ws, value)).pipe(
    Parser.tryMap(() => Option.match(tape.failure, { onNone: () => Result.void, onSome: Result.fail }))
  )
}

// -----------------------------------------------------------------------------
// Documents
// -----------------------------------------------------------------------------

/** A parsed document: the records on a tape, and the input their offsets point into. */
export interface Document {
  readonly tape: Tape
  readonly input: Uint8Array
}

/** A JSON parser with a tape of its own. A parse invalidates the document of the one before. */
export interface TapeParser {
  readonly tape: Tape
  readonly parse: (input: Uint8Array) => Effect.Effect<Document, ParseError.ParseError<Allocator.AllocationError>>
  readonly parseResult: (input: Uint8Array) => Result.Result<Document, ParseError.ParseError<Allocator.AllocationError>>
}

/** Makes a compiled JSON parser whose tape comes from the current `Allocator`. */
export const makeParser = (capacity?: number): Effect.Effect<TapeParser, Allocator.AllocationError> =>
  Effect.map(makeTape(capacity), (tape) => {
    const parser = Compiler.jit(jsonTape(tape))
    const parseResult = (input: Uint8Array) =>
      Result.map(Parser.parse(parser, input), (): Document => ({ tape, input }))
    return { tape, parseResult, parse: (input) => Effect.fromResult(parseResult(input)) }
  })

/** The index of the document's value. */
export const root = (_doc: Document): number => 0

/** What the record at `index` is: one of `Kind`'s values. */
export const kind = (doc: Document, index: number): number => doc.tape.words[index * WORDS] ?? Kind.Null

/** The index of the record after the node at `index` and everything inside it. */
export const next = (doc: Document, index: number): number => doc.tape.words[index * WORDS + NEXT] ?? 0

/** The record at `index` as a struct over the tape's memory. */
export const node = (doc: Document, index: number): BufferStruct.BufferStruct<typeof Node.fields> =>
  BufferStruct.view(Node, doc.tape.block, index * RECORD)

/** The number at `index`. */
export const number = (doc: Document, index: number): number => doc.tape.doubles[index * (RECORD / 8) + VALUE] ?? NaN

/** The bytes of the input the node at `index` was read from, without copying them. */
export const bytes = (doc: Document, index: number): Uint8Array => {
  const at = index * WORDS
  return doc.input.subarray(doc.tape.words[at + START], doc.tape.words[at + END])
}

const decoder = /*#__PURE__*/ new TextDecoder()

/** A string's source, between its quotes, decoded and unescaped. */
const unescape = (source: Uint8Array): string =>
  Result.getOrElse(Parser.parse(compiledStringText, source), () => decoder.decode(source))

/**
 * The string at `index`. Without escapes it is a view of the input's bytes;
 * with escapes it is decoded once, into a `Str` of its own.
 */
export const str = (doc: Document, index: number): Str.Str =>
  kind(doc, index) === Kind.EscapedString
    ? Str.fromString(unescape(bytes(doc, index)))
    : Str.fromUtf8Unsafe(bytes(doc, index))

/** The string at `index` as a JavaScript string. */
export const text = (doc: Document, index: number): string =>
  kind(doc, index) === Kind.EscapedString ? unescape(bytes(doc, index)) : decoder.decode(bytes(doc, index))

/** The indices of an array's elements, or of an object's keys (each key's value is the record after it). */
export const children = (doc: Document, index: number): Array<number> => {
  const end = next(doc, index)
  const after =
    kind(doc, index) === Kind.Object
      ? (key: number) => next(doc, next(doc, key))
      : (element: number) => next(doc, element)
  return Arr.unfold(index + 1, (child) => (child < end ? Option.some([child, after(child)] as const) : Option.none()))
}

const equalAt = (input: Uint8Array, start: number, wanted: Uint8Array): boolean => {
  for (let i = 0; i < wanted.length; i++) if (input[start + i] !== wanted[i]) return false
  return true
}

/** Whether the key at `member` is `key`: compared as bytes, in the input, unless it has escapes. */
const isKey = (doc: Document, member: number, key: Str.Str): boolean => {
  if (kind(doc, member) === Kind.EscapedString) return text(doc, member) === String(key)
  const wanted = Str.asBytes(key)
  const start = doc.tape.words[member * WORDS + START] ?? 0
  const end = doc.tape.words[member * WORDS + END] ?? 0
  return end - start === wanted.length && equalAt(doc.input, start, wanted)
}

/**
 * The index of the value of an object's member, or -1: an index rather than
 * an `Option`, so that a reader in a loop allocates nothing.
 */
export const find = (doc: Document, index: number, key: Str.Str): number => {
  if (kind(doc, index) !== Kind.Object) return -1
  const end = next(doc, index)
  let member = index + 1
  while (member < end) {
    if (isKey(doc, member, key)) return member + 1
    member = next(doc, member + 1)
  }
  return -1
}

/** The index of the value of an object's member. */
export const get = (doc: Document, index: number, key: string): Option.Option<number> => {
  const value = find(doc, index, Str.fromString(key))
  return value < 0 ? Option.none() : Option.some(value)
}

/** Builds the JavaScript value of the node at `index`, as `JSON.parse` would. */
export const toJson = (doc: Document, index: number): Json => {
  const k = kind(doc, index)
  if (k === Kind.Null) return null
  if (k === Kind.False) return false
  if (k === Kind.True) return true
  if (k === Kind.Number) return number(doc, index)
  if (k === Kind.Array) return children(doc, index).map((child) => toJson(doc, child))
  if (k === Kind.Object) {
    return R.fromEntries(children(doc, index).map((key) => [text(doc, key), toJson(doc, key + 1)] as const))
  }
  return text(doc, index)
}
