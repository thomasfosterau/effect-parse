/**
 * Compiles a regex syntax tree to an effect-parse parser over UTF-8 bytes.
 *
 * The parser is a backtracking matcher in continuation-passing style: each
 * node is compiled together with the parser for everything after it, so an
 * ordered choice (`Parser.alt`) that fails later in the pattern falls back
 * to its next alternative. That gives Rust's leftmost-first semantics
 * (which are Perl's) from PEG combinators. Repetition of a single character
 * class is a `Parser.combinator` that takes the longest run and gives
 * characters back one at a time, so `.*` costs no stack per character; other
 * repetitions recurse through `Parser.suspend`, with a guard that stops an
 * iteration that matched nothing from looping.
 *
 * The result can be compiled with `Compiler.jit`, `Compiler.closure` or
 * `Compiler.wasm` like any other grammar.
 *
 * @since 0.0.0
 */
import { Compiler, Input, Parser, Text, Token } from "@thomasfosterau/effect-parse"
import * as Schema from "effect/Schema"
import type { Look, Regex } from "./ast.ts"
import * as Ast from "./ast.ts"
import * as CharSet from "./charset.ts"
import type { Ranges } from "./charset.ts"

type Bytes = Uint8Array
/** A matcher node with its continuation: succeeds (with nothing) when the rest of the pattern matches. */
type Step = Parser.Parser<void, never, never, Bytes>
/** A parser for one character: a literal's bytes, a byte, or a decoded character (the value is never used). */
type CharParser = Parser.Parser<Uint8Array | number | string, never, never, Bytes>

/**
 * Which effect-parse compiler runs the matcher: `"jit"`, `"closure"`,
 * `"wasm"`, or `"none"` for the interpreter.
 *
 * @since 0.0.0
 */
export type Backend = "jit" | "closure" | "wasm" | "none"

/**
 * Options for {@link compile}.
 *
 * @since 0.0.0
 */
export interface CompileOptions {
  /** Record capture groups (needed for `--replace`). */
  readonly captures: boolean
  /** The compiler to run the matcher with. */
  readonly backend: Backend
}

/**
 * A match: the byte offsets `[start, end)` in the haystack.
 *
 * @since 0.0.0
 */
export interface Match {
  readonly start: number
  readonly end: number
  /** The capture slots (`[start, end]` per group), when captures are recorded. */
  readonly groups: ReadonlyArray<number> | undefined
}

/**
 * A compiled regex.
 *
 * @since 0.0.0
 */
export interface Matcher {
  /**
   * The leftmost-first match starting at or after `from`, or `undefined`.
   * Throws {@link TooDeep} when the pattern recursed past the stack.
   */
  readonly find: (state: Input.State<Bytes>, from: number) => Match | undefined
  /** The end of a match starting exactly at `at`, or -1. */
  readonly matchAt: (state: Input.State<Bytes>, at: number) => number
  /** The capture slots of the last match: `[start, end]` per group, `-1` where unset. */
  readonly slots: ReadonlyArray<number>
  /** The number of groups, group 0 (the whole match) included. */
  readonly groups: number
}

/**
 * Thrown when a match attempt nests deeper than the JavaScript stack allows
 * (a repetition of a complex group over a very long line).
 *
 * @since 0.0.0
 */
export class TooDeep extends Schema.TaggedError<TooDeep, { readonly brand: unique symbol }>()("TooDeep", {
  /** The haystack offset where the attempt started. */
  offset: Schema.Finite
}) {}

// ---------------------------------------------------------------------------
// UTF-8 helpers for the zero-width assertions
// ---------------------------------------------------------------------------

/** How many continuation bytes follow a UTF-8 lead byte, or -1 for a byte that cannot start a character. */
const continuationCount = (x: number): number =>
  x < 0x80 ? 0 : x < 0xc2 ? -1 : x < 0xe0 ? 1 : x < 0xf0 ? 2 : x < 0xf8 ? 3 : -1

/** The payload bits of a lead byte, by continuation count. */
const leadMask = [0x7f, 0x1f, 0x0f, 0x07]

