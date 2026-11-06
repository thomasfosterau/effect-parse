/**
 * A lazy DFA that finds the lines containing a match, as ripgrep's regex
 * engine does before it looks for the match itself.
 *
 * The regex is compiled to a Thompson NFA over bytes (Unicode classes as
 * UTF-8 byte sequences), and the DFA's states, sets of NFA states, are
 * built as the input reaches them, with their transitions cached in a
 * table: one lookup per byte. Line anchors are resolved the way RE2 does:
 * `^` from the byte just consumed, `$` from the byte about to be. The DFA
 * only says which line holds a match; the effect-parse matcher then finds
 * the match in that line, with Rust's leftmost-first semantics. Patterns
 * with word-boundary assertions, and multiline search, are left to the
 * matcher.
 *
 * @since 0.0.0
 */
import * as Arr from "effect/Array"
import * as Order from "effect/Order"
import type { Regex } from "./ast.ts"
import type { Ranges } from "./charset.ts"

/** NFA states: byte ranges, splits, assertions and the match. */
type NState =
  | { readonly _tag: "Range"; readonly lo: number; readonly hi: number; next: number }
  | { readonly _tag: "Split"; next: number; other: number }
  | { readonly _tag: "Look"; readonly look: "StartLine" | "EndLine" | "StartText" | "EndText"; next: number }
  | { readonly _tag: "Match" }

/** NFAs larger than this are left to the backtracker. */
const MAX_NFA = 20_000

/** DFA states kept before the cache is considered exhausted. */
const MAX_DFA = 4_000

class TooComplex {
  readonly _tag = "TooComplex"
}

// ---------------------------------------------------------------------------
// UTF-8 byte sequences for code point ranges (regex-syntax's `Utf8Sequences`)
// ---------------------------------------------------------------------------

const encode = (c: number): ReadonlyArray<number> => {
  if (c < 0x80) return [c]
  if (c < 0x800) return [0xc0 | (c >> 6), 0x80 | (c & 0x3f)]
  if (c < 0x10000) return [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)]
  return [0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)]
}

const lengthBounds = [0x7f, 0x7ff, 0xffff]

/** Splits `[lo, hi]` into ranges whose UTF-8 encodings are byte-range products. */
const utf8Sequences = (lo: number, hi: number, out: Array<ReadonlyArray<readonly [number, number]>>): void => {
  for (const bound of lengthBounds) {
    if (lo <= bound && bound < hi) {
      utf8Sequences(lo, bound, out)
      utf8Sequences(bound + 1, hi, out)
      return
    }
  }
  const n = encode(lo).length
  for (let i = 1; i < n; i++) {
    const m = (1 << (6 * i)) - 1
    if ((lo & ~m) !== (hi & ~m)) {
      if ((lo & m) !== 0) {
        utf8Sequences(lo, lo | m, out)
        utf8Sequences((lo | m) + 1, hi, out)
        return
      }
      if ((hi & m) !== m) {
        utf8Sequences(lo, (hi & ~m) - 1, out)
        utf8Sequences(hi & ~m, hi, out)
        return
      }
    }
  }
  const a = encode(lo)
  const b = encode(hi)
  out.push(a.map((x, k) => [x, b[k] ?? x] as const))
}

// ---------------------------------------------------------------------------
// The NFA
// ---------------------------------------------------------------------------

class Nfa {
  readonly states: Array<NState> = []

  add(state: NState): number {
    if (this.states.length >= MAX_NFA) throw new TooComplex()
    this.states.push(state)
    return this.states.length - 1
  }

  /** A fragment: its entry state and the states whose `next` is still open (-1). */
  range(lo: number, hi: number): Fragment {
    const s = this.add({ _tag: "Range", lo, hi, next: -1 })
    return { start: s, holes: [s] }
  }

  /** Points split `s`'s first branch at `to` (a loop's or an option's body). */
  enter(s: number, to: number): void {
    const st = this.states[s]
    if (st?._tag === "Split") st.next = to
  }

