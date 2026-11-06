/**
 * Finds the next occurrence of any of a few byte strings, caching each
 * string's next occurrence so the input is scanned once per string. A
 * string with a rare byte is found by searching for that byte with
 * `Buffer#indexOf` (a vectorised memchr, many times faster than its
 * substring search) and checking the rest around it, as ripgrep's
 * rare-byte prefilter does; others with the substring search.
 *
 * @since 0.0.0
 */
import { Buffer } from "node:buffer"
import { Compiler, Input, Parser, Token } from "@thomasfosterau/effect-parse"

/**
 * A multi-literal search over one haystack at a time.
 *
 * @since 0.0.0
 */
export class LiteralFinder {
  private readonly literals: ReadonlyArray<Uint8Array>
  /** Each literal's rare byte to search for, by offset, or -1 to search for it whole. */
  private readonly anchors: ReadonlyArray<number>
  private readonly next: Float64Array
  private readonly from: Float64Array
  private haystack: Uint8Array | undefined = undefined
  private view: Buffer = Buffer.alloc(0)

  constructor(literals: ReadonlyArray<Uint8Array>) {
    this.literals = literals
    this.anchors = literals.map(rareAnchor)
    this.next = new Float64Array(literals.length)
    this.from = new Float64Array(literals.length)
  }

  private use(haystack: Uint8Array): void {
    if (this.haystack === haystack) return
    this.haystack = haystack
    this.view = Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength)
    this.from.fill(Infinity)
  }

  /** The offset of the first occurrence at or after `pos` of any literal, or -1. */
  find(haystack: Uint8Array, pos: number): number {
    this.use(haystack)
    let best = Infinity
    for (let i = 0; i < this.literals.length; i++) {
      if (!(this.from[i] <= pos && pos <= this.next[i])) {
        const at = this.search(i, pos)
        this.next[i] = at < 0 ? Infinity : at
        this.from[i] = pos
      }
      if (this.next[i] < best) best = this.next[i]
    }
    return best === Infinity ? -1 : best
  }

  /** The first occurrence of literal `i` at or after `pos`, or -1. */
  private search(i: number, pos: number): number {
    const lit = this.literals[i] ?? new Uint8Array()
    const a = this.anchors[i] ?? -1
    const view = this.view
    // A one-byte needle as a number: Buffer#indexOf's memchr path.
    if (a < 0) return lit.length === 1 ? view.indexOf(lit[0] ?? 0, pos) : view.indexOf(lit, pos)
    const n = lit.length
    const byte = lit[a]
    for (let c = view.indexOf(byte, pos + a); c >= 0; c = view.indexOf(byte, c + 1)) {
      const start = c - a
      if (start + n > view.length) return -1
      let k = 0
      while (k < n && view[start + k] === lit[k]) k++
      if (k === n) return start
    }
    return -1
  }

  /** The first literal, in priority order, that occurs at `pos`, or undefined. */
  literalAt(haystack: Uint8Array, pos: number): Uint8Array | undefined {
    outer: for (const lit of this.literals) {
      if (pos + lit.length > haystack.length) continue
      for (let k = 0; k < lit.length; k++) if (haystack[pos + k] !== lit[k]) continue outer
      return lit
    }
    return undefined
  }
}

/**
 * A rough rank of how common each byte is in text and source code, higher
 * for more common: lowercase letters by English frequency, then space and
 * newline, uppercase letters and digits, punctuation, and the rest.
 */
const frequency = (b: number): number => {
  const english = "etaoinshrdlcumwfgypbvkjxqz"
  if (b >= 0x61 && b <= 0x7a) return 100 - english.indexOf(String.fromCharCode(b)) * 3
  if (b === 0x20 || b === 0x0a) return 120
  if (b >= 0x41 && b <= 0x5a) return 30 - english.indexOf(String.fromCharCode(b + 32))
  if (b >= 0x30 && b <= 0x39) return 25
  return b < 0x80 ? 15 : 5
}

