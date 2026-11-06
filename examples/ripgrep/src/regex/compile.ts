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
import { Compiler, Input, Parser, Token } from "@thomasfosterau/effect-parse"
import type { Look, Regex } from "./ast.ts"
import * as Ast from "./ast.ts"
import * as CharSet from "./charset.ts"
import type { Ranges } from "./charset.ts"
import { LineDfa } from "./dfa.ts"
import type { Finder } from "./finder.ts"
import { LiteralFinder, literalFinder, sequenceFinder } from "./finder.ts"
import * as Prefilter from "./prefilter.ts"

type Bytes = Uint8Array
/** A matcher node with its continuation: succeeds (with nothing) when the rest of the pattern matches. */
type Step = Parser.Parser<void, never, never, Bytes>

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
  /** Whether matches may span lines (`-U`); otherwise none contains the line terminator. */
  readonly multiline: boolean
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
   * When an attempt recurses past the JavaScript stack (a repetition of a
   * complex group over a very long line), it finds nothing more, and
   * {@link Matcher.takeOverflow} reports where.
   */
  readonly find: (state: Input.State<Bytes>, from: number) => Match | undefined
  /**
   * Outside multiline mode, where the DFA can say which lines hold a match:
   * like {@link Matcher.find}, but the match only tells the line it is in
   * (its start and end are a position in that line, its groups unset), so
   * no match is looked for in a line the DFA confirmed. For searches that
   * need the lines alone (no colors, `-o`, columns or match counts).
   */
  readonly findLine: ((state: Input.State<Bytes>, from: number) => Match | undefined) | undefined
  /**
   * How the matcher finds candidates, from cheapest per byte: one literal,
   * several literals or a byte-set sequence, or the regex itself on every
   * candidate line or position.
   */
  readonly cost: Cost
  /** Where an attempt overflowed the stack since the last call, if one did; clears it. */
  readonly takeOverflow: () => number | undefined
  /** The end of a match starting exactly at `at`, or -1. */
  readonly matchAt: (state: Input.State<Bytes>, at: number) => number
  /** The capture slots of the last match: `[start, end]` per group, `-1` where unset. */
  readonly slots: ReadonlyArray<number>
  /** The number of groups, group 0 (the whole match) included. */
  readonly groups: number
  /**
   * For a set of literals outside multiline mode: how many lines the input
   * has and how many hold a match, in one compiled scan (see
   * {@link lineCounter}); `undefined` for other regexes.
   */
  readonly countLines: ((input: Bytes) => LineCounts | undefined) | undefined
}

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
  // The Unicode word table is only built for a word assertion that needs it.
  let word: ((c: number) => boolean) | undefined
  const isWord = (c: number) => (word ??= look.endsWith("Ascii") ? asciiWordAt : unicodeWordTest())(c)
  const before = (b: Bytes, i: number) => isWord(decodeBefore(b, i))
  const after = (b: Bytes, i: number) => isWord(decodeAt(b, i))
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

/**
 * A class as a membership test over UTF-8 bytes: a table for ASCII, and a
 * binary search of the ranges above it.
 */
interface ClassTest {
  readonly ascii: Uint8Array
  readonly set: Ranges
  readonly asciiOnly: boolean
}

const classTest = (set: Ranges): ClassTest => {
  const ascii = new Uint8Array(128)
  for (const [a, b] of set) if (a < 128) ascii.fill(1, a, Math.min(b, 127) + 1)
  return { ascii, set, asciiOnly: CharSet.isAscii(set) }
}

const utf8Width = (c: number): number => (c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4)

/** The end of the character at `pos` if the class holds it, or -1. */
const stepClass = (t: ClassTest, b: Bytes, pos: number): number => {
  if (pos >= b.length) return -1
  const x = b[pos]
  if (x < 0x80) return t.ascii[x] === 1 ? pos + 1 : -1
  if (t.asciiOnly) return -1
  const c = decodeAt(b, pos)
  return c >= 0 && CharSet.has(t.set, c) ? pos + utf8Width(c) : -1
}