  patch(holes: ReadonlyArray<number>, to: number): void {
    for (const h of holes) {
      const st = this.states[h]
      if (st === undefined || st._tag === "Match") continue
      if (st._tag === "Split" && st.next !== -1) st.other = to
      else st.next = to
    }
  }
}

interface Fragment {
  readonly start: number
  readonly holes: ReadonlyArray<number>
}

/** An empty fragment: a split whose both branches are open (patched together). */
const empty = (nfa: Nfa): Fragment => {
  const s = nfa.add({ _tag: "Split", next: -1, other: -1 })
  return { start: s, holes: [s, s] }
}

const sequence = (nfa: Nfa, parts: ReadonlyArray<Fragment>): Fragment => {
  if (Arr.isReadonlyArrayEmpty(parts)) return empty(nfa)
  for (let i = 0; i + 1 < parts.length; i++) {
    const a = parts[i]
    const b = parts[i + 1]
    if (a !== undefined && b !== undefined) nfa.patch(a.holes, b.start)
  }
  return { start: parts[0]?.start ?? -1, holes: parts.at(-1)?.holes ?? [] }
}

const choice = (nfa: Nfa, parts: ReadonlyArray<Fragment>): Fragment => {
  let acc = parts[0]
  if (acc === undefined) return empty(nfa)
  for (const part of parts.slice(1)) {
    const s = nfa.add({ _tag: "Split", next: acc.start, other: part.start })
    acc = { start: s, holes: [...acc.holes, ...part.holes] }
  }
  return acc
}

const classFragment = (nfa: Nfa, set: Ranges): Fragment => {
  const seqs: Array<ReadonlyArray<readonly [number, number]>> = []
  for (const [a, b] of set) utf8Sequences(a, b, seqs)
  return choice(
    nfa,
    seqs.map((seq) =>
      sequence(
        nfa,
        seq.map(([lo, hi]) => nfa.range(lo, hi))
      )
    )
  )
}

/** `sub` zero or more times. */
const star = (nfa: Nfa, sub: () => Fragment): Fragment => {
  const s = nfa.add({ _tag: "Split", next: -1, other: -1 })
  const body = sub()
  nfa.enter(s, body.start)
  nfa.patch(body.holes, s)
  // The split's `other` stays open: the loop's exit.
  return { start: s, holes: [s] }
}

/** `sub` zero or one time. */
const optional = (nfa: Nfa, sub: () => Fragment): Fragment => {
  const s = nfa.add({ _tag: "Split", next: -1, other: -1 })
  const body = sub()
  nfa.enter(s, body.start)
  return { start: s, holes: [s, ...body.holes] }
}

const build = (nfa: Nfa, regex: Regex): Fragment => {
  switch (regex._tag) {
    case "Empty":
      return empty(nfa)
    case "Literal":
      return sequence(
        nfa,
        Array.from(new TextEncoder().encode(regex.text), (b) => nfa.range(b, b))
      )
    case "Class":
      return classFragment(nfa, regex.set)
    case "Capture":
      return build(nfa, regex.sub)
    case "Concat":
      return sequence(
        nfa,
        regex.subs.map((s) => build(nfa, s))
      )
    case "Alternate":
      return choice(
        nfa,
        regex.subs.map((s) => build(nfa, s))
      )
    case "Look":
      return lookFragment(nfa, regex.look)
    case "Repeat": {
      const parts: Array<Fragment> = []
      for (let i = 0; i < regex.min; i++) parts.push(build(nfa, regex.sub))
      if (regex.max === Infinity) parts.push(star(nfa, () => build(nfa, regex.sub)))
      else for (let i = regex.min; i < regex.max; i++) parts.push(optional(nfa, () => build(nfa, regex.sub)))
      return sequence(nfa, parts)
    }
  }
}

const lookFragment = (nfa: Nfa, look: Extract<Regex, { _tag: "Look" }>["look"]): Fragment => {
  if (look !== "StartLine" && look !== "EndLine" && look !== "StartText" && look !== "EndText") throw new TooComplex()
  const s = nfa.add({ _tag: "Look", look, next: -1 })
  return { start: s, holes: [s] }
}