/**
 * Finds a byte-set sequence (`[sS][hH]…`): searches for the bytes of its
 * rarest position with single-byte `indexOf`, and checks the whole sequence
 * around each.
 *
 * @since 0.0.0
 */
class SequenceFinder {
  private readonly sets: ReadonlyArray<Uint8Array>
  private readonly tables: ReadonlyArray<Uint8Array>
  private readonly anchor: number
  private readonly bytes: LiteralFinder

  constructor(sets: ReadonlyArray<Uint8Array>) {
    this.sets = sets
    this.tables = sets.map((set) => {
      const t = new Uint8Array(256)
      for (const b of set) t[b] = 1
      return t
    })
    const cost = (set: Uint8Array) => set.reduce((n, b) => n + frequency(b), 0)
    let anchor = 0
    sets.forEach((set, i) => {
      if (cost(set) < cost(sets[anchor] ?? set)) anchor = i
    })
    this.anchor = anchor
    this.bytes = new LiteralFinder(Array.from(sets[anchor] ?? [], (b) => Uint8Array.of(b)))
  }

  /** The start of the first occurrence of the sequence at or after `pos`, or -1. */
  find(haystack: Uint8Array, pos: number): number {
    const n = this.sets.length
    for (let p = pos + this.anchor; ; p++) {
      p = this.bytes.find(haystack, p)
      if (p < 0) return -1
      const start = p - this.anchor
      if (start + n <= haystack.length && this.at(haystack, start)) return start
    }
  }

  private at(haystack: Uint8Array, start: number): boolean {
    for (let i = 0; i < this.tables.length; i++) if (this.tables[i]?.[haystack[start + i]] !== 1) return false
    return true
  }
}

/** Bytes at most this common (see {@link frequency}) are worth searching for alone. */
const RARE = 40

/** The offset of a literal's rarest byte, if it is rare enough to search for, else -1. */
const rareAnchor = (lit: Uint8Array): number => {
  if (lit.length < 2) return -1
  let best = 0
  for (let k = 1; k < lit.length; k++) if (frequency(lit[k] ?? 0) < frequency(lit[best] ?? 0)) best = k
  return frequency(lit[best] ?? 0) <= RARE ? best : -1
}

/**
 * What the strategies search with: the start of the first occurrence at or
 * after `pos`, or -1.
 *
 * @since 0.0.0
 */
export interface Finder {
  find(haystack: Uint8Array, pos: number): number
}

/**
 * Finds any of a few literals with an effect-parse parser,
 * `Token.takeUntilAny` repeated, compiled by `Compiler.wasm`: one parse of
 * each haystack, in WebAssembly SIMD (Teddy), lists every occurrence; the
 * searches that follow read the list.
 */
class CompiledFinder implements Finder {
  private readonly run: (state: Input.State<Uint8Array>) => ReadonlyArray<number> | Input.Fail
  private haystack: Uint8Array | undefined = undefined
  private starts: ReadonlyArray<number> = []
  private next = 0
  private last = 0

  constructor(literals: ReadonlyArray<Uint8Array>) {
    const occurrence = Parser.zipLeft(
      Parser.preceded(Token.takeUntilAny(literals), Parser.location),
      Token.anyToken<Uint8Array>()
    )
    this.run = Compiler.runner(Compiler.wasm(Parser.repeat(occurrence)), noDiagnostics)
  }

  find(haystack: Uint8Array, pos: number): number {
    if (haystack !== this.haystack) {
      this.haystack = haystack
      const starts = this.run(new Input.State(haystack))
      this.starts = starts === Input.Fail ? [] : starts
      this.next = 0
    } else if (pos < this.last) {
      this.next = 0
    }
    this.last = pos
    while (this.next < this.starts.length && (this.starts[this.next] ?? 0) < pos) this.next++
    return this.starts[this.next] ?? -1
  }
}