/**
 * Fails without recording a failure: the matcher runs with diagnostics off,
 * where only the mode decides what happens next, and recording one would
 * allocate on every failed step.
 */
const reject = (state: Input.State<Bytes>): Input.Fail => {
  state.mode = "Backtrack"
  return Input.Fail
}

type StepFn = (state: Input.State<Bytes>) => void | Input.Fail

/** One character of a class, then `k`. */
const classThen = (set: Ranges, k: Step): Step => {
  const t = classTest(set)
  return Parser.combinator([k], ([kStep]) => (state) => {
    const p = stepClass(t, state.input, state.pos)
    if (p < 0) return reject(state)
    state.pos = p
    return kStep(state)
  })
}

/** How far a greedy repetition of `t` reaches from `start`: the end and the count. */
const takeClass = (t: ClassTest, b: Bytes, start: number, max: number): readonly [number, number] => {
  const ascii = t.ascii
  const length = b.length
  let p = start
  let n = 0
  while (n < max && p < length) {
    const x = b[p]
    if (x < 0x80) {
      if (ascii[x] === 0) break
      p++
    } else {
      const q = stepClass(t, b, p)
      if (q < 0) break
      p = q
    }
    n++
  }
  return [p, n]
}

/**
 * Greedy: takes as many characters as allowed, then tries `k`, giving one
 * character back after each failure, and only calling `k` where its follow
 * set allows. (The matcher never builds a syntax tree, so the cursor moves
 * back by assignment rather than `rewind`.)
 */
const greedyRepeat = (
  t: ClassTest,
  kStep: StepFn,
  follow: Follow,
  state: Input.State<Bytes>,
  min: number,
  max: number
): void | Input.Fail => {
  const b = state.input
  const start = state.pos
  let [p, n] = takeClass(t, b, start, max)
  if (n < min) return reject(state)
  for (; ; n--) {
    if (follows(follow, b, p)) {
      state.pos = p
      const r = kStep(state)
      if (r !== Input.Fail || state.mode !== "Backtrack") return r
    }
    if (n === min) {
      state.pos = start
      return reject(state)
    }
    p = t.asciiOnly ? p - 1 : previousBoundary(b, p)
  }
}

/** Lazy: takes the fewest characters allowed, then one more after each failure of `k`. */
const lazyRepeat = (
  t: ClassTest,
  kStep: StepFn,
  follow: Follow,
  state: Input.State<Bytes>,
  min: number,
  max: number
): void | Input.Fail => {
  const b = state.input
  const start = state.pos
  let p = start
  for (let n = 0; ; n++) {
    if (n >= min && follows(follow, b, p)) {
      state.pos = p
      const r = kStep(state)
      if (r !== Input.Fail || state.mode !== "Backtrack") return r
    }
    const q = n < max ? stepClass(t, b, p) : -1
    if (q < 0) {
      state.pos = start
      return reject(state)
    }
    p = q
  }
}

/** A class repeated between `min` and `max` times, then `k`, backtracking one character at a time. */
const repeatChar = (set: Ranges, k: Step, follow: Follow, min: number, max: number, greedy: boolean): Step => {
  const t = classTest(set)
  return Parser.combinator([k], ([kStep]) =>
    greedy
      ? (state) => greedyRepeat(t, kStep, follow, state, min, max)
      : (state) => lazyRepeat(t, kStep, follow, state, min, max)
  )
}

/**
 * The bytes the rest of the pattern can start with (`table[b]` is 1), or
 * `undefined` when it may match the empty string. A repetition hands
 * control to the rest only where one of them follows, which spares a call
 * for every other position it gives back.
 */
type Follow = Uint8Array | undefined

/** Whether the rest of the pattern can start at `p`. */
const follows = (follow: Follow, b: Bytes, p: number): boolean =>
  follow === undefined || (p < b.length && follow[b[p]] === 1)