// ---------------------------------------------------------------------------
// The lazy DFA
// ---------------------------------------------------------------------------

/** What the closure may assume: a line or the text starts or ends here. */
interface Context {
  readonly startLine: boolean
  readonly startText: boolean
  readonly endLine: boolean
  readonly endText: boolean
}

const lookHolds = (look: Extract<NState, { _tag: "Look" }>["look"], c: Context): boolean => c[lookKey[look]]

const lookKey = {
  StartLine: "startLine",
  EndLine: "endLine",
  StartText: "startText",
  EndText: "endText"
} as const

/** A transition's flags: a match ended before the byte, or the state after it matches. */
const MATCH_BEFORE = 1 << 30
const MATCH_AFTER = 1 << 29
const INDEX = MATCH_AFTER - 1

/**
 * Where a flagged transition on the byte at `i` puts the match: before the
 * byte (a `$` before a terminator), or after it, which after a terminator
 * is an empty match at the start of the next line.
 */
const hitOffset = (next: number, i: number, terminator: boolean): number =>
  (next & MATCH_BEFORE) !== 0 || !terminator ? i : i + 1

/**
 * The first line holding a match of a regex, found with a lazy DFA.
 *
 * @since 0.0.0
 */
export class LineDfa {
  private readonly nfa: ReadonlyArray<NState>
  private readonly startState: number
  private readonly lineTerminator: number
  private readonly sets: Array<ReadonlyArray<number>> = []
  private readonly index = new Map<string, number>()
  /**
   * Transitions: row `state * width`, column the byte's class; the target
   * state's row, with the match flags, or -1 until computed.
   */
  private table = new Int32Array(0)
  /** Bytes that no range tells apart share a class (and a column). */
  private readonly classes: Uint8Array
  private readonly width: number
  private readonly matching: Array<boolean> = []
  private readonly matchingAtEnd: Array<boolean> = []
  /** Start states by `(atLineStart ? 1 : 0) | (atTextStart ? 2 : 0)`, -1 until built. */
  private readonly starts = [-1, -1, -1, -1]
  /** Set once the DFA has more states than it may: the caller falls back. */
  exhausted = false

  private constructor(nfa: ReadonlyArray<NState>, start: number, lineTerminator: number) {
    this.nfa = nfa
    this.startState = start
    this.lineTerminator = lineTerminator
    // A class boundary wherever a range starts or ends, and around the terminator.
    const boundary = new Uint8Array(257)
    for (const st of nfa) {
      if (st._tag !== "Range") continue
      boundary[st.lo] = 1
      boundary[st.hi + 1] = 1
    }
    boundary[lineTerminator] = 1
    boundary[lineTerminator + 1] = 1
    this.classes = new Uint8Array(256)
    let cls = 0
    for (let b = 0; b < 256; b++) {
      if (b > 0 && boundary[b] === 1) cls++
      this.classes[b] = cls
    }
    this.width = cls + 1
  }

  /** The DFA for a regex, or `undefined` for one it cannot run (word boundaries, or too large). */
  static make(regex: Regex, lineTerminator: number): LineDfa | undefined {
    const nfa = new Nfa()
    try {
      const frag = build(nfa, regex)
      const match = nfa.add({ _tag: "Match" })
      nfa.patch(frag.holes, match)
      return new LineDfa(nfa.states, frag.start, lineTerminator)
    } catch (error) {
      if (error instanceof TooComplex) return undefined
      throw error
    }
  }

  /** Follows splits and assertions from `seeds`; `$` and `\z` stay pending unless the context settles them. */
  private closure(seeds: ReadonlyArray<number>, c: Context): ReadonlyArray<number> {
    const seen = new Set<number>()
    const stack = [...seeds]
    const out: Array<number> = []
    for (let s = stack.pop(); s !== undefined; s = stack.pop()) {
      if (s < 0 || seen.has(s)) continue
      seen.add(s)
      const st = this.nfa[s]
      if (st === undefined) continue
      if (st._tag === "Split") stack.push(st.other, st.next)
      else if (st._tag === "Look" && lookHolds(st.look, c)) stack.push(st.next)
      else if (st._tag !== "Look" || st.look === "EndLine" || st.look === "EndText") out.push(s)
    }
    return Arr.sort(out, Order.Number)
  }

