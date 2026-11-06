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

/** A trie of byte-range sequences: shared prefixes become shared NFA states. */
interface Trie {
  readonly children: Map<string, { readonly lo: number; readonly hi: number; readonly next: Trie }>
}

const trieOf = (seqs: ReadonlyArray<ReadonlyArray<readonly [number, number]>>): Trie => {
  const root: Trie = { children: new Map() }
  for (const seq of seqs) {
    let node = root
    for (const [lo, hi] of seq) {
      const key = `${lo},${hi}`
      let child = node.children.get(key)
      if (child === undefined) {
        child = { lo, hi, next: { children: new Map() } }
        node.children.set(key, child)
      }
      node = child.next
    }
  }
  return root
}

const trieFragment = (nfa: Nfa, trie: Trie): Fragment =>
  choice(
    nfa,
    [...trie.children.values()].map(({ hi, lo, next }) =>
      next.children.size === 0 ? nfa.range(lo, hi) : sequence(nfa, [nfa.range(lo, hi), trieFragment(nfa, next)])
    )
  )

/**
 * A class as UTF-8: its byte-range sequences merged into a trie, so a large
 * Unicode class (`\w` has hundreds of ranges) shares its lead bytes and
 * every DFA state built from it stays small.
 */
const classFragment = (nfa: Nfa, set: Ranges, reverse: boolean): Fragment => {
  const seqs: Array<ReadonlyArray<readonly [number, number]>> = []
  for (const [a, b] of set) utf8Sequences(a, b, seqs)
  return trieFragment(nfa, trieOf(reverse ? seqs.map((seq) => [...seq].reverse()) : seqs))
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

/**
 * The NFA of `regex`, or with `reverse` of the regex read backwards (for
 * {@link LineDfa.matchStarts}): concatenations and each character's UTF-8 bytes
 * in reverse order, and line anchors swapped.
 */
const build = (nfa: Nfa, regex: Regex, reverse: boolean): Fragment => {
  switch (regex._tag) {
    case "Empty":
      return empty(nfa)
    case "Literal": {
      const bytes = Array.from(new TextEncoder().encode(regex.text))
      return sequence(
        nfa,
        (reverse ? bytes.reverse() : bytes).map((b) => nfa.range(b, b))
      )
    }
    case "Class":
      return classFragment(nfa, regex.set, reverse)
    case "Capture":
      return build(nfa, regex.sub, reverse)
    case "Concat": {
      const parts = regex.subs.map((s) => build(nfa, s, reverse))
      return sequence(nfa, reverse ? parts.reverse() : parts)
    }
    case "Alternate":
      return choice(
        nfa,
        regex.subs.map((s) => build(nfa, s, reverse))
      )
    case "Look":
      return lookFragment(nfa, regex.look, reverse)
    case "Repeat": {
      const parts: Array<Fragment> = []
      for (let i = 0; i < regex.min; i++) parts.push(build(nfa, regex.sub, reverse))
      if (regex.max === Infinity) parts.push(star(nfa, () => build(nfa, regex.sub, reverse)))
      else for (let i = regex.min; i < regex.max; i++) parts.push(optional(nfa, () => build(nfa, regex.sub, reverse)))
      return sequence(nfa, parts)
    }
  }
}

/** Read backwards, `^` holds where `$` does forwards. */
const reversedLook = { StartLine: "EndLine", EndLine: "StartLine", StartText: "EndText", EndText: "StartText" } as const

const lookFragment = (nfa: Nfa, look: Extract<Regex, { _tag: "Look" }>["look"], reverse: boolean): Fragment => {
  if (look !== "StartLine" && look !== "EndLine" && look !== "StartText" && look !== "EndText") throw new TooComplex()
  // Backwards, a line's search ends at its start without knowing if it is the text's.
  if (reverse && (look === "StartText" || look === "EndText")) throw new TooComplex()
  const s = nfa.add({ _tag: "Look", look: reverse ? reversedLook[look] : look, next: -1 })
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

/** A stretch's state once it has no lines left. */
const DONE = -3

/** What a step returns when the DFA ran out of states. */
const EXHAUSTED = -1

/** Stretches of lines the batched search steps together (see `LineDfa.findLine`). */
const LANES = 8

/** A stretch shorter than this is finished by itself rather than shared. */
const STEAL = 2048

/** Bytes searched per batch, extended to the end of a line. */
const BATCH = 256 * 1024

/**
 * Where a flagged transition on the byte at `i` puts the match: before the
 * byte (a `$` before a terminator), or after it, which after a terminator
 * is an empty match at the start of the next line.
 */
const hitOffset = (next: number, i: number, terminator: boolean): number =>
  (next & MATCH_BEFORE) !== 0 || !terminator ? i : i + 1

/**
 * Records the starts a flagged transition of the reversed regex's DFA on
 * the byte at `i` gives: a match ended before the byte, so (backwards) one
 * starts after it; or one starts at it.
 */
const startsAt = (next: number, i: number, out: Array<number>): void => {
  if ((next & MATCH_BEFORE) !== 0 && out.at(-1) !== i + 1) out.push(i + 1)
  if ((next & MATCH_AFTER) !== 0) out.push(i)
}

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
  static make(regex: Regex, lineTerminator: number, reverse = false): LineDfa | undefined {
    const nfa = new Nfa()
    try {
      const frag = build(nfa, regex, reverse)
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

  /**
   * The offset of a match in the first line at or after `from` that holds
   * one, as {@link find} would give for that line; -1 if no line does, -2
   * if the DFA ran out of states. `from` must start a line, and the regex
   * must not match the line terminator (as outside multiline mode, where
   * no class does): each stretch starts afresh at a line start.
   *
   * Lines are searched a batch at a time, in {@link LANES} stretches of
   * whole lines stepped together: one stretch's next table lookup does not
   * wait for another's, so the loads overlap where a single scan waits for
   * each in turn. The batch's hits are kept for the calls that follow.
   */
  findLine(input: Uint8Array, from: number): number {
    this.useBatch(input, from)
    for (;;) {
      const hit = this.nextHit(from)
      if (hit !== undefined) return hit
      if (this.covered >= input.length && this.covered > from) return -1
      if (this.covered < from) this.covered = from
      if (this.batch(input, this.covered) < 0) return -2
      if (this.hitCount === 0 && this.covered >= input.length) return -1
    }
  }

  /** Starts over when the search moves to another input, or back in this one (the hits are read forwards). */
  private useBatch(input: Uint8Array, from: number): void {
    const forward = from >= this.batchFrom
    this.batchFrom = from
    if (input === this.batchInput && forward) return
    this.batchInput = input
    this.covered = from
    this.hitCount = 0
    this.hitNext = 0
  }

  /** The batch's first hit at or after `from`, if it has one. */
  private nextHit(from: number): number | undefined {
    while (this.hitNext < this.hitCount && this.hits[this.hitNext] < from) this.hitNext++
    return this.hitNext < this.hitCount ? this.hits[this.hitNext] : undefined
  }

  /** The batch's hits, in order, and how far it has read (a line start, or the end). */
  private batchInput: Uint8Array | undefined = undefined
  private batchFrom = 0
  private covered = 0
  private hits = new Int32Array(1024)
  private hitCount = 0
  private hitNext = 0
  /** Each stretch's position, end and state ({@link DONE} once it has no lines left). */
  private readonly lanePos = new Int32Array(LANES)
  private readonly laneEnd = new Int32Array(LANES)
  private readonly laneState = new Int32Array(LANES)
  /** The stretch whose bytes each stretch reads in the fast loop: itself, or for a finished one, a live one. */
  private readonly laneSource = new Int32Array(LANES)
  /** The fast loop's states and table values, for the slow path. */
  private readonly laneScratch = new Int32Array(LANES)
  private readonly valueScratch = new Int32Array(LANES)
  /**
   * The batch's stretches of lines so far, each with its first offset and
   * its hits (in order), and the one each lane is working through; the
   * batch's hits are the stretches' hits in offset order.
   */
  private readonly rangeStart: Array<number> = []
  private readonly rangeHits: Array<Array<number>> = []
  private ranges = 0
  private readonly laneRange = new Int32Array(LANES)

  /** Searches the lines from `from` (a line start) to the end of the batch; -1 if the DFA ran out of states. */
  private batch(input: Uint8Array, from: number): number {
    const n = input.length
    const end = from + BATCH >= n ? n : this.nextLine(input, from + BATCH - 1)
    const lineState = this.start(true, false)
    const textState = from === 0 ? this.start(true, true) : lineState
    if (lineState < 0 || textState < 0) return -1
    if (from >= n || this.matching[lineState] === true || this.matching[textState] === true) {
      return this.batchScalar(input, from, end)
    }
    this.hitCount = 0
    this.hitNext = 0
    const span = Math.ceil((end - from) / LANES)
    this.ranges = 0
    let s = from
    for (let lane = 0; lane < LANES; lane++) {
      const e =
        lane === LANES - 1 ? end : Math.max(s, Math.min(end, this.nextLine(input, from + (lane + 1) * span - 1)))
      this.lanePos[lane] = s
      this.laneEnd[lane] = e
      this.laneState[lane] = s >= e ? DONE : (lane === 0 ? textState : lineState) * this.width
      this.laneRange[lane] = this.range(s)
      s = e
    }
    if (!this.lanes(input, lineState * this.width)) return -1
    this.collectHits()
    this.covered = end
    return 0
  }

  /** A new stretch of lines from `start`, with no hits yet. */
  private range(start: number): number {
    const r = this.ranges++
    this.rangeStart[r] = start
    const hits = this.rangeHits[r]
    if (hits === undefined) this.rangeHits[r] = []
    else hits.length = 0
    return r
  }

  /** The batch's hits from its stretches, in offset order (stretches split by {@link steal} come out of order). */
  private collectHits(): void {
    const order = Array.from({ length: this.ranges }, (_, r) => r)
    // Insertion sort: a batch has a few dozen stretches at most.
    for (let i = 1; i < order.length; i++) {
      const r = order[i] ?? 0
      const start = this.rangeStart[r] ?? 0
      let k = i - 1
      for (; k >= 0 && (this.rangeStart[order[k] ?? 0] ?? 0) > start; k--) order[k + 1] = order[k] ?? 0
      order[k + 1] = r
    }
    for (const r of order) for (const h of this.rangeHits[r] ?? []) this.pushHit(h)
  }

  /** The start of the line after the one holding `o`, or the end of the input. */
  private nextLine(input: Uint8Array, o: number): number {
    if (o >= input.length) return input.length
    const nl = input.indexOf(this.lineTerminator, o)
    return nl < 0 ? input.length : nl + 1
  }

  private pushHit(h: number): void {
    if (this.hitCount === this.hits.length) {
      const bigger = new Int32Array(this.hits.length * 2)
      bigger.set(this.hits)
      this.hits = bigger
    }
    this.hits[this.hitCount++] = h
  }

  /** A batch of one stretch, for DFAs whose start states match (every line does), and at the end of the input. */
  private batchScalar(input: Uint8Array, from: number, end: number): number {
    this.hitCount = 0
    this.hitNext = 0
    // At the end of the input, the empty line after a final terminator too.
    for (let p = from; p < end || (p === end && end === input.length);) {
      const hit = this.find(input, p, end - 1)
      if (hit === -2) return -1
      if (hit === -1 || hit >= input.length) {
        if (hit >= 0) this.pushHit(hit)
        break
      }
      this.pushHit(hit)
      p = this.nextLine(input, hit)
    }
    this.covered = end
    return 0
  }

  /**
   * Steps the stretches together, collecting their hits; false if the DFA
   * ran out of states. The fast loop moves every stretch one byte at a time,
   * at offsets from one shared index, until one meets an unknown
   * transition, a hit or its end; the slow path then steps each stretch
   * once. A stretch that finishes takes over the second half of the longest
   * one left, so all of them stay busy.
   */
  private lanes(input: Uint8Array, line: number): boolean {
    for (;;) {
      const bound = this.settle(input, line)
      if (bound <= 0) return true
      if (!this.slow(input, this.fast(input, bound), bound, line)) return false
    }
  }

  /**
   * The fast loop: steps every stretch (each from its source's position and
   * state) up to `bound` bytes, stopping before the first step that is not a
   * plain move; returns how many it took, with the states reached and the
   * table values at the stop in the scratch arrays.
   */
  private fast(input: Uint8Array, bound: number): number {
    const classes = this.classes
    const table = this.table
    const pos = this.lanePos
    const state = this.laneState
    const source = this.laneSource
    const o0 = pos[source[0]]
    const o1 = pos[source[1]]
    const o2 = pos[source[2]]
    const o3 = pos[source[3]]
    const o4 = pos[source[4]]
    const o5 = pos[source[5]]
    const o6 = pos[source[6]]
    const o7 = pos[source[7]]
    let a0 = state[source[0]]
    let a1 = state[source[1]]
    let a2 = state[source[2]]
    let a3 = state[source[3]]
    let a4 = state[source[4]]
    let a5 = state[source[5]]
    let a6 = state[source[6]]
    let a7 = state[source[7]]
    let n0 = 0
    let n1 = 0
    let n2 = 0
    let n3 = 0
    let n4 = 0
    let n5 = 0
    let n6 = 0
    let n7 = 0
    let k = 0
    for (; k < bound; k++) {
      n0 = table[a0 + classes[input[o0 + k]]]
      n1 = table[a1 + classes[input[o1 + k]]]
      n2 = table[a2 + classes[input[o2 + k]]]
      n3 = table[a3 + classes[input[o3 + k]]]
      n4 = table[a4 + classes[input[o4 + k]]]
      n5 = table[a5 + classes[input[o5 + k]]]
      n6 = table[a6 + classes[input[o6 + k]]]
      n7 = table[a7 + classes[input[o7 + k]]]
      if (((n0 | n1 | n2 | n3 | n4 | n5 | n6 | n7) & ~INDEX) !== 0) break
      a0 = n0
      a1 = n1
      a2 = n2
      a3 = n3
      a4 = n4
      a5 = n5
      a6 = n6
      a7 = n7
    }
    const states = this.laneScratch
    const values = this.valueScratch
    states[0] = a0
    states[1] = a1
    states[2] = a2
    states[3] = a3
    states[4] = a4
    states[5] = a5
    states[6] = a6
    states[7] = a7
    values[0] = n0
    values[1] = n1
    values[2] = n2
    values[3] = n3
    values[4] = n4
    values[5] = n5
    values[6] = n6
    values[7] = n7
    return k
  }

  /**
   * After the fast loop took `k` of `bound` steps: moves each live stretch
   * on, through {@link advance} when it stopped early (unknown transitions
   * and hits); false if the DFA ran out of states.
   */
  private slow(input: Uint8Array, k: number, bound: number, line: number): boolean {
    const pos = this.lanePos
    const state = this.laneState
    const states = this.laneScratch
    for (let lane = 0; lane < LANES; lane++) {
      if (this.laneSource[lane] !== lane) continue
      const at = pos[lane] + k
      const next =
        k === bound
          ? states[lane]
          : this.advance(input, lane, at, this.laneEnd[lane], states[lane], this.valueScratch[lane], line)
      if (next === EXHAUSTED) return false
      state[lane] = next
      pos[lane] = k === bound ? at : this.pos
    }
    return true
  }

  /**
   * Retires the stretches that reached their end (with a match at the end
   * of the input, if their state has one there), lets each finished stretch
   * take over half of the longest one left, and points the finished ones
   * that found nothing to take at a live one. Returns how many bytes every
   * live stretch can move before one ends, or 0 when none is left.
   */
  private settle(input: Uint8Array, line: number): number {
    this.retire(input)
    const pos = this.lanePos
    const ends = this.laneEnd
    const state = this.laneState
    let live = -1
    let bound = Infinity
    for (let lane = 0; lane < LANES; lane++) {
      if (state[lane] === DONE) this.steal(input, lane, line)
      if (state[lane] === DONE) continue
      if (live < 0) live = lane
      bound = Math.min(bound, ends[lane] - pos[lane])
    }
    if (live < 0) return 0
    for (let lane = 0; lane < LANES; lane++) this.laneSource[lane] = state[lane] === DONE ? live : lane
    return bound
  }

  /** Marks the stretches that reached their end done, recording a match at the end of the input where there is one. */
  private retire(input: Uint8Array): void {
    const state = this.laneState
    for (let lane = 0; lane < LANES; lane++) {
      const a = state[lane]
      if (a === DONE || this.lanePos[lane] < this.laneEnd[lane]) continue
      if (this.laneEnd[lane] === input.length && this.matchingAtEnd[a / this.width] === true) {
        this.rangeHits[this.laneRange[lane]]?.push(input.length)
      }
      state[lane] = DONE
    }
  }

  /** Gives finished stretch `lane` the second half of the longest live one, from a line start, if it is long enough to share. */
  private steal(input: Uint8Array, lane: number, line: number): void {
    const pos = this.lanePos
    const ends = this.laneEnd
    let longest = -1
    let most = STEAL
    for (let other = 0; other < LANES; other++) {
      const left = (ends[other] ?? 0) - (pos[other] ?? 0)
      if (this.laneState[other] !== DONE && left > most) {
        longest = other
        most = left
      }
    }
    if (longest < 0) return
    const from = this.nextLine(input, (pos[longest] ?? 0) + (most >> 1))
    const end = ends[longest] ?? 0
    if (from >= end) return
    ends[longest] = from
    pos[lane] = from
    ends[lane] = end
    this.laneState[lane] = line
    this.laneRange[lane] = this.range(from)
  }

  /** Where {@link advance} left its stretch. */
  private pos = 0

  /**
   * One step of `lane` at `i` (before `e`) from state `a`, whose table value is `n`:
   * computes an unknown transition, and at a hit records it and moves to
   * the next line. Returns the new state (its position in {@link pos}),
   * {@link DONE} once the stretch has no more lines, or {@link EXHAUSTED}.
   */
  private advance(input: Uint8Array, lane: number, i: number, e: number, a: number, n: number, line: number): number {
    const b = input[i] ?? 0
    const value = n < 0 ? this.transition(a, b) : n
    if (value < 0) return EXHAUSTED
    if (value <= INDEX) {
      this.pos = i + 1
      return value
    }
    const hit = hitOffset(value, i, b === this.lineTerminator)
    this.rangeHits[this.laneRange[lane] ?? 0]?.push(hit)
    const nl = hit >= input.length ? -1 : input.indexOf(this.lineTerminator, hit)
    if (nl < 0) {
      this.pos = e
      return DONE
    }
    this.pos = Math.min(e, nl + 1)
    return line
  }

  /**
   * For a DFA made with `reverse`: every offset in the line
   * `[lineStart, lineEnd)` (and its end) where a match of the regex starts,
   * found in one pass from the end of the line back to its start, appended
   * to `out` from last to first; false if the DFA ran out of states.
   * `lineEnd` is the line's terminator, or the end of the input.
   */
  matchStarts(input: Uint8Array, lineStart: number, lineEnd: number, out: Array<number>): boolean {
    const start = this.start(true, false)
    if (start < 0) return false
    if (this.matching[start] === true) out.push(lineEnd)
    const classes = this.classes
    let table = this.table
    let at = start * this.width
    for (let i = lineEnd - 1; i >= lineStart; i--) {
      const b = input[i]
      let next = table[at + classes[b]]
      if (next < 0) {
        next = this.transition(at, b)
        if (next < 0) return false
        table = this.table
      }
      if (next > INDEX) startsAt(next, i, out)
      at = next & INDEX
    }
    if (this.matchingAtEnd[at / this.width] === true && out.at(-1) !== lineStart) out.push(lineStart)
    return true
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