/** The follow set before `regex`, given the follow set after it. */
const followBefore = (regex: Regex, after: Follow): Follow => {
  const { nullable, table } = Prefilter.firstBytes(regex)
  if (!nullable) return table
  if (after === undefined) return undefined
  for (let i = 0; i < 256; i++) table[i] |= after[i]
  return table
}

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
        test(state.input, state.pos) ? kStep(state) : reject(state)
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
    const body = compileNode(ctx, sub, again, undefined)
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
    if (state.pos === began) return reject(state)
    frame[top] = state.pos
    const r = coreStep(state)
    if (r === Input.Fail) frame[top] = began
    return r
  })
  const body = compileNode(ctx, sub, iterate, undefined)
  core = greedy ? Parser.alt(body, k) : Parser.alt(k, body)
  return Parser.combinator([core], ([coreStep]) => (state) => {
    frame.push(state.pos)
    const r = coreStep(state)
    frame.pop()
    return r
  })
}

const repeat = (ctx: Context, regex: Extract<Regex, { _tag: "Repeat" }>, k: Step, follow: Follow): Step => {
  const { greedy, max, min, sub } = regex
  const char = singleChar(sub)
  if (char !== undefined) return repeatChar(char, k, follow, min, max, greedy)
  let tail: Step
  if (max === Infinity) {
    tail = loop(ctx, sub, greedy, k)
  } else {
    tail = k
    for (let j = 0; j < max - min; j++) {
      const more = compileNode(ctx, sub, tail, undefined)
      tail = greedy ? Parser.alt(more, k) : Parser.alt(k, more)
    }
  }
  for (let i = 0; i < min; i++) tail = compileNode(ctx, sub, tail, undefined)
  return tail
}