/**
 * Finds a byte-set sequence from the occurrences, found by a
 * {@link CompiledFinder}, of the strings three of its positions in a row
 * spell (the rarest three), each checked against the whole sequence.
 */
class CompiledSequenceFinder implements Finder {
  private readonly window: number
  private readonly sets: ReadonlyArray<Uint8Array>
  private readonly starts: CompiledFinder

  constructor(window: number, sets: ReadonlyArray<Uint8Array>, spelt: ReadonlyArray<Uint8Array>) {
    this.window = window
    this.sets = sets
    this.starts = new CompiledFinder(spelt)
  }

  find(haystack: Uint8Array, pos: number): number {
    for (let c = this.starts.find(haystack, pos + this.window); c >= 0;) {
      const start = c - this.window
      if (setsAt(haystack, start, this.sets)) return start
      c = this.starts.find(haystack, c + 1)
    }
    return -1
  }
}

const noDiagnostics: Parser.RunOptions = { diagnostics: false }

/** The most literals a compiled search takes (`Compiler.wasm` searches in JavaScript beyond this). */
const MAX_COMPILED = 64

/** How many leading positions of a sequence the compiled search spells out. */
const WINDOW = 3

const setsAt = (haystack: Uint8Array, start: number, sets: ReadonlyArray<Uint8Array>): boolean => {
  if (start + sets.length > haystack.length) return false
  for (let i = 0; i < sets.length; i++) if (sets[i]?.includes(haystack[start + i] ?? -1) !== true) return false
  return true
}

/** How common a set's bytes are together (see {@link frequency}). */
const setCost = (set: ArrayLike<number>): number => {
  let cost = 0
  for (let i = 0; i < set.length; i++) cost += frequency(set[i] ?? 0)
  return cost
}

/**
 * A finder for literals: a compiled search ({@link CompiledFinder}) for
 * several; {@link LiteralFinder} for one.
 *
 * @since 0.0.0
 */
export const literalFinder = (literals: ReadonlyArray<Uint8Array>): Finder => {
  // One literal is found by V8's native search (or a memchr on its rare byte), which a list of every occurrence does not beat
  const single = literals.length === 1
  const empty = Math.min(...literals.map((lit) => lit.length)) < 1
  // With no literals, the shortest is infinite: the compiled search finds nothing, as it should
  return single || empty || literals.length > MAX_COMPILED ? new LiteralFinder(literals) : new CompiledFinder(literals)
}

/**
 * A finder for a byte-set sequence: a compiled search for the strings its
 * three rarest positions in a row spell, unless one position's bytes are
 * rare enough for {@link SequenceFinder}'s memchr, or they spell too many.
 *
 * @since 0.0.0
 */
export const sequenceFinder = (sets: ReadonlyArray<Uint8Array>): Finder => {
  const m = Math.min(WINDOW, sets.length)
  let window = 0
  const cost = (at: number) => sets.slice(at, at + m).reduce((c, set) => c + setCost(set), 0)
  for (let w = 1; w + m <= sets.length; w++) if (cost(w) < cost(window)) window = w
  const spelt = spell(sets.slice(window, window + m))
  const rare = Math.min(...sets.map(setCost)) <= RARE
  if (rare || m === 0 || spelt.length > MAX_COMPILED) return new SequenceFinder(sets)
  return new CompiledSequenceFinder(window, sets, spelt)
}

/** Every string whose bytes are one from each set, in order; stops growing past {@link MAX_COMPILED}. */
const spell = (sets: ReadonlyArray<Uint8Array>): ReadonlyArray<Uint8Array> =>
  sets.reduce<ReadonlyArray<Uint8Array>>(
    (prefixes, set) =>
      prefixes.length > MAX_COMPILED
        ? prefixes
        : prefixes.flatMap((p) => Array.from(set, (b) => Uint8Array.of(...p, b))),
    [new Uint8Array()]
  )