/** The code point starting at `i`, or -1 for the end of input or invalid UTF-8. */
const decodeAt = (b: Bytes, i: number): number => {
  const need = i < b.length ? continuationCount(b[i]) : -1
  if (need < 0 || i + need >= b.length) return -1
  let c = b[i] & (leadMask[need] ?? 0)
  for (let k = 1; k <= need; k++) {
    const y = b[i + k]
    if ((y & 0xc0) !== 0x80) return -1
    c = (c << 6) | (y & 0x3f)
  }
  return c
}

/** The code point ending at `i` (exclusive), or -1 at the start or for invalid UTF-8. */
const decodeBefore = (b: Bytes, i: number): number => {
  if (i <= 0) return -1
  let start = i - 1
  while (start > 0 && i - start < 4 && (b[start] & 0xc0) === 0x80) start--
  const c = decodeAt(b, start)
  if (c < 0) return -1
  const width = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  return start + width === i ? c : -1
}

const unicodeWordTest = (): ((c: number) => boolean) => {
  const word = CharSet.unicodeWord()
  return (c) => c >= 0 && (c < 128 ? isAsciiWord(c) : CharSet.has(word, c))
}

const isAsciiWord = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || (c >= 0x61 && c <= 0x7a)

const lookTest = (look: Look, lineTerminator: number): ((b: Bytes, i: number) => boolean) => {
  const asciiWordAt = (c: number) => c >= 0 && isAsciiWord(c)
  const word = look.endsWith("Ascii") ? asciiWordAt : unicodeWordTest()
  const before = (b: Bytes, i: number) => word(decodeBefore(b, i))
  const after = (b: Bytes, i: number) => word(decodeAt(b, i))
  switch (look) {
    case "StartText":
      return (_b, i) => i === 0
    case "EndText":
      return (b, i) => i === b.length
    case "StartLine":
      return (b, i) => i === 0 || b[i - 1] === lineTerminator
    case "EndLine":
      return (b, i) => i === b.length || b[i] === lineTerminator
    case "StartLineCrlf":
      return (b, i) => i === 0 || b[i - 1] === 0x0a || (b[i - 1] === 0x0d && b[i] !== 0x0a)
    case "EndLineCrlf":
      return (b, i) => i === b.length || b[i] === 0x0d || (b[i] === 0x0a && b[i - 1] !== 0x0d)
    case "WordBoundary":
    case "WordBoundaryAscii":
      return (b, i) => before(b, i) !== after(b, i)
    case "NotWordBoundary":
    case "NotWordBoundaryAscii":
      return (b, i) => before(b, i) === after(b, i)
    case "WordStart":
    case "WordStartAscii":
      return (b, i) => !before(b, i) && after(b, i)
    case "WordEnd":
    case "WordEndAscii":
      return (b, i) => before(b, i) && !after(b, i)
    case "WordStartHalf":
    case "WordStartHalfAscii":
      return (b, i) => !before(b, i)
    case "WordEndHalf":
    case "WordEndHalfAscii":
      return (b, i) => !after(b, i)
  }
}

/** The start of the code point before `i` (all bytes before `i` matched as valid UTF-8). */
const previousBoundary = (b: Bytes, i: number): number => {
  let j = i - 1
  while (j > 0 && (b[j] & 0xc0) === 0x80) j--
  return j
}

// ---------------------------------------------------------------------------
// The compiler
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

/** One character of a class, as a parser: a byte test for ASCII-only sets. */
const charOf = (set: Ranges): CharParser => {
  const name = "character class"
  const single = CharSet.single(set)
  if (single !== undefined) return Token.literal(encoder.encode(String.fromCodePoint(single)))
  return CharSet.isAscii(set)
    ? Token.oneOf<Bytes>(CharSet.toCodePoints(name, set))
    : Text.utf8.oneOf(CharSet.toCodePoints(name, set))
}

type CharStepFn = (state: Input.State<Bytes>) => Uint8Array | number | string | Input.Fail
type StepFn = (state: Input.State<Bytes>) => void | Input.Fail

/**
 * Greedy: takes as many characters as allowed, then tries `k`, giving one
 * character back after each failure.
 */