/** Compiles `regex` followed by `k`; `follow` is the bytes `k` can start with. */
const compileNode = (ctx: Context, regex: Regex, k: Step, follow: Follow): Step => {
  switch (regex._tag) {
    case "Empty":
      return k
    case "Literal":
      return Parser.preceded(Token.literal(encoder.encode(regex.text)), k)
    case "Class":
      return CharSet.isEmpty(regex.set) ? Parser.backtrack(Parser.failMessage("empty class")) : classThen(regex.set, k)
    case "Look":
      return assertion(lookTest(regex.look, ctx.lineTerminator), k)
    case "Repeat":
      return repeat(ctx, regex, k, follow)
    case "Capture":
      if (!ctx.captures) return compileNode(ctx, regex.sub, k, follow)
      return setSlot(ctx, 2 * regex.index, compileNode(ctx, regex.sub, setSlot(ctx, 2 * regex.index + 1, k), follow))
    case "Concat": {
      let next = k
      let after = follow
      for (let i = regex.subs.length - 1; i >= 0; i--) {
        next = compileNode(ctx, regex.subs[i], next, after)
        after = followBefore(regex.subs[i], after)
      }
      return next
    }
    case "Alternate":
      return Parser.alt(...regex.subs.map((sub) => compileNode(ctx, sub, k, follow)))
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
 * The first position at or after `s` (and at most `to`) where a match can
 * start: one whose byte is in the first-byte table, or, without a table, a
 * character boundary (past `from`, which is tried as it is). -1 if none.
 */
const nextStart = (input: Bytes, s: number, from: number, to: number, table: Uint8Array | undefined): number => {
  if (s > to) return -1
  if (table === undefined) {
    let p = s
    if (p > from) while (p < input.length && (input[p] & 0xc0) === 0x80) p++
    return p > to ? -1 : p
  }
  let p = s
  while (p < to && table[input[p]] === 0) p++
  return p < input.length && table[input[p]] === 1 ? p : -1
}

/** Past a failed start `s`, the last position of the run of the leading class (see {@link leadingRun}). */
const skipRun = (skip: Uint8Array | undefined, input: Bytes, s: number, to: number): number => {
  let p = s
  if (skip !== undefined) while (p + 1 < to && skip[input[p + 1]] === 1) p++
  return p
}

/**
 * For a pattern that starts with an unbounded repetition of an ASCII class
 * (`\w+…`, `[a-z]*…`), the class as a byte table. If the pattern fails from
 * a position in a run of that class, it fails from every later position in
 * the run: a match from there would extend back to the earlier position.
 */
const leadingRun = (regex: Regex): Uint8Array | undefined => {
  let first = regex
  while (first._tag === "Concat" || first._tag === "Capture") {
    if (first._tag === "Capture") first = first.sub
    else if (first.subs[0] === undefined) return undefined
    else first = first.subs[0]
  }
  if (first._tag !== "Repeat" || first.max !== Infinity || first.sub._tag !== "Class") return undefined
  const set = first.sub.set
  if (!CharSet.isAscii(set)) return undefined
  const table = new Uint8Array(256)
  for (const [a, b] of set) table.fill(1, a, b + 1)
  return table
}

/**
 * How expensive a matcher's search is per byte (see {@link Matcher.cost}).
 *
 * @since 0.0.0
 */
export type Cost = "literal" | "literals" | "regex"

/** The cost of the strategy {@link strategy} picks. */
const costOf = (pre: Prefilter.Prefilter, multiline: boolean): Cost => {
  const startSequence = pre.sequence?.atStart === true ? pre.sequence.sets.length : 0
  const prefixLength = Math.max(shortest(pre.prefixes), startSequence)
  const requiredLength = Math.max(shortest(pre.required), pre.sequence?.sets.length ?? 0)
  if (prefixLength === 0 || (!multiline && prefixLength < requiredLength)) return "regex"
  return pre.prefixes?.length === 1 && !preferSequence(pre.prefixes, pre.sequence) ? "literal" : "literals"
}

type Find = (state: Input.State<Bytes>, from: number) => Match | undefined

/**
 * How `find` looks for the next match: from the occurrences of the literals
 * every match starts with; from the lines holding a literal every match
 * contains (outside multiline mode, where a match lies within one line); or
 * from every position a match can start at.
 */

const shortest = (set: ReadonlyArray<Uint8Array> | undefined): number =>
  set === undefined ? 0 : Math.min(...set.map((l) => l.length))

/**
 * A byte-set sequence beats a literal set when the set is case variants (more
 * than one member) and the sequence is at least as long: one rare byte's
 * occurrences instead of a pass over the input per variant.
 */
const preferSequence = (literals: ReadonlyArray<Uint8Array> | undefined, sequence: Prefilter.Sequence | undefined) =>
  sequence !== undefined &&
  (literals === undefined || (literals.length > 1 && sequence.sets.length >= shortest(literals)))

/** Candidate starts from the literals (or byte-set sequence) every match starts with. */
const prefixStrategy = (
  regex: Regex,
  pre: Prefilter.Prefilter,
  options: CompileOptions,
  attempt: (state: Input.State<Bytes>, s: number) => number,
  found: (s: number, e: number) => Match
): Find => {
  const sequence = pre.sequence?.atStart === true ? pre.sequence : undefined
  const prefixes = pre.prefixes
  const bySequence = prefixes === undefined || (sequence !== undefined && preferSequence(prefixes, sequence))
  const finder: Finder = bySequence ? sequenceFinder(sequence?.sets ?? []) : literalFinder(prefixes)
  // A set of plain literals needs no matcher: an occurrence is a match.
  const literals =
    bySequence || options.captures || !Prefilter.isLiteralSet(regex) ? undefined : new LiteralFinder(prefixes)
  return (state, from) => {
    const input = state.input
    for (let p = from; ; p++) {
      p = finder.find(input, p)
      if (p < 0) return undefined
      if (literals !== undefined) return found(p, p + (literals.literalAt(input, p)?.length ?? 0))
      const e = attempt(state, p)
      if (e >= 0) return found(p, e)
    }
  }
}

type Scan = (state: Input.State<Bytes>, from: number, to: number) => Match | undefined

const lineStartOf = (input: Bytes, t: number, o: number): number => (o === 0 ? 0 : input.lastIndexOf(t, o - 1) + 1)

const lineEndOf = (input: Bytes, t: number, o: number): number => {
  const nl = input.indexOf(t, o)
  return nl < 0 ? input.length : nl
}

/**
 * Candidate lines: those holding a literal (or byte-set sequence) every
 * match contains, confirmed by the DFA when there is one, then searched by
 * the matcher.
 */
const lineStrategy =
  (finder: Finder, dfa: LineDfa | undefined, t: number, confirm: Confirm): Find =>
  (state, from) => {
    const input = state.input
    for (let p = from; ;) {
      const o = finder.find(input, p)
      if (o < 0) return undefined
      const start = Math.max(p, lineStartOf(input, t, o))
      const end = lineEndOf(input, t, o)
      const unconfirmed = dfa === undefined || dfa.exhausted
      const hit = unconfirmed ? start : dfa.find(input, start, end)
      const m = hit === -1 ? undefined : confirm(state, start, end, unconfirmed || hit < 0 ? -1 : hit)
      if (m !== undefined) return m
      p = end + 1
    }
  }

/**
 * What a strategy does with a line `[start, end]` that may hold a match:
 * `hit` is where the DFA found one ends, or -1 when no DFA has looked.
 */
type Confirm = (state: Input.State<Bytes>, start: number, end: number, hit: number) => Match | undefined

/** Finds the match in the line. */
const searchLine =
  (scan: Scan): Confirm =>
  (state, start, end) =>
    scan(state, start, end)

/** Takes the DFA's word for it: a stand-in match at the hit (see {@link Matcher.findLine}). */
const confirmLine =
  (scan: Scan): Confirm =>
  (state, start, end, hit) =>
    hit < 0 ? scan(state, start, end) : { start: hit, end: hit, groups: undefined }

/** Every line the DFA finds a match in, searched by the matcher. */
const dfaStrategy =
  (dfa: LineDfa, t: number, scan: Scan, confirm: Confirm): Find =>
  (state, from) => {
    const input = state.input
    for (let p = from; p <= input.length;) {
      // Mid-line (after a match), the rest of that line alone; then line by line.
      const lineStart = p === 0 || input[p - 1] === t
      const hit = lineStart ? dfa.findLine(input, p) : dfa.find(input, p, lineEndOf(input, t, p))
      if (hit === -1 && !lineStart) {
        p = lineEndOf(input, t, p) + 1
        continue
      }
      // Out of states: the matcher searches the rest by itself.
      if (hit === -2) return scan(state, p, input.length)
      if (hit < 0) return undefined
      const end = lineEndOf(input, t, hit)
      const m = confirm(state, Math.max(p, lineStartOf(input, t, hit)), end, hit)
      if (m !== undefined) return m
      p = end + 1
    }
    return undefined
  }

/**
 * How `find` looks for the next match: from the occurrences of what every
 * match starts with; from the lines holding what every match contains
 * (outside multiline mode, where a match lies within one line), confirmed
 * by the DFA; from the lines the DFA finds a match in; or from every
 * position a match can start at.
 */
const strategy = (
  regex: Regex,
  pre: Prefilter.Prefilter,
  options: CompileOptions,
  lineTerminator: number,
  attempt: (state: Input.State<Bytes>, s: number) => number,
  found: (s: number, e: number) => Match,
  scan: Scan,
  inLine: Scan
): Strategies => {
  const startSequence = pre.sequence?.atStart === true ? pre.sequence.sets.length : 0
  const prefixLength = Math.max(shortest(pre.prefixes), startSequence)
  const requiredLength = Math.max(shortest(pre.required), pre.sequence?.sets.length ?? 0)
  if (prefixLength > 0 && (options.multiline || prefixLength >= requiredLength)) {
    return { find: prefixStrategy(regex, pre, options, attempt, found), line: undefined }
  }
  const everywhere: Find = (state, from) => scan(state, from, state.input.length)
  if (options.multiline) return { find: everywhere, line: undefined }
  return (
    lineStrategies(LineDfa.make(regex, lineTerminator), pre, requiredLength, lineTerminator, scan, inLine) ?? {
      find: everywhere,
      line: undefined
    }
  )
}

/**
 * Outside multiline mode: the lines the DFA finds a match in, or the lines
 * holding what every match contains; `undefined` when neither applies.
 */
const lineStrategies = (
  dfa: LineDfa | undefined,
  pre: Prefilter.Prefilter,
  requiredLength: number,
  t: number,
  scan: Scan,
  inLine: Scan
): Strategies | undefined => {
  // A literal shorter than three bytes is in most lines: one DFA pass over
  // the input beats a search for it and a DFA run on each line it is in.
  if (dfa !== undefined && requiredLength < 3) {
    return { find: dfaStrategy(dfa, t, scan, searchLine(inLine)), line: dfaStrategy(dfa, t, scan, confirmLine(inLine)) }
  }
  if (requiredLength === 0) return undefined
  const finder: Finder = preferSequence(pre.required, pre.sequence)
    ? sequenceFinder(pre.sequence?.sets ?? [])
    : literalFinder(pre.required ?? [])
  const line = dfa === undefined ? undefined : lineStrategy(finder, dfa, t, confirmLine(inLine))
  // A line searched from the reversed regex's starts needs no forward DFA first: no start, no match
  const confirmed = inLine === scan ? dfa : undefined
  return { find: lineStrategy(finder, confirmed, t, searchLine(inLine)), line }
}

/**
 * Searches a line `[from, to]` (`to` its terminator, or the end of the
 * input) from the starts the reversed regex's DFA finds in one backward
 * pass: the matcher runs only where a match starts, so the first attempt
 * succeeds. The starts are kept for the next search in the same line
 * (after a match, with `-o` or colors); `scan` takes over when the DFA
 * runs out of states, or the reversed regex has none (`make` builds it on
 * first use).
 */
const reverseScan = (
  make: () => LineDfa | undefined,
  t: number,
  attempt: (state: Input.State<Bytes>, s: number) => number,
  found: (s: number, e: number) => Match,
  scan: Scan
): Scan => {
  let input: Bytes | undefined
  let lineEnd = -1
  const starts: Array<number> = []
  let ok = true
  let reverse: LineDfa | undefined
  let made = false
  return (state, from, to) => {
    if (!made) {
      made = true
      reverse = make()
    }
    if (reverse === undefined) return scan(state, from, to)
    if (state.input !== input || to !== lineEnd) {
      input = state.input
      lineEnd = to
      starts.length = 0
      ok = reverse.matchStarts(input, lineStartOf(input, t, from), to, starts)
    }
    if (!ok) return scan(state, from, to)
    // `starts` runs from the line's last start to its first.
    for (let i = starts.length - 1; i >= 0; i--) {
      const s = starts[i] ?? 0
      if (s < from) continue
      const e = attempt(state, s)
      if (e >= 0) return found(s, e)
    }
    return undefined
  }
}

/**
 * How many lines an input has, and how many of them hold a match.
 *
 * @since 0.0.0
 */
export interface LineCounts {
  readonly lines: number
  readonly matched: number
}

/**
 * Counts lines and the lines holding one of `literals` with one parse,
 * compiled by `Compiler.wasm`: from each line start, `Token.takeUntilAny`
 * finds the first literal or line terminator (Teddy, in SIMD); a literal
 * first makes it a matching line, whose rest `Token.takeTill` skips (a
 * vectorised run). A last line without a terminator and without a literal
 * is the rest of the input.
 */
const lineCounter = (literals: ReadonlyArray<Uint8Array>, t: number): ((input: Bytes) => LineCounts | undefined) => {
  const end = Uint8Array.of(t)
  const plain = Parser.as(Token.literal(end), 0)
  const matching = Parser.as(Parser.seq(Token.takeTill<Uint8Array>([t]), Parser.opt(Token.literal(end))), 1)
  const line = Parser.alt(
    Parser.preceded(Token.takeUntilAny([...literals, end]), Parser.alt(plain, matching)),
    Parser.as(Token.takeWhile<Uint8Array>([Token.range(0, 255)], { min: 1 }), 0)
  )
  const counted = Parser.fold(line, {
    init: () => ({ lines: 0, matched: 0 }),
    f: (acc: { lines: number; matched: number }, x: number) => {
      acc.lines++
      acc.matched += x
      return acc
    }
  })
  // Compiled on first use: most searches never count
  let run: ((state: Input.State<Bytes>) => LineCounts | Input.Fail) | undefined
  return (input) => {
    run ??= Compiler.runner(Compiler.wasm(counted), noDiagnostics)
    const r = run(new Input.State(input))
    return r === Input.Fail ? undefined : r
  }
}

/** A matcher's two searches: for matches, and for the lines that hold one (see {@link Matcher.findLine}). */
interface Strategies {
  readonly find: Find
  readonly line: Find | undefined
}

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
  const parser = backends[options.backend](compileNode(ctx, regex, accept, undefined))
  const { frames, slots } = ctx
  const captures = options.captures
  // Looks the compiled matcher up once, not on every attempt.
  const run = Compiler.runner(parser, noDiagnostics)
  // After a failed attempt at the start of a run of the leading class of
  // `C+…`, every later start in that run fails too.
  const skip = leadingRun(regex)
  /** One attempt at `s`: the end of the match, or -1. */
  let overflow: number | undefined
  const attempt = (state: Input.State<Bytes>, s: number): number => {
    if (overflow !== undefined) return -1
    for (const f of frames) f.length = 0
    if (captures) slots.fill(-1)
    if (run(state.reset(s)) !== Input.Fail) return state.pos
    if (state.mode !== "Backtrack") overflow = s
    return -1
  }
  const found = (s: number, e: number): Match => {
    if (!captures) return { start: s, end: e, groups: undefined }
    slots[0] = s
    slots[1] = e
    return { start: s, end: e, groups: slots.slice() }
  }
  const first = Prefilter.analyze(regex)
  const table = first.firstBytes
  /** The leftmost match starting in `[from, to]`, trying only starts a match can begin with. */
  const scan = (state: Input.State<Bytes>, from: number, to: number): Match | undefined => {
    const input = state.input
    for (let s = nextStart(input, from, from, to, table); s >= 0;) {
      const e = attempt(state, s)
      if (e >= 0) return found(s, e)
      s = nextStart(input, skipRun(skip, input, s, to) + 1, from, to, table)
    }
    return undefined
  }
  // Built on first use: a search that only counts lines never needs it
  const inLine = options.multiline
    ? scan
    : reverseScan(() => LineDfa.make(regex, lineTerminator, true), lineTerminator, attempt, found, scan)
  const { find, line } = strategy(regex, first, options, lineTerminator, attempt, found, scan, inLine)
  const takeOverflow = () => {
    const at = overflow
    overflow = undefined
    return at
  }
  return {
    find: (state, from) => (overflow === undefined ? find(state, from) : undefined),
    findLine:
      line === undefined ? undefined : (state, from) => (overflow === undefined ? line(state, from) : undefined),
    matchAt: attempt,
    cost: costOf(first, options.multiline),
    takeOverflow,
    slots,
    groups,
    countLines:
      options.multiline || options.captures || !Prefilter.isLiteralSet(regex) || first.prefixes === undefined
        ? undefined
        : lineCounter(first.prefixes, lineTerminator)
  }
}