  private intern(set: ReadonlyArray<number>): number {
    const key = set.join(",")
    const known = this.index.get(key)
    if (known !== undefined) return known
    if (this.sets.length >= MAX_DFA) {
      this.exhausted = true
      return -1
    }
    const id = this.sets.length
    this.sets.push(set)
    this.index.set(key, id)
    if (this.table.length < (id + 1) * this.width) {
      const bigger = new Int32Array(Math.max(this.width * 64, this.table.length * 2)).fill(-1)
      bigger.set(this.table)
      this.table = bigger
    }
    this.matching.push(set.some((s) => this.nfa[s]?._tag === "Match"))
    const end = { startLine: false, startText: false, endLine: true, endText: true }
    this.matchingAtEnd.push(this.closure(set, end).some((s) => this.nfa[s]?._tag === "Match"))
    return id
  }

  /** The state a search starts in, after a line terminator or at the start of the text. */
  private start(atLineStart: boolean, atTextStart: boolean): number {
    const key = (atLineStart ? 1 : 0) | (atTextStart ? 2 : 0)
    const known = this.starts[key] ?? -1
    if (known >= 0) return known
    const c = { startLine: atLineStart, startText: atTextStart, endLine: false, endText: false }
    const id = this.intern(this.closure([this.startState], c))
    this.starts[key] = id
    return id
  }

  /** Computes and caches the transition from the state at row `row` on byte `b`; returns the table value. */
  private transition(row: number, b: number): number {
    const set = this.sets[row / this.width] ?? []
    const terminator = b === this.lineTerminator
    // `$` holds before a line terminator: settle the pending ones first.
    const before = this.closure(set, { startLine: false, startText: false, endLine: terminator, endText: false })
    const matchedBefore = before.some((s) => this.nfa[s]?._tag === "Match")
    const stepped: Array<number> = []
    for (const s of before) {
      const st = this.nfa[s]
      if (st?._tag === "Range" && st.lo <= b && b <= st.hi) stepped.push(st.next)
    }
    // Unanchored: a match may also start after this byte.
    stepped.push(this.startState)
    const after = this.closure(stepped, { startLine: terminator, startText: false, endLine: false, endText: false })
    const to = this.intern(after)
    if (to < 0) return -1
    const value =
      (to * this.width) | (matchedBefore ? MATCH_BEFORE : 0) | (this.matching[to] === true ? MATCH_AFTER : 0)
    this.table[row + (this.classes[b] ?? 0)] = value
    return value
  }

  /**
   * An offset in a line, at or after `from`, that holds a match (where the
   * match ends, so in that line), or -1 if none does; -2 if the DFA ran out
   * of states. The bytes up to `to` (inclusive) are read: pass a line
   * terminator's offset to check that line alone.
   */
  find(input: Uint8Array, from: number, to: number): number {
    const start = this.start(from === 0 || input[from - 1] === this.lineTerminator, from === 0)
    if (start < 0) return -2
    if (this.matching[start] === true) return from
    return this.scan(input, from, Math.min(to, input.length - 1), start * this.width)
  }

  /** Runs the DFA over `input[from..last]` from the state at `row` (see {@link find}). */
  private scan(input: Uint8Array, from: number, last: number, row: number): number {
    const classes = this.classes
    let table = this.table
    let at = row
    for (let i = from; i <= last; i++) {
      const b = input[i]
      let next = table[at + classes[b]]
      if (next < 0) {
        next = this.transition(at, b)
        if (next < 0) return -2
        table = this.table
      }
      if (next > INDEX) return hitOffset(next, i, b === this.lineTerminator)
      at = next
    }
    return last === input.length - 1 && this.matchingAtEnd[at / this.width] === true ? input.length : -1
  }
}