const greedyRepeat = (
  charStep: CharStepFn,
  kStep: StepFn,
  state: Input.State<Bytes>,
  min: number,
  max: number
): void | Input.Fail => {
  const start = state.pos
  let n = 0
  let before = start
  while (n < max && charStep(state) !== Input.Fail) {
    n++
    before = state.pos
  }
  // A failed attempt may have moved the cursor.
  state.rewind(before)
  if (n < min) {
    state.rewind(start)
    return state.backtrack("Token")
  }
  for (; ; n--) {
    const at = state.pos
    const r = kStep(state)
    if (r !== Input.Fail || state.mode !== "Backtrack") return r
    if (n === min) {
      state.rewind(start)
      return Input.Fail
    }
    state.rewind(previousBoundary(state.input, at))
  }
}

/** Lazy: takes the fewest characters allowed, then one more after each failure of `k`. */
const lazyRepeat = (
  charStep: CharStepFn,
  kStep: StepFn,
  state: Input.State<Bytes>,
  min: number,
  max: number
): void | Input.Fail => {
  const start = state.pos
  for (let n = 0; ; n++) {
    if (n >= min) {
      const at = state.pos
      const r = kStep(state)
      if (r !== Input.Fail || state.mode !== "Backtrack") return r
      state.rewind(at)
    }
    if (n >= max || charStep(state) === Input.Fail) {
      state.rewind(start)
      return Input.Fail
    }
  }
}

/** `char` repeated between `min` and `max` times, then `k`, backtracking one character at a time. */
const repeatChar = (char: CharParser, k: Step, min: number, max: number, greedy: boolean): Step =>
  Parser.combinator([char, k], ([charStep, kStep]) =>
    greedy
      ? (state) => greedyRepeat(charStep, kStep, state, min, max)
      : (state) => lazyRepeat(charStep, kStep, state, min, max)
  )

interface Context {
  readonly slots: Array<number>
  readonly frames: Array<Array<number>>
  readonly captures: boolean
  readonly lineTerminator: number
}

const assertion = (test: (b: Bytes, i: number) => boolean, k: Step): Step =>
  Parser.combinator(
    [k],
    ([kStep]) =>
      (state) =>
        test(state.input, state.pos) ? kStep(state) : state.backtrack("Token", ["assertion"])
  )

const setSlot = (ctx: Context, slot: number, k: Step): Step =>
  Parser.combinator([k], ([kStep]) => (state) => {
    const old = ctx.slots[slot]
    ctx.slots[slot] = state.pos
    const r = kStep(state)
    if (r === Input.Fail) ctx.slots[slot] = old
    return r
  })

/** The single character a repetition repeats, if it repeats one. */
const singleChar = (regex: Regex): Ranges | undefined => {
  if (regex._tag === "Class") return regex.set
  if (regex._tag === "Literal") {
    const c = regex.text.codePointAt(0) ?? 0
    return String.fromCodePoint(c).length === regex.text.length ? CharSet.of(c) : undefined
  }
  return undefined
}

/** An unbounded repetition of a complex sub-pattern. */
const loop = (ctx: Context, sub: Regex, greedy: boolean, k: Step): Step => {
  // Tied below: the loop's body continues with the loop itself.
  let core: Step = Parser.void_
  const again: Step = Parser.suspend(() => core)
  if (Ast.minLength(sub) > 0) {
    const body = compileNode(ctx, sub, again)
    core = greedy ? Parser.alt(body, k) : Parser.alt(k, body)
    return core
  }
  // The sub-pattern can match the empty string: an iteration that consumed
  // nothing ends the loop, as in Rust, instead of repeating forever. `frame`
  // holds where the current iteration of each active entry began.
  const frame: Array<number> = []
  ctx.frames.push(frame)
  const iterate: Step = Parser.combinator([again], ([coreStep]) => (state) => {
    const top = frame.length - 1
    const began = frame[top]
    if (state.pos === began) return state.backtrack("Token")
    frame[top] = state.pos
    const r = coreStep(state)
    if (r === Input.Fail) frame[top] = began
    return r
  })
  const body = compileNode(ctx, sub, iterate)
  core = greedy ? Parser.alt(body, k) : Parser.alt(k, body)
  return Parser.combinator([core], ([coreStep]) => (state) => {
    frame.push(state.pos)
    const r = coreStep(state)
    frame.pop()
    return r
  })
}

const repeat = (ctx: Context, regex: Extract<Regex, { _tag: "Repeat" }>, k: Step): Step => {
  const { greedy, max, min, sub } = regex
  const char = singleChar(sub)
  if (char !== undefined) return repeatChar(charOf(char), k, min, max, greedy)
  let tail: Step
  if (max === Infinity) {
    tail = loop(ctx, sub, greedy, k)
  } else {
    tail = k
    for (let j = 0; j < max - min; j++) {
      const more = compileNode(ctx, sub, tail)
      tail = greedy ? Parser.alt(more, k) : Parser.alt(k, more)
    }
  }
  for (let i = 0; i < min; i++) tail = compileNode(ctx, sub, tail)
  return tail
}

const compileNode = (ctx: Context, regex: Regex, k: Step): Step => {
  switch (regex._tag) {
    case "Empty":
      return k
    case "Literal":
      return Parser.preceded(Token.literal(encoder.encode(regex.text)), k)
    case "Class":
      return CharSet.isEmpty(regex.set)
        ? Parser.backtrack(Parser.failMessage("empty class"))
        : Parser.preceded(charOf(regex.set), k)
    case "Look":
      return assertion(lookTest(regex.look, ctx.lineTerminator), k)
    case "Repeat":
      return repeat(ctx, regex, k)
    case "Capture":
      if (!ctx.captures) return compileNode(ctx, regex.sub, k)
      return setSlot(ctx, 2 * regex.index, compileNode(ctx, regex.sub, setSlot(ctx, 2 * regex.index + 1, k)))
    case "Concat":
      return regex.subs.reduceRight((next, sub) => compileNode(ctx, sub, next), k)
    case "Alternate":
      return Parser.alt(...regex.subs.map((sub) => compileNode(ctx, sub, k)))
  }
}

const backends: Record<Backend, (p: Step) => Step> = {
  jit: Compiler.jit,
  closure: Compiler.closure,
  wasm: Compiler.wasm,
  none: (p) => p
}

const noDiagnostics: Parser.RunOptions = { diagnostics: false }

/**
 * Compiles a regex to a {@link Matcher}. `groups` is the number of capture
 * groups including group 0; `lineTerminator` is the byte `^` and `$` treat
 * as the end of a line.
 *
 * @example
 * ```ts
 * import { Input } from "@thomasfosterau/effect-parse"
 * import * as Compile from "./compile.ts"
 * import * as Syntax from "./syntax.ts"
 *
 * const parsed = Syntax.parse("b+", Syntax.Flags.Unicode)
 * ```
 *
 * @since 0.0.0
 */
export const compile = (regex: Regex, groups: number, lineTerminator: number, options: CompileOptions): Matcher => {
  const ctx: Context = {
    slots: Array.from({ length: 2 * groups }, () => -1),
    frames: [],
    captures: options.captures,
    lineTerminator
  }
  const accept: Step = Parser.succeed(undefined)
  const parser = backends[options.backend](compileNode(ctx, regex, accept))
  const { frames, slots } = ctx
  const find = (state: Input.State<Bytes>, from: number): Match | undefined => {
    const input = state.input
    const length = input.length
    for (let s = from; s <= length;) {
      for (const f of frames) f.length = 0
      if (options.captures) slots.fill(-1)
      if (Parser.run(parser, state.reset(s), noDiagnostics) !== Input.Fail) {
        slots[0] = s
        slots[1] = state.pos
        return { start: s, end: state.pos, groups: options.captures ? slots.slice() : undefined }
      }
      if (state.mode !== "Backtrack") throw new TooDeep({ offset: s })
      s++
      while (s < length && (input[s] & 0xc0) === 0x80) s++
    }
    return undefined
  }
  const matchAt = (state: Input.State<Bytes>, at: number): number => {
    for (const f of frames) f.length = 0
    return Parser.run(parser, state.reset(at), noDiagnostics) === Input.Fail ? -1 : state.pos
  }
  return { find, matchAt, slots, groups }
}
